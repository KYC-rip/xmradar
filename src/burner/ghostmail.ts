/** Client for kyc.rip GhostMail (kyc-rip/mail). Used by the background only: it carries the inbox token. */

export const GHOSTMAIL_API = 'https://mail-api.kyc.rip';
const TIMEOUT_MS = 15_000;
const EMAIL_RE = /^[a-z0-9._+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,}$/;

export type FetchFn = typeof fetch;

export class GhostMailError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** The network already has a free inbox; GhostMail returns its address, never its token. */
export class FreeLimitedError extends GhostMailError {
  constructor(readonly email: string | null) {
    super('A free address already exists for this network', 429);
  }
}

/** 404 (expired or burned) or 403 (wrong token): the inbox can't be used any more. */
export class InboxGoneError extends GhostMailError {}

export interface FreeInbox {
  email: string;
  token: string;
  expiresAt: number;
}

export interface InboxMail {
  id: string;
  from: string;
  fromName: string;
  subject: string;
  text: string;
  html?: string;
  receivedAt: string;
  isEncrypted?: boolean;
}

export interface Inbox {
  tier: string;
  expiresAt: number;
  emails: InboxMail[];
}

export const isMailAddress = (s: string) => EMAIL_RE.test(s);

async function call(fetchFn: FetchFn, path: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetchFn(`${GHOSTMAIL_API}${path}`, { ...init, credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new GhostMailError("Couldn't reach kyc.rip GhostMail. Check your connection.", 0);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body: body && typeof body === 'object' ? body : {} };
}

const post = (fetchFn: FetchFn, path: string, data: unknown) =>
  call(fetchFn, path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

const limitedEmail = (body: Record<string, unknown>) => {
  const e = typeof body.email === 'string' ? body.email.toLowerCase() : '';
  return isMailAddress(e) ? e : null;
};

/**
 * GhostMail checks the per-IP limit before the proof of work, so an empty
 * request tells us whether mining is worth it: 429 = limited, 400 = go ahead.
 */
export async function probeFree(fetchFn: FetchFn = fetch): Promise<void> {
  const { status, body } = await post(fetchFn, '/api/free', {});
  if (status === 429) throw new FreeLimitedError(limitedEmail(body));
  if (status !== 400) throw new GhostMailError(`GhostMail answered ${status}`, status);
}

export async function createFree(seed: string, nonce: string, fetchFn: FetchFn = fetch): Promise<FreeInbox> {
  const { status, body } = await post(fetchFn, '/api/free', { seed, nonce });
  if (status === 429) throw new FreeLimitedError(limitedEmail(body));
  if (status !== 200) throw new GhostMailError(typeof body.error === 'string' ? body.error.slice(0, 200) : `GhostMail answered ${status}`, status);
  const email = typeof body.email === 'string' ? body.email.toLowerCase() : '';
  const { token, expiresAt } = body;
  if (!isMailAddress(email) || typeof token !== 'string' || !token || token.length > 256 || typeof expiresAt !== 'number') {
    throw new GhostMailError('GhostMail sent an unexpected answer', status);
  }
  return { email, token, expiresAt };
}

export async function fetchInbox(email: string, token: string, fetchFn: FetchFn = fetch): Promise<Inbox> {
  const q = new URLSearchParams({ email, token });
  const { status, body } = await call(fetchFn, `/api/inbox?${q}`);
  if (status === 404) throw new InboxGoneError('This inbox has expired or was burned', status);
  if (status === 403 || status === 401) throw new InboxGoneError('The token for this inbox is wrong', status);
  if (status !== 200) throw new GhostMailError(`GhostMail answered ${status}`, status);
  if (!Array.isArray(body.emails) || typeof body.expiresAt !== 'number') throw new GhostMailError('GhostMail sent an unexpected answer', status);
  const emails = (body.emails as unknown[]).filter((m): m is InboxMail => !!m && typeof (m as InboxMail).id === 'string');
  return { tier: typeof body.tier === 'string' ? body.tier : 'UNKNOWN', expiresAt: body.expiresAt, emails };
}

export async function burnInbox(email: string, token: string, fetchFn: FetchFn = fetch): Promise<void> {
  const { status } = await post(fetchFn, '/api/inbox/burn', { email, token });
  // already gone is fine: the goal is that it no longer exists
  if (status !== 200 && status !== 404) throw new GhostMailError(`Burn failed (${status})`, status);
}
