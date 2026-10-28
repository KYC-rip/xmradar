import type { Event, EventTemplate } from 'nostr-tools/pure';
import type { RelayResult, XapPublishResult, XapTotals } from '../messaging';
import { DEFAULT_RELAYS, withoutIndex } from '../settings';
import { validateMoneroAddress } from '../xmr/address';
import { formatXmr, parseXmr } from './amount';
import { countXaps } from './count';
import { isHex64, receiptTemplate } from './events';
import { fetchPostEvents, fetchProfiles, fetchXapEvents, type XapQuery } from './fetch';
import { postKey, STATUS_ID_RE, xPostId } from './post';

export interface SentXap {
  receiptId: string;
  recipient: string;
  amount: string;
  address: string;
  at: number;
}
export const MAX_SENT = 200;
export const MAX_PUBLISH_RELAYS = 10;
/** popups opened again within this window share one relay fetch */
export const FRESH_REUSE_MS = 15_000;

export interface XapDeps {
  query: XapQuery;
  /** where profiles and receipts are looked up: defaults, index relays and the user's relays */
  lookupRelays: () => Promise<string[]>;
  me: () => Promise<{ pubkey: string | null; sent: SentXap[] }>;
  now?: () => number;
}

const CONCURRENCY = 4;

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Fresh totals for each recipient: current address, receipts, confirmations and deletions from relays. */
export async function countFor(recipients: string[], deps: XapDeps): Promise<Map<string, XapTotals>> {
  const now = (deps.now ?? Date.now)();
  const lookup = await deps.lookupRelays();
  const [profiles, me] = await Promise.all([fetchProfiles(recipients, lookup, deps.query), deps.me()]);
  const sent = new Set(me.sent.map((s) => s.receiptId));
  const out = new Map<string, XapTotals>();
  await mapLimit(recipients, CONCURRENCY, async (pk) => {
    // NIP-65 outbox/inbox: the recipient's own relays are where their confirmations and tips land
    const relays = [...new Set([...lookup, ...(profiles.relays.get(pk) ?? [])])];
    const address = profiles.addresses.get(pk) ?? null;
    const events = await fetchXapEvents(pk, relays, deps.query);
    const c = countXaps({ recipient: pk, events, current: address ? [address] : [], me: { pubkey: me.pubkey, sent }, now: Math.floor(now / 1000) });
    out.set(pk, totalsOf(c, address, now));
  });
  return out;
}

const totalsOf = (c: ReturnType<typeof countXaps>, address: string | null, now: number): XapTotals => ({
  verified: formatXmr(c.verified),
  verifiedTippers: c.verifiedTippers,
  verifying: formatXmr(c.verifying),
  claimed: formatXmr(c.claimed),
  claimedTippers: c.claimedTippers,
  address,
  mine: c.mine.map((m) => ({ amount: formatXmr(m.amount), state: m.state, recorded: m.recorded })),
  at: now,
});

export interface PostRef {
  /** X status id */
  id: string;
  /** the key the post's author proves (R14): only receipts to it count toward the post */
  pubkey: string;
}

/** Each post's figure, keyed by postKey(pubkey, id): only receipts naming the post and paid to its bound key. */
export async function countPosts(posts: PostRef[], deps: XapDeps): Promise<Map<string, XapTotals>> {
  const now = (deps.now ?? Date.now)();
  const lookup = await deps.lookupRelays();
  const pubkeys = [...new Set(posts.map((p) => p.pubkey))];
  const [profiles, me] = await Promise.all([fetchProfiles(pubkeys, lookup, deps.query), deps.me()]);
  const sent = new Set(me.sent.map((s) => s.receiptId));
  const out = new Map<string, XapTotals>();
  await mapLimit(posts, CONCURRENCY, async ({ id, pubkey }) => {
    const relays = [...new Set([...lookup, ...(profiles.relays.get(pubkey) ?? [])])];
    const address = profiles.addresses.get(pubkey) ?? null;
    const post = xPostId(id);
    const events = await fetchPostEvents(post, pubkey, relays, deps.query);
    const c = countXaps({ recipient: pubkey, events, current: address ? [address] : [], me: { pubkey: me.pubkey, sent }, now: Math.floor(now / 1000), post });
    out.set(postKey(pubkey, id), totalsOf(c, address, now));
  });
  return out;
}

/** Valid, distinct post refs, at most `max`; anything malformed is dropped. */
export function validPosts(posts: unknown, max: number): PostRef[] {
  if (!Array.isArray(posts)) return [];
  const seen = new Map<string, PostRef>();
  // malformed entries don't use up the cap; the scan itself is bounded
  for (const p of posts.slice(0, 1000) as { id?: unknown; pubkey?: unknown }[]) {
    if (seen.size >= max) break;
    if (typeof p?.id !== 'string' || !STATUS_ID_RE.test(p.id) || !isHex64(p.pubkey)) continue;
    seen.set(postKey(p.pubkey, p.id), { id: p.id, pubkey: p.pubkey });
  }
  return [...seen.values()];
}

/**
 * Fresh totals for popups: concurrent and repeated asks for one recipient share a single relay
 * fetch, or reuse one younger than 15 s. Older results are never handed out as fresh.
 */
export class FreshTotals {
  private inflight = new Map<string, Promise<XapTotals>>();
  private recent = new Map<string, XapTotals>();

  constructor(private fetchOne: (pk: string) => Promise<XapTotals>, private now: () => number = Date.now) {}

  get(pk: string): Promise<XapTotals> {
    const hit = this.recent.get(pk);
    if (hit && this.now() - hit.at < FRESH_REUSE_MS) return Promise.resolve(hit);
    let p = this.inflight.get(pk);
    if (!p) {
      p = this.fetchOne(pk).then(
        (t) => {
          this.inflight.delete(pk);
          this.recent.set(pk, t);
          return t;
        },
        (e) => {
          this.inflight.delete(pk);
          throw e;
        },
      );
      this.inflight.set(pk, p);
    }
    return p;
  }

  /** after a publish, the next ask must go to the relays */
  forget(pk: string) {
    this.recent.delete(pk);
  }
}

export interface PublishDeps {
  query: XapQuery;
  lookupRelays: () => Promise<string[]>;
  /** the user's write relays */
  myRelays: (pubkey: string) => Promise<string[]>;
  pubkey: () => Promise<string | null>;
  sign: (template: EventTemplate, pubkey: string) => Promise<Event>;
  publish: (relays: string[], event: Event) => Promise<RelayResult[]>;
  record: (sent: SentXap) => Promise<void>;
  now?: () => number;
}

export interface PublishRequest {
  recipient: unknown;
  address: unknown;
  amount: unknown;
  /** X status id: the receipt names that post (R15); absent for a profile tip */
  post?: unknown;
}

/** Signs and publishes a receipt for a tip the user confirmed sending (R8 is asked in the popup). */
export async function publishXap(req: PublishRequest, deps: PublishDeps): Promise<XapPublishResult> {
  const { recipient, address, amount, post } = req;
  if (!isHex64(recipient)) throw new Error('Bad recipient key');
  if (post !== undefined && (typeof post !== 'string' || !STATUS_ID_RE.test(post))) throw new Error('Bad post');
  if (typeof address !== 'string') throw new Error('Bad address');
  const check = validateMoneroAddress(address);
  if (!check.ok || check.type === 'integrated') throw new Error('Xaps go to a standard address or subaddress');
  if (typeof amount !== 'string' || parseXmr(amount) === null) throw new Error('Bad amount');
  const pubkey = await deps.pubkey();
  if (!pubkey) throw new Error('Connect your signer in XMRadar’s options first');
  if (pubkey === recipient) throw new Error("Your signer holds this account's own key, so the receipt would say it tipped itself. Switch your signer to the key you tip from (for example in another browser profile).");
  // R10 at write time: never from a cache
  const lookup = await deps.lookupRelays();
  const profiles = await fetchProfiles([recipient], lookup, deps.query);
  if (profiles.addresses.get(recipient) !== address) throw new Error('ADDRESS_CHANGED');
  const template = receiptTemplate({ recipient, amount, address, post, now: Math.floor((deps.now ?? Date.now)() / 1000) });
  const event = await deps.sign(template, pubkey);
  const relays = [...new Set([...withoutIndex(await deps.myRelays(pubkey)), ...withoutIndex(profiles.relays.get(recipient) ?? []), ...DEFAULT_RELAYS])].slice(0, MAX_PUBLISH_RELAYS);
  const results = await deps.publish(relays, event);
  if (results.some((r) => r.ok)) {
    // losing the record only loses the "verifying" state for this receipt
    await deps.record({ receiptId: event.id, recipient, amount, address, at: (deps.now ?? Date.now)() }).catch((e) => console.warn('[XMRadar] xap record', e));
  }
  return { results, id: event.id };
}

export const withSent = (list: SentXap[], s: SentXap) => [...list.filter((x) => x.receiptId !== s.receiptId), s].slice(-MAX_SENT);
