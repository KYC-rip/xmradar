import { sha256 } from '@noble/hashes/sha2.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { burnInbox, createFree, fetchInbox, FreeLimitedError, GhostMailError, InboxGoneError, probeFree, type FetchFn } from '../src/burner/ghostmail';
import { checkPow, leadingZeroBits, randomSeed, solvePow } from '../src/burner/pow';
import { activeInbox, burnFreeInbox, createFreeInbox, forgetImportedInbox, importInbox, WATCH_MS, type BurnerDeps, type BurnerInbox } from '../src/burner/service';
import { memoryTokenStore } from '../src/burner/token-store';

const NOW = 1_800_000_000_000;

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** A fake GhostMail: routes by method + path, records every call. */
function fakeApi(routes: Record<string, (body: Record<string, unknown>, url: URL) => [number, unknown]>) {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body });
    const route = routes[`${method} ${url.pathname}`];
    if (!route) throw new TypeError('network down');
    const [status, json] = route(body ?? {}, url);
    return new Response(JSON.stringify(json), { status });
  }) as FetchFn;
  return { fetchFn, calls };
}

function deps(fetchFn: FetchFn, start: BurnerInbox | null = null) {
  let meta = start;
  const tokens = memoryTokenStore();
  const d: BurnerDeps = {
    meta: { get: async () => meta, set: async (v) => void (meta = v) },
    tokens,
    fetchFn,
    now: () => NOW,
    pow: async () => '42',
  };
  return { d, tokens, meta: () => meta };
}

const inboxOf = (over: Partial<BurnerInbox> = {}): BurnerInbox => ({
  email: 'a1b2c3d4@ros.rip',
  expiresAt: NOW + 3_600_000,
  tier: 'FREE',
  source: 'free',
  lastSeenIds: [],
  watchUntil: NOW + WATCH_MS,
  ...over,
});

describe('pow', () => {
  it('counts leading zero bits across byte boundaries', () => {
    expect(leadingZeroBits(new Uint8Array([0xff]))).toBe(0);
    expect(leadingZeroBits(new Uint8Array([0x01]))).toBe(7);
    expect(leadingZeroBits(new Uint8Array([0x00, 0x00, 0x0f]))).toBe(20);
    expect(leadingZeroBits(new Uint8Array([0x00, 0x00, 0x10]))).toBe(19);
    expect(leadingZeroBits(new Uint8Array([0, 0]))).toBe(16);
  });

  it('matches the server rule: sha256 hex of "seed:nonce" with N leading zero bits', () => {
    // server counts zero bits over the hex digest; the byte count is the same number
    const hex = (s: string) => Array.from(sha256(new TextEncoder().encode(s)), (b) => b.toString(16).padStart(2, '0')).join('');
    const seed = 'abcdefgh12345678';
    for (let n = 0; n < 2000; n++) {
      const h = hex(`${seed}:${n}`);
      const hexBits = (() => {
        let bits = 0;
        for (const ch of h) {
          const v = parseInt(ch, 16);
          if (v === 0) {
            bits += 4;
            continue;
          }
          return bits + Math.clz32(v) - 28;
        }
        return bits;
      })();
      expect(leadingZeroBits(sha256(new TextEncoder().encode(`${seed}:${n}`)))).toBe(hexBits);
    }
  });

  it('solves a small puzzle, reports progress per chunk and yields', async () => {
    const progress: number[] = [];
    const seed = 'seedseedseedseed';
    const nonce = await solvePow(seed, { bits: 12, chunk: 500, onProgress: (h) => progress.push(h) });
    expect(checkPow(seed, nonce, 12)).toBe(true);
    expect(/^[0-9]{1,20}$/.test(nonce)).toBe(true);
    expect(progress.every((h, i) => h === (i + 1) * 500)).toBe(true);
  });

  it('gives up after the deadline', async () => {
    let t = 0;
    await expect(solvePow('x'.repeat(16), { bits: 64, chunk: 10, deadlineMs: 5, now: () => (t += 10) })).rejects.toThrow(/too long/);
  });

  it('makes seeds the server accepts', () => {
    for (let i = 0; i < 20; i++) expect(randomSeed()).toMatch(/^[A-Za-z0-9_-]{8,80}$/);
  });
});

describe('ghostmail client', () => {
  it('probe: 400 means not limited, 429 carries the active address', async () => {
    await expect(probeFree(fakeApi({ 'POST /api/free': () => [400, { error: 'Missing proof-of-work' }] }).fetchFn)).resolves.toBeUndefined();
    const err = await probeFree(fakeApi({ 'POST /api/free': () => [429, { error: 'One free inbox per hour', email: 'Dead1234@ros.rip' }] }).fetchFn).catch((e) => e);
    expect(err).toBeInstanceOf(FreeLimitedError);
    expect(err.email).toBe('dead1234@ros.rip');
  });

  it('create validates the answer', async () => {
    const ok = fakeApi({ 'POST /api/free': () => [200, { email: 'a1b2c3d4@ros.rip', token: 't-1', expiresAt: NOW, tier: 'FREE', ttl: 3600 }] });
    expect(await createFree('s', '1', ok.fetchFn)).toEqual({ email: 'a1b2c3d4@ros.rip', token: 't-1', expiresAt: NOW });
    expect(ok.calls[0]!.body).toEqual({ seed: 's', nonce: '1' });
    const bad = fakeApi({ 'POST /api/free': () => [200, { email: 'not an email', token: 't' }] });
    await expect(createFree('s', '1', bad.fetchFn)).rejects.toThrow(/unexpected/);
  });

  it('inbox: 404 and 403 are "gone", the token goes in the query as the API requires', async () => {
    const api = fakeApi({ 'GET /api/inbox': (_b, url) => (url.searchParams.get('token') === 'good' ? [200, { emails: [{ id: 'm1' }], expiresAt: NOW, tier: 'BASIC' }] : [403, { error: 'Invalid token' }]) });
    expect((await fetchInbox('a@vigilbox.xyz', 'good', api.fetchFn)).emails).toHaveLength(1);
    await expect(fetchInbox('a@vigilbox.xyz', 'bad', api.fetchFn)).rejects.toBeInstanceOf(InboxGoneError);
    await expect(fetchInbox('a@vigilbox.xyz', 'x', fakeApi({ 'GET /api/inbox': () => [404, {}] }).fetchFn)).rejects.toBeInstanceOf(InboxGoneError);
  });

  it('burn treats 404 as done; network errors are a GhostMailError', async () => {
    await expect(burnInbox('a@ros.rip', 't', fakeApi({ 'POST /api/inbox/burn': () => [404, {}] }).fetchFn)).resolves.toBeUndefined();
    await expect(burnInbox('a@ros.rip', 't', fakeApi({}).fetchFn)).rejects.toBeInstanceOf(GhostMailError);
  });
});

describe('burner service', () => {
  let freeCalls = 0;
  beforeEach(() => (freeCalls = 0));

  it('creates: probe first, then mine, then save token and token-free meta', async () => {
    const api = fakeApi({
      'POST /api/free': (b) => {
        freeCalls++;
        return b.seed ? [200, { email: 'a1b2c3d4@ros.rip', token: 'tok', expiresAt: NOW + 3_600_000 }] : [400, {}];
      },
    });
    const { d, tokens, meta } = deps(api.fetchFn);
    const inbox = await createFreeInbox(d);
    expect(freeCalls).toBe(2);
    expect(inbox).toEqual(inboxOf());
    expect(tokens.map.get('a1b2c3d4@ros.rip')).toBe('tok');
    expect(JSON.stringify(meta())).not.toContain('tok');
  });

  it('a limited network skips mining and says so, without retrying', async () => {
    let mined = false;
    const api = fakeApi({ 'POST /api/free': () => [429, { email: 'dead1234@ros.rip' }] });
    const { d } = deps(api.fetchFn);
    d.pow = async () => ((mined = true), '1');
    await expect(createFreeInbox(d)).rejects.toThrow(/already has a free address \(dead1234@ros\.rip\).*within an hour/);
    expect(mined).toBe(false);
    expect(api.calls).toHaveLength(1);
  });

  it('a 429 for an address whose token this browser holds carries on with it', async () => {
    const api = fakeApi({
      'POST /api/free': () => [429, { email: 'a1b2c3d4@ros.rip' }],
      'GET /api/inbox': () => [200, { emails: [{ id: 'old' }], expiresAt: NOW + 1000, tier: 'BASIC' }],
    });
    const { d, tokens } = deps(api.fetchFn);
    await tokens.set('a1b2c3d4@ros.rip', 'kept');
    const inbox = await createFreeInbox(d);
    expect(inbox.email).toBe('a1b2c3d4@ros.rip');
    expect(inbox.lastSeenIds).toEqual(['old']);
  });

  it('a lost create response is not retried', async () => {
    let mined = 0;
    const api = fakeApi({ 'POST /api/free': (b) => (b.seed ? (() => { throw new TypeError('reset'); })() : [400, {}]) });
    const { d } = deps(api.fetchFn);
    d.pow = async () => (mined++, '1');
    await expect(createFreeInbox(d)).rejects.toThrow(/Couldn't reach/);
    expect(mined).toBe(1);
    expect(api.calls.filter((c) => (c.body as { seed?: string })?.seed)).toHaveLength(1);
  });

  it('one inbox at a time; an expired one is dropped locally', async () => {
    const api = fakeApi({ 'POST /api/free': () => [400, {}] });
    const { d } = deps(api.fetchFn, inboxOf());
    await expect(createFreeInbox(d)).rejects.toThrow(/already have an active address/);
    const expired = deps(api.fetchFn, inboxOf({ expiresAt: NOW - 1 }));
    await expired.tokens.set('a1b2c3d4@ros.rip', 'tok');
    expect(await activeInbox(expired.d)).toBeNull();
    expect(expired.meta()).toBeNull();
    expect(expired.tokens.map.size).toBe(0);
  });

  it('import checks the inbox, seeds seen ids so old mail stays quiet, and keeps the token out of meta', async () => {
    const api = fakeApi({ 'GET /api/inbox': () => [200, { emails: [{ id: 'm1' }, { id: 'm2' }], expiresAt: NOW + 86_400_000, tier: 'PREMIUM' }] });
    const { d, tokens, meta } = deps(api.fetchFn);
    await importInbox(d, ' Me@VigilPro.xyz ', ' secret ');
    expect(meta()).toMatchObject({ email: 'me@vigilpro.xyz', source: 'imported', tier: 'PREMIUM', lastSeenIds: ['m1', 'm2'] });
    expect(tokens.map.get('me@vigilpro.xyz')).toBe('secret');
    expect(JSON.stringify(meta())).not.toContain('secret');
  });

  it('import rejects a wrong token and bad input', async () => {
    const api = fakeApi({ 'GET /api/inbox': () => [403, {}] });
    const { d, meta } = deps(api.fetchFn);
    await expect(importInbox(d, 'me@vigilpro.xyz', 'nope')).rejects.toThrow(/token .* wrong/);
    await expect(importInbox(d, 'not-an-email', 'x')).rejects.toThrow(/not an email/);
    expect(meta()).toBeNull();
  });

  it('burn calls GhostMail for free inboxes; imported (paid) inboxes are never burned', async () => {
    const api = fakeApi({ 'POST /api/inbox/burn': () => [200, { success: true }] });
    const free = deps(api.fetchFn, inboxOf());
    await free.tokens.set('a1b2c3d4@ros.rip', 'tok');
    await burnFreeInbox(free.d);
    expect(api.calls).toEqual([{ method: 'POST', path: '/api/inbox/burn', body: { email: 'a1b2c3d4@ros.rip', token: 'tok' } }]);
    expect(free.meta()).toBeNull();

    const paid = deps(api.fetchFn, inboxOf({ source: 'imported', email: 'me@vigilpro.xyz' }));
    await paid.tokens.set('me@vigilpro.xyz', 'tok');
    await expect(burnFreeInbox(paid.d)).rejects.toThrow(/can only be forgotten/);
    expect(api.calls).toHaveLength(1);
  });

  it('forget removes an imported inbox without any network call', async () => {
    const api = fakeApi({});
    const paid = deps(api.fetchFn, inboxOf({ source: 'imported', email: 'me@vigilpro.xyz' }));
    await paid.tokens.set('me@vigilpro.xyz', 'tok');
    await forgetImportedInbox(paid.d);
    expect(paid.meta()).toBeNull();
    expect(paid.tokens.map.size).toBe(0);
    expect(api.calls).toHaveLength(0);
    await expect(forgetImportedInbox(deps(api.fetchFn, inboxOf()).d)).rejects.toThrow(/Burn/);
  });
});
