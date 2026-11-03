import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_RELAYS, INDEX_RELAYS, POST_FALLBACK_RELAYS } from '../src/settings';
import { NIP65_TTL_MS, readRelaysOf, relaysInUseText, republishAllowed, resolvePostRelays, type Nip65Cache } from '../src/nostr/post-relays';

const PK = 'a'.repeat(64);
const NOW = 100 * NIP65_TTL_MS;

function deps(o: { manual?: string[]; cache?: Nip65Cache | null; fetched?: string[] | Error; network?: boolean; nip65?: boolean } = {}) {
  let cache = o.cache ?? null;
  const cached = vi.fn(async () => cache);
  const fetch = vi.fn(async (_pk: string) => {
    if (o.fetched instanceof Error) throw o.fetched;
    return o.fetched ?? [];
  });
  return {
    fetch,
    cached,
    cache: () => cache,
    d: {
      manual: async () => o.manual ?? [],
      useNip65: async () => o.nip65 ?? true,
      cached,
      fetch: o.network === false ? undefined : fetch,
      saveCache: async (c: Nip65Cache) => void (cache = c),
      now: () => NOW,
    },
  };
}

describe('resolvePostRelays', () => {
  it('your own list wins, without index relays', async () => {
    const t = deps({ manual: ['wss://my.relay', INDEX_RELAYS[0]!], fetched: ['wss://n.relay'] });
    expect(await resolvePostRelays(PK, t.d)).toEqual({ relays: ['wss://my.relay'], source: 'manual' });
    expect(t.fetch).not.toHaveBeenCalled();
  });

  it('a fresh NIP-65 cache, then a fetched list (cached)', async () => {
    const fresh = deps({ cache: { pubkey: PK, relays: ['wss://c.relay'], at: NOW - 1000 } });
    expect(await resolvePostRelays(PK, fresh.d)).toEqual({ relays: ['wss://c.relay'], source: 'nip65' });
    expect(fresh.fetch).not.toHaveBeenCalled();
    const t = deps({ fetched: ['wss://n.relay'] });
    expect(await resolvePostRelays(PK, t.d)).toEqual({ relays: ['wss://n.relay'], source: 'nip65' });
    expect(t.cache()).toEqual({ pubkey: PK, relays: ['wss://n.relay'], at: NOW });
  });

  it('a NIP-65 list equal to the defaults is still yours', async () => {
    const t = deps({ fetched: [...DEFAULT_RELAYS] });
    expect(await resolvePostRelays(PK, t.d)).toEqual({ relays: DEFAULT_RELAYS, source: 'nip65' });
  });

  it("falls back to XMRadar's picks: failed fetch, stale cache, another key's cache, all-index list, no key", async () => {
    const fb = { relays: POST_FALLBACK_RELAYS, source: 'fallback' };
    expect(await resolvePostRelays(PK, deps({ fetched: new Error('down'), cache: { pubkey: PK, relays: ['wss://old'], at: NOW - NIP65_TTL_MS } }).d)).toEqual(fb);
    expect(await resolvePostRelays(PK, deps({ cache: { pubkey: 'b'.repeat(64), relays: ['wss://x'], at: NOW } }).d)).toEqual(fb);
    expect(await resolvePostRelays(PK, deps({ fetched: [...INDEX_RELAYS] }).d)).toEqual(fb);
    const none = deps({ fetched: ['wss://n.relay'] });
    expect(await resolvePostRelays(null, none.d)).toEqual(fb);
    expect(none.fetch).not.toHaveBeenCalled();
  });

  it('an all-index manual list falls through and says so', async () => {
    expect(await resolvePostRelays(PK, deps({ manual: [...INDEX_RELAYS] }).d)).toEqual({ relays: POST_FALLBACK_RELAYS, source: 'fallback', indexOnlyManual: true });
    expect(await resolvePostRelays(PK, deps({ manual: [...INDEX_RELAYS], fetched: ['wss://n.relay'] }).d)).toMatchObject({ source: 'nip65', indexOnlyManual: true });
  });

  it('without the network: never fetches', async () => {
    const t = deps({ fetched: ['wss://n.relay'], network: false });
    expect(await resolvePostRelays(PK, t.d)).toMatchObject({ source: 'fallback' });
    expect(t.fetch).not.toHaveBeenCalled();
  });
});

describe('the NIP-65 switch (posts only)', () => {
  it("off: XMRadar's picks, without reading the cache or asking a relay", async () => {
    const t = deps({ nip65: false, cache: { pubkey: PK, relays: ['wss://c.relay'], at: NOW }, fetched: ['wss://n.relay'] });
    expect(await resolvePostRelays(PK, t.d)).toEqual({ relays: POST_FALLBACK_RELAYS, source: 'fallback', nip65Off: true });
    expect(t.cached).not.toHaveBeenCalled();
    expect(t.fetch).not.toHaveBeenCalled();
  });
  it('your own list still wins; an index-only one keeps its note', async () => {
    expect(await resolvePostRelays(PK, deps({ nip65: false, manual: ['wss://my.relay'] }).d)).toEqual({ relays: ['wss://my.relay'], source: 'manual' });
    const r = await resolvePostRelays(PK, deps({ nip65: false, manual: [...INDEX_RELAYS] }).d);
    expect(r).toMatchObject({ source: 'fallback', nip65Off: true, indexOnlyManual: true });
    expect(relaysInUseText(r, true)).toBe("purplepag.es keeps profiles only, so notes go elsewhere. In use: relay.damus.io, nos.lol, relay.primal.net, nostr.mom, relay.ditto.pub (XMRadar's picks).");
  });
  it('off says only the picks, with or without a key', () => {
    const r = { relays: POST_FALLBACK_RELAYS, source: 'fallback' as const, nip65Off: true };
    for (const k of [true, false]) expect(relaysInUseText(r, k)).toBe("In use: relay.damus.io, nos.lol, relay.primal.net, nostr.mom, relay.ditto.pub (XMRadar's picks).");
  });
  it('the setting reads on unless switched off', async () => {
    const { useNip65On } = await import('../src/settings');
    expect(useNip65On({})).toBe(true);
    expect(useNip65On(null)).toBe(true);
    expect(useNip65On({ useNip65: false })).toBe(false);
  });
  it('lookups ignore it: the background passes true for them', async () => {
    const src = (await import('node:fs')).readFileSync('src/entrypoints/background.ts', 'utf8');
    expect(src).toContain("useNip65: async () => use === 'lookup' || useNip65On(await settingsItem.getValue())");
    expect(src).toContain("readRelaysOf(await postRelays(pubkey, 'lookup'))");
    // every call names its use
    const calls = [...src.matchAll(/await postRelays\(([^)]*)\)/g)].map((m) => m[1]!);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const a of calls) expect(a).toMatch(/'(post|lookup)'/);
  });
});

describe('lookups and retries', () => {
  it('lookups fall back to the 3 defaults only', async () => {
    for (const o of [{ fetched: new Error('down') }, { fetched: [] }, { fetched: [...INDEX_RELAYS] }, { cache: { pubkey: PK, relays: ['wss://old'], at: 0 } }])
      expect(readRelaysOf(await resolvePostRelays(PK, deps(o).d))).toEqual(DEFAULT_RELAYS);
    expect(readRelaysOf(await resolvePostRelays(PK, deps({ fetched: ['wss://n.relay'] }).d))).toEqual(['wss://n.relay']);
  });

  it('the fallback adds 2 relays to the defaults, all wss, no index relay, no repeats', () => {
    expect(POST_FALLBACK_RELAYS.slice(0, 3)).toEqual(DEFAULT_RELAYS);
    expect(POST_FALLBACK_RELAYS).toHaveLength(5);
    expect(new Set(POST_FALLBACK_RELAYS).size).toBe(5);
    expect(POST_FALLBACK_RELAYS.every((r) => r.startsWith('wss://') && !INDEX_RELAYS.includes(r))).toBe(true);
    // the Xap privacy note names these 3
    expect(DEFAULT_RELAYS.map((r) => r.replace('wss://', '')).sort()).toEqual(['nos.lol', 'relay.damus.io', 'relay.primal.net']);
  });

  it('a retry goes only to relays the first publish used', () => {
    expect(republishAllowed(['wss://a', 'wss://b'], ['wss://b', 'wss://evil', 7])).toEqual(['wss://b']);
    expect(republishAllowed(undefined, ['wss://a'])).toEqual([]);
    expect(republishAllowed(['wss://a'], 'wss://a')).toEqual([]);
  });
});

describe('relaysInUseText', () => {
  const fb = { relays: POST_FALLBACK_RELAYS, source: 'fallback' as const };
  it('says nothing for your own list', () => {
    expect(relaysInUseText({ relays: ['wss://my.relay'], source: 'manual' }, true)).toBe('');
  });
  it('names your NIP-65 list', () => {
    expect(relaysInUseText({ relays: ['wss://n.relay/'], source: 'nip65' }, true)).toBe('In use: n.relay (your NIP-65 relay list).');
  });
  it("names XMRadar's picks, without promising a lookup it can't make", () => {
    expect(relaysInUseText(fb, false)).toBe(
      "In use: relay.damus.io, nos.lol, relay.primal.net, nostr.mom, relay.ditto.pub (XMRadar's picks). Connect your signer and XMRadar uses your NIP-65 relay list instead, if you have one.",
    );
    expect(relaysInUseText(fb, true)).toBe('When you post, XMRadar uses your NIP-65 relay list if you have one, otherwise relay.damus.io, nos.lol, relay.primal.net, nostr.mom, relay.ditto.pub.');
  });
  it('explains an index-only list of your own', () => {
    expect(relaysInUseText({ ...fb, indexOnlyManual: true }, true)).toMatch(/^purplepag\.es keeps profiles only, so notes go elsewhere\. When you post/);
    expect(relaysInUseText({ relays: ['wss://n.relay'], source: 'nip65', indexOnlyManual: true }, true)).toBe('purplepag.es keeps profiles only, so notes go elsewhere. In use: n.relay (your NIP-65 relay list).');
  });
});
