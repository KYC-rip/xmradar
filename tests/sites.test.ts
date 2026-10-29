import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { badgeFor, firstSentence, levelText, needsBanner, PLATFORM_HOSTS, readFeed, sitesFor, worstGrade, type SiteEntry, type SiteFeed } from '../src/sites/feed';
import { bannerText, startSiteInfo } from '../src/entrypoints/content/site';
import { renderSiteCard } from '../src/ui/site-card';

const send = vi.hoisted(() => vi.fn());
vi.mock('../src/messaging', async (orig) => ({ ...(await orig<typeof import('../src/messaging')>()), sendToBackground: send }));

const sk = ed25519.utils.randomSecretKey();
const KEY = bytesToHex(ed25519.getPublicKey(sk));
const KEYS = new Set([KEY]);
const NOW = 1_793_261_226;
const site = (over: Record<string, unknown> = {}) => ({ id: 'kyc-rip-aggregator', name: 'kyc.rip', category: 'exchanges', grade: 'B', incident: false, url: 'https://xmr.club/exchanges/kyc-rip-aggregator', hosts: ['kyc.rip'], ...over });
const sign = (payload: unknown, key = sk) => {
  const text = JSON.stringify(payload);
  return { payload: text, signature: bytesToHex(ed25519.sign(new TextEncoder().encode(text), key)), public_key: bytesToHex(ed25519.getPublicKey(key)), alg: 'ed25519' };
};
const payload = (over: Record<string, unknown> = {}) => ({ v: 1, issuer: 'xmr.club', issued_at: NOW, expires_at: NOW + 172800, sites: [site()], ...over });

describe('the xmr.club feed: trust', () => {
  it('accepts a feed signed with a pinned key', () => {
    expect(readFeed(sign(payload()), NOW, 0, KEYS)).toMatchObject({ reader: 3, issuedAt: NOW, sites: [{ id: 'kyc-rip-aggregator', hosts: ['kyc.rip'] }] });
  });
  it('refuses an unknown key, a bad signature, another issuer or version', () => {
    expect(() => readFeed(sign(payload(), ed25519.utils.randomSecretKey()), NOW, 0, KEYS)).toThrow('unknown key');
    const env = sign(payload());
    expect(() => readFeed({ ...env, payload: env.payload.replace('"B"', '"A"') }, NOW, 0, KEYS)).toThrow('Bad signature');
    expect(() => readFeed(sign(payload({ issuer: 'evil.club' })), NOW, 0, KEYS)).toThrow('Not an xmr.club');
    expect(() => readFeed(sign(payload({ v: 2 })), NOW, 0, KEYS)).toThrow('Not an xmr.club');
  });
  it('refuses an expired feed, one from the future, and a rollback', () => {
    expect(() => readFeed(sign(payload()), NOW + 172800, 0, KEYS)).toThrow('expired');
    expect(() => readFeed(sign(payload({ issued_at: NOW + 3600, expires_at: NOW + 99999 })), NOW, 0, KEYS)).toThrow('future');
    expect(() => readFeed(sign(payload()), NOW, NOW, KEYS)).toThrow('not newer');
  });
  it('drops malformed entries and hosts, keeps the rest', () => {
    const feed = readFeed(
      sign(payload({ sites: [site(), site({ id: 'x', url: 'https://evil.com/x' }), site({ id: 'y', grade: 'Z' }), site({ id: 'pm', grade: 'B-' }), site({ id: 'z', hosts: ['127.0.0.1', 'localhost', 'Bad.Host', 'ok.example'] }), site({ id: 'w', hosts: [] })] })),
      NOW,
      0,
      KEYS,
    );
    expect(feed.sites.map((s) => s.id)).toEqual(['kyc-rip-aggregator', 'pm', 'z']);
    expect(feed.sites[2]!.hosts).toEqual(['ok.example']);
  });
  it('the pinned production key is the one the live feed was verified with', async () => {
    const { PINNED_XMRCLUB_KEYS } = await import('../src/sites/feed');
    expect([...PINNED_XMRCLUB_KEYS]).toEqual(['8046f1d1d6712a415124aea6b7bc266b16b1dd3c9dd89f3ffe6c819ec7023d17']);
  });
});

describe('matching a page host (§2)', () => {
  const feed: SiteFeed = {
    issuedAt: NOW,
    expiresAt: NOW + 1,
    sites: [
      site() as SiteEntry,
      site({ id: 'kyc-rip-ghost', name: 'kyc.rip / ghost', grade: 'B', nkip01: { level: 2, logOnly: false, checkedAt: null, lastOkAt: null, l3VerifiedAt: null } }) as SiteEntry,
      site({ id: 'joinmarket', hosts: ['github.com'] }) as SiteEntry,
    ],
  };
  it('the exact host or www., in any case, with a trailing dot', () => {
    for (const h of ['kyc.rip', 'www.kyc.rip', 'KYC.RIP', 'kyc.rip.']) expect(sitesFor(feed, h).length, h).toBe(2);
    for (const h of ['app.kyc.rip', 'kyc.rip.evil.com', 'xkyc.rip', 'evil.com', '']) expect(sitesFor(feed, h), h).toEqual([]);
  });
  it('all listings of a host, never one picked; platforms never match', () => {
    expect(sitesFor(feed, 'kyc.rip').map((s) => s.id)).toEqual(['kyc-rip-aggregator', 'kyc-rip-ghost']);
    expect(sitesFor(feed, 'github.com')).toEqual([]);
    expect(PLATFORM_HOSTS.has('youtube.com') && PLATFORM_HOSTS.has('reddit.com')).toBe(true);
    // real service hosts since xmr.club's data fix
    expect(PLATFORM_HOSTS.has('privacyguides.org') || PLATFORM_HOSTS.has('getmonero.org')).toBe(false);
  });
});

describe('what the listings mean (§3)', () => {
  const s = (over: Partial<SiteEntry>) => ({ ...(site() as SiteEntry), ...over });
  it('worst grade, banner only for an incident or D–F', () => {
    expect(worstGrade([s({ grade: 'A' }), s({ grade: 'D' }), s({ grade: '' })])).toBe('D');
    expect(worstGrade([s({ grade: '' })])).toBe('');
    expect(worstGrade([s({ grade: 'B' }), s({ grade: 'B-' }), s({ grade: 'A+' })])).toBe('B-');
    expect(worstGrade([s({ grade: 'C+' }), s({ grade: 'B-' })])).toBe('C+');
    expect(needsBanner([s({ grade: 'D-' })])).toBe(true);
    expect(needsBanner([s({ grade: 'C-' })])).toBe(false);
    expect(needsBanner([s({ grade: 'C' })])).toBe(false);
    expect(needsBanner([s({ grade: 'F' })])).toBe(true);
    expect(needsBanner([s({ grade: 'A', incident: true })])).toBe(true);
  });
  it('level wording: out of scope has none, letter of guarantee isn’t a level', () => {
    expect(levelText(undefined)).toBeNull();
    expect(levelText({ level: 0, logOnly: true, checkedAt: null, lastOkAt: null, l3VerifiedAt: null })).toBe('Letter of guarantee only');
    expect(levelText({ level: 0, logOnly: false, checkedAt: null, lastOkAt: null, l3VerifiedAt: null })).toBe('No verifiable receipts yet');
    expect(levelText({ level: 3, logOnly: false, checkedAt: null, lastOkAt: null, l3VerifiedAt: 1 })).toBe('NKIP-0001 · verified receipts');
  });
  it('toolbar badge priority: receipt warn > incident > receipt caution > receipt ok > grade', () => {
    const site = (grade: string, incident = false) => ({ grade, incident });
    expect(badgeFor({ receipt: 'warn', site: site('A', true) })).toEqual({ text: '!', color: '#d93025' });
    expect(badgeFor({ receipt: 'ok', site: site('C', true) })).toEqual({ text: 'C', color: '#d93025' });
    expect(badgeFor({ site: site('', true) }).text).toBe('!');
    expect(badgeFor({ receipt: 'caution', site: site('A') })).toEqual({ text: '!', color: '#b26a00' });
    expect(badgeFor({ receipt: 'ok', site: site('B') })).toEqual({ text: '✓', color: '#1e7d34' });
    expect(badgeFor({ site: site('B') }).text).toBe('B');
    expect(badgeFor({ site: site('') }).text).toBe('•');
    expect(badgeFor({}).text).toBe('');
  });
  it('incident detail: date, severity and the first sentence; only for an open incident', () => {
    const feed = readFeed(
      sign(payload({ sites: [site({ id: 'wagyu', name: 'Wagyu', grade: 'C', incident: true, hosts: ['wagyu.xyz'], incident_detail: { date: '2026-10-27', severity: 'high', summary: 'Order data leaked after a ransom was refused. More text follows.', source_url: 'https://example.com/a' } }), site({ id: 'calm', hosts: ['calm.example'], incident: false, incident_detail: { date: '2026-01-01', severity: 'low', summary: 'Old.', source_url: null } }), site({ id: 'bad', hosts: ['bad.example'], incident: true, incident_detail: { date: 'yesterday', severity: 'high', summary: 'x', source_url: 'javascript:alert(1)' } })] })),
      NOW,
      0,
      KEYS,
    );
    const [wagyu, calm, bad] = feed.sites;
    expect(wagyu!.incidentDetail).toEqual({ date: '2026-10-27', severity: 'high', summary: 'Order data leaked after a ransom was refused. More text follows.', sourceUrl: 'https://example.com/a' });
    expect(calm!.incidentDetail).toBeUndefined();
    expect(bad!.incidentDetail).toBeUndefined();
    expect(bannerText([wagyu!]).lead).toBe('Open incident for Wagyu (high, 2026-10-27): Order data leaked after a ransom was refused.');
    expect(firstSentence('x'.repeat(300), 20)).toHaveLength(20);
  });
  it('banner wording: the worst listing and how many more', () => {
    expect(bannerText([s({ name: 'Wagyu', grade: 'C', incident: true })]).lead).toBe('xmr.club lists an open incident for Wagyu.');
    expect(bannerText([s({ name: 'A', grade: 'B' }), s({ name: 'Z', grade: 'F' })])).toMatchObject({ lead: 'xmr.club grades Z F.', rest: " (+1 more in XMRadar's menu)" });
  });
  it('the popup card lists every listing, with the source line', () => {
    const root = document.createElement('div');
    renderSiteCard(root, { sites: [s({ incident: true, nkip01: { level: 3, logOnly: false, checkedAt: null, lastOkAt: null, l3VerifiedAt: 1 } })], outOfDate: true, issuedAt: NOW });
    expect(root.textContent).toContain('kyc.rip · grade B');
    expect(root.textContent).toContain('NKIP-0001 · verified receipts');
    expect(root.textContent).toContain('Open incident');
    expect(root.textContent).toContain('List out of date');
    expect(root.textContent).toContain('run by the same team as XMRadar');
    expect(root.querySelector('a')!.getAttribute('href')).toBe('https://xmr.club/exchanges/kyc-rip-aggregator');
    renderSiteCard(root, { sites: [], outOfDate: false, issuedAt: null });
    expect(root.classList.contains('hidden')).toBe(true);
  });
});

describe('on the page (content script)', () => {
  let invalidate: (() => void)[] = [];
  const ctx = { addEventListener: (t: EventTarget, e: string, h: EventListener) => t.addEventListener(e, h), onInvalidated: (cb: () => void) => invalidate.push(cb) };
  beforeEach(() => {
    fakeBrowser.reset();
    send.mockReset().mockResolvedValue({ sites: [{ ...site({ name: 'Wagyu', grade: 'C', incident: true }) }], outOfDate: false, issuedAt: NOW });
  });
  afterEach(() => {
    for (const cb of invalidate) cb();
    invalidate = [];
    document.querySelectorAll('xmradar-site').forEach((e) => e.remove());
  });
  it('sends only the hostname, and shows the banner for an incident', async () => {
    startSiteInfo(ctx as never);
    await vi.waitFor(() => expect(document.querySelector('xmradar-site')).not.toBeNull());
    expect(send).toHaveBeenCalledWith({ type: 'site-info', host: location.hostname });
    expect(Object.keys(send.mock.calls[0]![0])).toEqual(['type', 'host']);
  });
  it('no banner with warnings off; nothing at all with site info off', async () => {
    await fakeBrowser.storage.sync.set({ xmrSettings: { badgesX: true, badgesNostr: true, nostrDiscovery: false, tipReceipts: true, badgeIcon: 'mono', badgeLabel: true, siteWarnings: false }, xmrSettings$: { v: 3 } });
    startSiteInfo(ctx as never);
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect(document.querySelector('xmradar-site')).toBeNull();
    for (const cb of invalidate) cb();
    invalidate = [];
    send.mockClear();
    await fakeBrowser.storage.sync.set({ xmrSettings: { badgesX: true, badgesNostr: true, nostrDiscovery: false, tipReceipts: true, badgeIcon: 'mono', badgeLabel: true, siteInfo: false }, xmrSettings$: { v: 3 } });
    startSiteInfo(ctx as never);
    await new Promise((r) => setTimeout(r, 30));
    expect(send).not.toHaveBeenCalled();
  });
  it('a dismissed banner stays away for 7 days on that host', async () => {
    await fakeBrowser.storage.local.set({ siteBannerDismissed: { [location.hostname.replace(/^www\./, '')]: Date.now() + 1000 } });
    startSiteInfo(ctx as never);
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector('xmradar-site')).toBeNull();
  });
});
