import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it, vi } from 'vitest';
import { DIRECTORY_ALARM, DIRECTORY_RETRY_ALARM, directoryIndex, directoryKeeper, DIRECTORY_URL, DirectoryTrustError, fetchDirectory, readDirectory } from '../src/identity/directory';
import { mergeBadge, resolveHandles } from '../src/identity/resolve';
import { directoryText } from '../src/ui/xmr-toggles';

const sk = ed25519.utils.randomSecretKey();
const KEY = bytesToHex(ed25519.getPublicKey(sk));
const KEYS = new Set([KEY]);
const A = '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';
const B = '888tNkZrPN6JsEgekjMnABU4TBzc2Dt29EPAvkRxbANsAnjyPbb3iQ1YBRk1UXcdRsiKc9dhwMVgN5S9cQUiyoogDavup3H';
const NOW = Date.parse('2026-11-03T12:00:00Z');

const sign = (payload: object, key = sk) => {
  const text = JSON.stringify(payload);
  return { payload: text, signature: bytesToHex(ed25519.sign(new TextEncoder().encode(text), key)), public_key: bytesToHex(ed25519.getPublicKey(key)), alg: 'ed25519' };
};
// as K1 ships it (kyc-rip api/src/libs/bio/directory.ts)
const dir = (generated: string, entries: object[]) => sign({ v: 1, service: 'xmr.bio', generated_at: generated, count: entries.length, entries });
const entry = (handle: string, address = A) => ({ handle, address, verified_at: '2025-12-23T14:12:18.787Z' });

describe('xmr.bio directory (2d)', () => {
  it('reads a signed directory; drops entries it can’t use; ignores fields from later steps', () => {
    const d = readDirectory(
      dir('2026-11-03T11:50:00.000Z', [
        { ...entry('franz_fk19', B), address_updated_at: '2026-11-01T00:00:00Z', x_proof: { method: 'grok' } },
        entry('xbtoshi'),
        entry('Upper'),
        entry('agent-x'),
        entry('badaddr', A.slice(0, -1) + 'B'),
        { ...entry('baddate'), verified_at: 'yesterday' },
        entry('xbtoshi', B),
        { handle: 'nofields' },
      ]),
      null,
      { now: NOW, keys: KEYS },
    )!;
    expect(d.entries.map((e) => e.handle)).toEqual(['franz_fk19', 'xbtoshi']);
    expect(d).toMatchObject({ generatedAt: Date.parse('2026-11-03T11:50:00Z'), keyId: KEY, stale: false });
  });
  it('a tampered payload, an unknown key or another payload kind is refused', () => {
    const good = dir('2026-11-03T11:50:00Z', [entry('xbtoshi')]);
    expect(() => readDirectory({ ...good, payload: good.payload.replace('xbtoshi', 'xbtoshj') }, null, { now: NOW, keys: KEYS })).toThrow('Bad signature');
    expect(() => readDirectory(dir('2026-11-03T11:50:00Z', [], ), null, { now: NOW })).toThrow('unknown key');
    expect(() => readDirectory(sign({ v: 2, service: 'xmr.bio', handle: 'x' }), null, { now: NOW, keys: KEYS })).toThrow('Unsupported');
  });
  it('an older or same build is ignored without error, in either arrival order (K1 consistency window)', () => {
    const newer = readDirectory(dir('2026-11-03T11:50:00Z', [entry('xbtoshi')]), null, { now: NOW, keys: KEYS })!;
    expect(readDirectory(dir('2026-11-03T11:40:00Z', [entry('xbtoshi', B)]), newer, { now: NOW, keys: KEYS })).toBeNull();
    expect(readDirectory(dir('2026-11-03T11:50:00Z', [entry('xbtoshi', B)]), newer, { now: NOW, keys: KEYS })).toBeNull();
    expect(readDirectory(dir('2026-11-03T11:55:00Z', [entry('xbtoshi', B)]), newer, { now: NOW, keys: KEYS })!.entries[0]!.address).toBe(B);
  });
  it('more than 10 minutes in the future is a trust event (DIR-1); a few minutes of clock skew is fine', () => {
    expect(() => readDirectory(dir('2026-11-03T12:11:00Z', []), null, { now: NOW, keys: KEYS })).toThrow(DirectoryTrustError);
    expect(readDirectory(dir('2026-11-03T12:05:00Z', []), null, { now: NOW, keys: KEYS })).not.toBeNull();
  });
  it('kept as plain JSON and looked up by handle in any case; xmr.bio is the primary source', () => {
    const d = readDirectory(dir('2026-11-03T11:50:00Z', [entry('franz_fk19', B)]), null, { now: NOW, keys: KEYS })!;
    const lookup = directoryIndex(JSON.parse(JSON.stringify(d)));
    expect(lookup('Franz_FK19')).toMatchObject([{ source: 'xmrbio', address: B, verified: true, method: 'xmrbio:directory' }]);
    expect(lookup('someone')).toEqual([]);
    expect(directoryIndex(null)('franz_fk19')).toEqual([]);
    const nostr = { source: 'nostr' as const, address: A, check: { ok: true as const, type: 'standard' as const }, verified: true, method: 'nip39:client', createdAt: 1 };
    const badge = mergeBadge('franz_fk19', [...lookup('franz_fk19'), nostr]);
    expect(badge.primary?.source).toBe('xmrbio');
    expect(badge.differ).toBe(true);
  });
  it('badges from the directory alone make no request (privacy, §2.1)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const d = readDirectory(dir('2026-11-03T11:50:00Z', [entry('franz_fk19', B)]), null, { now: NOW, keys: KEYS })!;
    const out = await resolveHandles(['franz_fk19', 'nobody'], { discovery: false, relays: [], verify: async () => ({ status: 'error', reason: 'x' }), directory: directoryIndex(d) });
    expect(out.get('franz_fk19')!.primary?.address).toBe(B);
    expect(out.get('nobody')!.primary).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('downloading it', () => {
  const read = async (res: Response, max: number) => {
    const b = new Uint8Array(await res.arrayBuffer());
    if (b.length > max) throw new Error('Response too large');
    return b;
  };
  const reply = (status: number, body = '', headers: Record<string, string> = { 'content-type': 'application/json' }) => vi.fn(async () => new Response(status === 204 ? null : body, { status, headers }));
  it('asks once, without cookies, referrer or redirects', async () => {
    const f = reply(200, '{}');
    await fetchDirectory(f as unknown as typeof fetch, read);
    expect(f).toHaveBeenCalledWith(DIRECTORY_URL, expect.objectContaining({ credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store' }));
  });
  it('404: not published yet; 503: none to give, keep ours; the stale header is passed on', async () => {
    expect(await fetchDirectory(reply(404) as unknown as typeof fetch, read)).toEqual({ kind: 'not-live' });
    expect(await fetchDirectory(reply(503) as unknown as typeof fetch, read)).toEqual({ kind: 'unavailable', status: 503 });
    expect(await fetchDirectory(reply(200, '{"a":1}', { 'content-type': 'application/json; charset=utf-8', 'x-directory-stale': '1' }) as unknown as typeof fetch, read)).toEqual({ kind: 'ok', envelope: { a: 1 }, stale: true });
  });
  it('refuses a body that isn’t JSON', async () => {
    await expect(fetchDirectory(reply(200, '<html>', { 'content-type': 'text/html' }) as unknown as typeof fetch, read)).rejects.toThrow('not JSON');
  });
});

describe('the Options line', () => {
  const at = Date.parse('2026-11-03T11:50:00Z');
  it('says what is held, and why an update failed', () => {
    expect(directoryText(null, true)).toBe('');
    expect(directoryText({ state: 'ok', at, count: 3, generatedAt: at }, false)).toBe('');
    expect(directoryText({ state: 'ok', at, count: 1234, generatedAt: at }, true)).toMatch(/^xmr\.bio directory: 1,234 profiles, built /);
    expect(directoryText({ state: 'ok', at, count: 3, generatedAt: at, stale: true }, true)).toMatch(/may be out of date/);
    expect(directoryText({ state: 'not-live', at }, true)).toBe('xmr.bio directory: not published yet');
    expect(directoryText({ state: 'trust', at, message: 'Directory is dated in the future' }, true)).toBe('xmr.bio directory refused (Directory is dated in the future). No xmr.bio badges until a good one arrives.');
    expect(directoryText({ state: 'error', at, count: 3, generatedAt: at, message: 'HTTP 500' }, true)).toMatch(/the last update failed \(HTTP 500\)$/);
  });
});

describe('keeping it (background lifecycle)', () => {
  const item = <T>(v: T) => {
    let value = v;
    return { getValue: vi.fn(async () => value), setValue: vi.fn(async (n: T) => void (value = n)), removeValue: vi.fn(async () => void (value = null as T)), peek: () => value };
  };
  const body = async (res: Response) => new Uint8Array(await res.arrayBuffer());
  const json = (env: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(env), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
  function keeper(responses: (() => Promise<Response>)[], opts: { on?: boolean; now?: number } = {}) {
    const held = item<import('../src/identity/directory').StoredDirectory | null>(null);
    const status = item<import('../src/identity/directory').DirectoryStatus | null>(null);
    const alarms = { create: vi.fn(async () => {}), clear: vi.fn(async () => true) };
    const changed = vi.fn();
    const state = { on: opts.on ?? true, now: opts.now ?? NOW };
    const fetchFn = vi.fn(async () => (responses.shift() ?? (async () => new Response(null, { status: 404 })))());
    const k = directoryKeeper({ held, status, alarms, changed, fetch: fetchFn as unknown as typeof fetch, readBody: body, enabled: async () => state.on, now: () => state.now, keys: KEYS });
    return { k, held, status, alarms, changed, fetchFn, state };
  }

  it('404 → not published, retried in an hour; then a build arrives, is used, and tabs are told', async () => {
    const t = keeper([async () => new Response(null, { status: 404 }), async () => json(dir('2026-11-03T11:50:00Z', [entry('franz_fk19', B)]))]);
    await t.k.apply(true);
    expect(t.alarms.create).toHaveBeenCalledWith(DIRECTORY_ALARM, { periodInMinutes: 360 });
    expect(t.status.peek()).toMatchObject({ state: 'not-live' });
    expect(t.alarms.create).toHaveBeenCalledWith(DIRECTORY_RETRY_ALARM, { delayInMinutes: 60 });
    expect((await t.k.lookup())('franz_fk19')).toEqual([]);
    await t.k.onAlarm(DIRECTORY_RETRY_ALARM);
    expect((await t.k.lookup())('franz_fk19')[0]!.address).toBe(B);
    expect(t.changed).toHaveBeenCalledTimes(1);
    expect(t.status.peek()).toMatchObject({ state: 'ok', count: 1, generatedAt: Date.parse('2026-11-03T11:50:00Z') });
  });
  it('503 and an older build keep what is held; the stale header is shown', async () => {
    const t = keeper([
      async () => json(dir('2026-11-03T11:50:00Z', [entry('franz_fk19', B)])),
      async () => new Response(null, { status: 503 }),
      async () => json(dir('2026-11-03T11:40:00Z', [entry('franz_fk19', A)]), { 'x-directory-stale': '1' }),
    ]);
    await t.k.refresh();
    await t.k.refresh();
    expect(t.status.peek()).toMatchObject({ state: 'unavailable', count: 1 });
    await t.k.refresh();
    expect(t.status.peek()).toMatchObject({ state: 'ok', stale: true, count: 1 });
    expect((await t.k.lookup())('franz_fk19')[0]!.address).toBe(B);
    expect(t.changed).toHaveBeenCalledTimes(1);
  });
  it('a future-dated build is a trust event; the held one stays', async () => {
    const t = keeper([async () => json(dir('2026-11-03T11:50:00Z', [entry('franz_fk19', B)])), async () => json(dir('2026-11-03T13:00:00Z', [entry('franz_fk19', A)]))]);
    await t.k.refresh();
    await t.k.refresh();
    expect(t.status.peek()).toMatchObject({ state: 'trust', count: 1 });
    expect((await t.k.lookup())('franz_fk19')[0]!.address).toBe(B);
  });
  it('switched off: nothing kept, cached badges dropped, alarms cleared; back on downloads again', async () => {
    const t = keeper([async () => json(dir('2026-11-03T11:50:00Z', [entry('franz_fk19', B)])), async () => new Response(null, { status: 404 })]);
    await t.k.apply(true);
    await t.k.apply(false);
    expect([t.held.peek(), t.status.peek()]).toEqual([null, null]);
    expect(t.alarms.clear).toHaveBeenCalledWith(DIRECTORY_ALARM);
    expect(t.alarms.clear).toHaveBeenCalledWith(DIRECTORY_RETRY_ALARM);
    expect(t.changed).toHaveBeenCalledTimes(2);
    expect((await t.k.lookup())('franz_fk19')).toEqual([]);
    await t.k.apply(true);
    expect(t.fetchFn).toHaveBeenCalledTimes(2);
    expect((await t.k.lookup())('franz_fk19')).toEqual([]);
  });
  it('off then on while a download runs: the old one is aborted and can’t land; the new one runs', async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const t = keeper([
      async () => {
        await slow;
        return json(dir('2026-11-03T11:40:00Z', [entry('franz_fk19', A)]));
      },
      async () => json(dir('2026-11-03T11:50:00Z', [entry('franz_fk19', B)])),
    ]);
    const first = t.k.apply(true);
    await new Promise((r) => setTimeout(r, 0));
    await t.k.apply(false);
    await t.k.apply(true);
    release();
    await first;
    expect(t.fetchFn).toHaveBeenCalledTimes(2);
    expect((t.fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].signal!.aborted).toBe(true);
    expect((await t.k.lookup())('franz_fk19')[0]!.address).toBe(B);
    expect(t.held.peek()!.generatedAt).toBe(Date.parse('2026-11-03T11:50:00Z'));
  });
  it('a fresh held copy, or a failed try under an hour old, isn’t fetched again at startup', async () => {
    const t = keeper([async () => json(dir('2026-11-03T11:50:00Z', [entry('franz_fk19', B)]))]);
    await t.k.apply(true);
    t.state.now += 3600_000;
    await t.k.apply(true);
    expect(t.fetchFn).toHaveBeenCalledTimes(1);
    const u = keeper([async () => new Response(null, { status: 503 })]);
    await u.k.apply(true);
    u.state.now += 30 * 60_000;
    u.alarms.create.mockClear();
    await u.k.apply(true);
    expect(u.fetchFn).toHaveBeenCalledTimes(1);
    // the pending retry is set again, for what is left of the hour
    expect(u.alarms.create).toHaveBeenCalledWith(DIRECTORY_RETRY_ALARM, { delayInMinutes: 30 });
  });
  it('a storage read that fails once is tried again', async () => {
    const t = keeper([]);
    t.held.getValue.mockRejectedValueOnce(new Error('storage busy'));
    await expect(t.k.lookup()).rejects.toThrow('storage busy');
    expect((await t.k.lookup())('x')).toEqual([]);
  });
  it('switched off: no download at all', async () => {
    const t = keeper([], { on: false });
    await t.k.refresh();
    expect(t.fetchFn).not.toHaveBeenCalled();
  });
});
