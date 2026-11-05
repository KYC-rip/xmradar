import type { EventTemplate } from 'nostr-tools/pure';

/**
 * "Also list me on xmr.bio" (PLAN-XMRBIOLIST): a Nostr-linked X account listed on xmr.bio's public directory,
 * so its badge shows for every XMRadar user and its xos count. The key signs a kind-27235 event naming the
 * handle, the address and the proof tweet; xmr.bio checks it against the account's own proof tweet.
 */

export const XMRBIO_REGISTER_URL = 'https://api.kyc.rip/v1/bio/register/nostr';
export const REGISTER_KIND = 27235;

export const registerContent = (handle: string, address: string) => `xmr.bio:${handle} list ${address}`;

/** The one event this feature signs (the XMRadar identity signs kind 27235 only through this). */
export function registerTemplate(handle: string, address: string, tweetId: string, nowSecs: number): EventTemplate {
  return { kind: REGISTER_KIND, created_at: nowSecs, content: registerContent(handle, address), tags: [['i', `twitter:${handle}`, tweetId]] };
}

/** `exists`: someone's profile is there (listed); `exists-unlisted`: there, but hidden from the directory */
export type ListStatus = 'listed' | 'exists' | 'exists-unlisted' | 'failed';
export interface ListRecord {
  status: ListStatus;
  at: number;
  error?: string;
}
/** one entry per handle + key + address: each combination is sent at most once on its own */
export type ListRecords = Record<string, ListRecord>;
export const listKey = (handle: string, pubkey: string, address: string) => `${handle.toLowerCase()}|${pubkey}|${address}`;

export const tweetIdOf = (url: string) => /\/status\/(\d{1,20})(?:[/?#]|$)/.exec(url)?.[1] ?? null;

/** What xmr.bio's answer means for the record. */
export function listOutcome(status: number, body: { success?: boolean; error?: unknown; reason?: unknown; already?: boolean } | null): ListRecord & { at: 0 } {
  if (status === 200 && body?.success) return { status: 'listed', at: 0 };
  if (status === 409) return { status: body?.reason === 'exists-unlisted' ? 'exists-unlisted' : 'exists', at: 0 };
  const said = typeof body?.error === 'string' ? body.error.replace(/\s+/g, ' ').slice(0, 200) : `HTTP ${status}`;
  return { status: 'failed', at: 0, error: said };
}

/** A last try this recent still describes xmr.bio; an older one may be out of date (unlisted, deleted since). */
export const RECENT_MS = 10 * 60_000;

/**
 * The button's answer. xmr.bio's current answer comes first; the last try only fills in what that can't say
 * (a listing so new XMRadar's directory copy doesn't have it yet, a 409, the error).
 */
export function listButtonText(
  st: {
    xmrbio: { found: false } | { found: true; linked: boolean; listed?: boolean } | { found: 'error'; reason: string } | null;
    listing?: { status: ListStatus; at: number; error?: string } | null;
    link: { proof: { status: string } } | null;
    address: { check: { ok: boolean; type?: string } } | null;
  },
  handle: string,
  now = Date.now(),
): string {
  const b = st.xmrbio;
  const l = st.listing ?? null;
  const recent = !!l && now - l.at < RECENT_MS;
  const listedNow = l?.status === 'listed' && recent;
  if (b?.found === true) {
    // another key's profile is never "Listed" for this one, however recent the last try
    if (!b.linked) return 'Already on xmr.bio, with another key; manage it there.';
    if (b.listed === false)
      return listedNow
        ? `Listed: xmr.bio/${handle}. XMRadar shows the badge after its next directory download.`
        : 'On xmr.bio, but not in the directory XMRadar holds (unlisted, or listed since its last download); manage it there.';
    const where = b.listed ? 'Its badge shows for every XMRadar user.' : 'XMRadar shows the badge once it holds the directory.';
    return `${listedNow ? `Listed: xmr.bio/${handle}.` : 'Already on xmr.bio, linked to this key.'} ${where}`;
  }
  if (l?.status === 'failed' && b?.found !== false) return `Not listed: ${l.error ?? 'unknown error'}`;
  if (recent && l) {
    // xmr.bio just answered this; /resolve may not show it yet
    if (l.status === 'listed') return `Listed: xmr.bio/${handle}. It may take a moment to show there.`;
    if (l.status === 'exists') return 'Already on xmr.bio; manage it there.';
    if (l.status === 'exists-unlisted') return 'Already on xmr.bio but unlisted; list it again there (Sign in with Monero).';
  }
  if (st.link?.proof.status !== 'verified') return 'Link your X account first (step 4).';
  if (!st.address?.check.ok || st.address.check.type === 'integrated') return 'Publish a Monero standard address or subaddress first (step 3).';
  if (b?.found === 'error') return `Couldn't reach xmr.bio (${b.reason}).`;
  if (l?.status === 'failed') return `Not listed: ${l.error ?? 'unknown error'}`;
  // an older listing or 409 that xmr.bio no longer shows: deleted there since
  if (l) return `xmr.bio doesn't have @${handle} now (deleted there?). Press again to list it.`;
  return 'Not listed.';
}

/** What to send, if anything: the rules of when XMRadar lists on its own and when only the button does. */
export function listPlan(
  st: {
    pubkey: string;
    address: { address: string; check: { ok: boolean; type?: string } } | null;
    link: { tweetUrl: string; proof: { status: string } } | null;
    xmrbio: { found: boolean | 'error' } | null;
  },
  handle: string,
  opts: { explicit: boolean; pref: 'on' | 'off'; records: ListRecords },
): { send: false; had: ListRecord | null } | { send: true; key: string; handle: string; address: string; tweetId: string } {
  const addr = st.address;
  const key = addr ? listKey(handle, st.pubkey, addr.address) : null;
  const had = key ? (opts.records[key] ?? null) : null;
  const tweetId = st.link ? tweetIdOf(st.link.tweetUrl) : null;
  // the button also tries when xmr.bio couldn't be asked: the server refuses an existing profile
  const unknown = st.xmrbio?.found === false || (opts.explicit && st.xmrbio?.found === 'error');
  const ready = !!addr?.check.ok && addr.check.type !== 'integrated' && st.link?.proof.status === 'verified' && unknown && !!tweetId;
  if (!ready || !key || !tweetId || !addr) return { send: false, had };
  if (!opts.explicit && (opts.pref === 'off' || had)) return { send: false, had };
  return { send: true, key, handle: handle.toLowerCase(), address: addr.address, tweetId };
}
