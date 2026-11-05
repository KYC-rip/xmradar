import { describe, expect, it, vi } from 'vitest';
import { REQUEST_TYPES, xLookups, type Kv, type XLookupsDeps } from '../src/service/x-lookups';
import type { BadgeEntry } from '../src/identity/resolve';
import type { XmrSettings } from '../src/settings';

const STD = '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';
const PK = 'a'.repeat(64);

function kv<T>(v: T): Kv<T> & { v: T } {
  const o = { v, getValue: async () => o.v, setValue: async (n: T) => void (o.v = n) };
  return o;
}

function make(over: Partial<XLookupsDeps> = {}, settings: Partial<XmrSettings> = {}) {
  const query = vi.fn(async () => []);
  const xapQuery = vi.fn(async () => []);
  const fetch = vi.fn(async (url: string | URL | Request) => {
    if (String(url).includes('/price/XMR')) return new Response(JSON.stringify({ usd: 150 }));
    return new Response('', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  const dir = (h: string): BadgeEntry[] => (h === 'alice' ? [{ source: 'xmrbio', address: STD, check: { ok: true, kind: 'standard', network: 'mainnet' }, verified: true, method: 'xmrbio' } as unknown as BadgeEntry] : []);
  const selfClaims = vi.fn(async () => () => undefined);
  const deps: XLookupsDeps = {
    items: { badgeCache: kv([]), proofCache: kv([]), xapCache: kv([]), xmrUsd: kv(null), xmrbioSeen: kv([]) },
    fetch,
    query,
    xapQuery,
    settings: async () => ({ badgesX: true, badgesNostr: true, nostrDiscovery: false, tipReceipts: false, badgeIcon: 'mono', badgeLabel: true, ...settings }) as XmrSettings,
    badgeRelays: async () => ['wss://mine.example'],
    xapRelays: async () => ['wss://mine.example'],
    me: async () => ({ pubkey: null, sent: [] }),
    directory: async () => dir,
    selfClaims,
    ...over,
  };
  return { svc: xLookups(deps), query, xapQuery, fetch, selfClaims };
}

describe('xLookups — the shared lookups behind X badges and tips', () => {
  it('refuses to build without its own transports (no library default connection)', () => {
    expect(() => make({ query: undefined as never })).toThrow(/required/);
    expect(() => make({ xapQuery: undefined as never })).toThrow(/required/);
    expect(() => make({ fetch: undefined as never })).toThrow(/required/);
  });

  it('answers only the allow-listed request types', async () => {
    const { svc } = make();
    expect([...REQUEST_TYPES]).toEqual(['resolve-handles', 'xap-totals', 'xap-post-totals', 'xmrbio-resolve', 'xmr-price']);
    for (const t of ['x-claims-seen', 'xap-publish', 'xo-send', 'share-menu-copy', 'sign']) await expect(svc.handle(t, {}, 'xapp')).rejects.toThrow('unsupported');
  });

  it('badges from the directory, without relays while discovery is off', async () => {
    const { svc, query } = make();
    const r = (await svc.handle('resolve-handles', { handles: ['alice', 'bob', 'not a handle!'] }, 'xapp')) as { badges: [string, { primary?: { address: string } }][] };
    expect(r.badges.map(([h]) => h).sort()).toEqual(['alice', 'bob']);
    expect(r.badges.find(([h]) => h === 'alice')![1].primary?.address).toBe(STD);
    expect(query).not.toHaveBeenCalled();
  });

  it('discovery reads relays only through the injected query, on XMRadar’s relays plus the caller’s', async () => {
    const { svc, query } = make({}, { nostrDiscovery: true });
    await svc.handle('resolve-handles', { handles: ['carol'] }, 'xapp');
    expect(query).toHaveBeenCalled();
    const relays = (query.mock.calls[0] as unknown as [string[]])[0];
    expect(relays).toContain('wss://mine.example');
    expect(relays).toContain('wss://purplepag.es');
  });

  it('self-claims are not read while X claims are off (Ripley forces them off)', async () => {
    const { svc, selfClaims } = make({}, { xClaims: false });
    await svc.handle('resolve-handles', { handles: ['dave'] }, 'xapp');
    expect(selfClaims).not.toHaveBeenCalled();
  });

  it('the price goes through the injected fetch and is cached', async () => {
    const { svc, fetch } = make();
    expect(await svc.handle('xmr-price', {}, 'xapp')).toEqual({ usd: 150 });
    expect(await svc.handle('xmr-price', {}, 'xapp')).toEqual({ usd: 150 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('xmr.bio lookups go through the injected fetch', async () => {
    const { svc, fetch } = make();
    expect(await svc.handle('xmrbio-resolve', { handle: 'alice' }, 'xapp')).toEqual({ found: false });
    expect(String((fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0])).toContain('/resolve/alice');
  });

  it('xap totals: nothing without discovery; with it, relay reads through the injected xapQuery, rate-limited per key', async () => {
    expect(await make().svc.handle('xap-totals', { recipients: [PK] }, 'xapp')).toEqual({ totals: [], pending: [] });
    const { svc, xapQuery } = make({}, { nostrDiscovery: true });
    const many = Array.from({ length: 50 }, (_, i) => i.toString(16).padStart(64, '0'));
    const first = (await svc.handle('xap-totals', { recipients: many }, 'xapp')) as { totals: unknown[]; pending: string[] };
    expect(xapQuery).toHaveBeenCalled();
    expect(first.totals.length + first.pending.length).toBe(50);
    // another key has its own bucket (the extension's tabs; Ripley has one)
    const more = Array.from({ length: 50 }, (_, i) => (i + 100).toString(16).padStart(64, '0'));
    const other = (await svc.handle('xap-totals', { recipients: more }, 7)) as { pending: string[] };
    expect(other.pending).toEqual([]);
  });
});
