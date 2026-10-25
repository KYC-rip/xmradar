import { storage } from 'wxt/utils/storage';
import { burnInbox, createFree, fetchInbox, FreeLimitedError, isMailAddress, probeFree, type FetchFn } from './ghostmail';
import { randomSeed, solvePow } from './pow';
import type { TokenStore } from './token-store';

/** Polling window after create/import/fill (PLAN-BURNER B3). */
export const WATCH_MS = 15 * 60_000;
const SEEN_CAP = 100;

/** The active inbox, without its token. The options page may read this; the token is in the TokenStore. */
export interface BurnerInbox {
  email: string;
  expiresAt: number;
  tier: string;
  source: 'free' | 'imported';
  lastSeenIds: string[];
  watchUntil: number;
}

export const burnerInboxItem = storage.defineItem<BurnerInbox | null>('local:burnerInbox', { fallback: null });

export interface MetaStore {
  get(): Promise<BurnerInbox | null>;
  set(v: BurnerInbox | null): Promise<void>;
}

export interface BurnerDeps {
  meta: MetaStore;
  tokens: TokenStore;
  fetchFn?: FetchFn;
  now?: () => number;
  pow?: (seed: string, onProgress?: (hashes: number) => void) => Promise<string>;
}

export function limitedMessage(email: string | null): string {
  return (
    `Your network already has a free address${email ? ` (${email})` : ''} that this browser can't open. ` +
    'A new one is possible within an hour. Paid inboxes at kyc.rip/mail have no wait.'
  );
}

async function clear(d: BurnerDeps, email: string) {
  await d.tokens.delete(email);
  await d.meta.set(null);
}

/** The current inbox, or null; an expired one is removed locally (GhostMail expires it on its own). */
export async function activeInbox(d: BurnerDeps): Promise<BurnerInbox | null> {
  const m = await d.meta.get();
  if (!m) return null;
  if (m.expiresAt <= (d.now ?? Date.now)()) {
    await clear(d, m.email);
    return null;
  }
  return m;
}

async function save(d: BurnerDeps, inbox: BurnerInbox, token: string): Promise<BurnerInbox> {
  // token first: if the meta write is lost, a 429 on the next create still finds the token
  await d.tokens.set(inbox.email, token);
  await d.meta.set(inbox);
  return inbox;
}

/** 429 carries the network's active address. If this browser holds its token, carry on with it. */
async function recoverLimited(d: BurnerDeps, e: FreeLimitedError): Promise<BurnerInbox> {
  const token = e.email ? await d.tokens.get(e.email) : null;
  if (!e.email || !token) throw new Error(limitedMessage(e.email));
  const inbox = await fetchInbox(e.email, token, d.fetchFn);
  const now = (d.now ?? Date.now)();
  return save(d, { email: e.email, expiresAt: inbox.expiresAt, tier: 'FREE', source: 'free', lastSeenIds: inbox.emails.map((m) => m.id).slice(0, SEEN_CAP), watchUntil: now + WATCH_MS }, token);
}

let creating = false;

/**
 * Free 60-minute inbox. Never retried automatically: if the response is lost
 * after GhostMail created the inbox, a retry only gets a 429 without the token
 * (PLAN-BURNER CREATE-RETRY-LOSS).
 */
export async function createFreeInbox(d: BurnerDeps, onProgress?: (hashes: number) => void): Promise<BurnerInbox> {
  if (creating) throw new Error('Already getting an address');
  creating = true;
  try {
    if (await activeInbox(d)) throw new Error('You already have an active address. Burn or forget it first.');
    try {
      await probeFree(d.fetchFn);
      const seed = randomSeed();
      const nonce = await (d.pow ?? ((s, p) => solvePow(s, { onProgress: p })))(seed, onProgress);
      const created = await createFree(seed, nonce, d.fetchFn);
      return await save(d, { email: created.email, expiresAt: created.expiresAt, tier: 'FREE', source: 'free', lastSeenIds: [], watchUntil: (d.now ?? Date.now)() + WATCH_MS }, created.token);
    } catch (e) {
      if (e instanceof FreeLimitedError) return await recoverLimited(d, e);
      throw e;
    }
  } finally {
    creating = false;
  }
}

/** A paid inbox bought at kyc.rip/mail. Existing mail is marked seen so it doesn't notify. */
export async function importInbox(d: BurnerDeps, rawEmail: string, rawToken: string): Promise<BurnerInbox> {
  const email = rawEmail.trim().toLowerCase();
  const token = rawToken.trim();
  if (!isMailAddress(email)) throw new Error('That is not an email address');
  if (!token || token.length > 256) throw new Error('Paste the access token from kyc.rip/mail');
  if (await activeInbox(d)) throw new Error('You already have an active address. Burn or forget it first.');
  const inbox = await fetchInbox(email, token, d.fetchFn);
  const now = (d.now ?? Date.now)();
  if (inbox.expiresAt <= now) throw new Error('This inbox has expired');
  return save(d, { email, expiresAt: inbox.expiresAt, tier: inbox.tier, source: 'imported', lastSeenIds: inbox.emails.map((m) => m.id).slice(0, SEEN_CAP), watchUntil: now + WATCH_MS }, token);
}

/** Free inboxes only. GhostMail deletes paid tier inboxes with just the token, so imported ones are never burned from here. */
export async function burnFreeInbox(d: BurnerDeps): Promise<void> {
  const m = await activeInbox(d);
  if (!m) return;
  if (m.source !== 'free') throw new Error('Imported inboxes can only be forgotten here. Manage paid inboxes at kyc.rip/mail.');
  const token = await d.tokens.get(m.email);
  if (token) await burnInbox(m.email, token, d.fetchFn);
  await clear(d, m.email);
}

/** Imported inboxes only: removes them from XMRadar, nothing is sent to GhostMail. */
export async function forgetImportedInbox(d: BurnerDeps): Promise<void> {
  const m = await activeInbox(d);
  if (!m) return;
  if (m.source !== 'imported') throw new Error('Burn a free address instead');
  await clear(d, m.email);
}
