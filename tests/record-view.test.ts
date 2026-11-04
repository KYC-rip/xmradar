import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { savedSignatureLine } from '../src/receipts/check';
import { letterOrderLink, orderLink, receiptOrderLink } from '../src/receipts/order-link';
import type { SiteEntry, SiteFeed } from '../src/sites/feed';

// PLAN-RECORDVIEW: the order page rebuilt from the feed's template, and the saved receipt's signature checked again
const NOW = 1_800_000_000_000;
const site = (over: Partial<SiteEntry>): SiteEntry => ({ id: 'x', name: 'X', category: 'swap', grade: 'A', incident: false, url: 'https://xmr.club/x', hosts: ['kyc.rip'], ...over }) as SiteEntry;
const nk = (level: 0 | 1 | 2 | 3) => ({ level, logOnly: false, checkedAt: null, lastOkAt: null, l3VerifiedAt: null });
const feed = (sites: SiteEntry[], expiresAt = NOW / 1000 + 3600): SiteFeed => ({ issuedAt: NOW / 1000 - 60, expiresAt, sites });
const T = 'https://kyc.rip/track/{order}';

describe('orderLink', () => {
  it('puts the encoded reference where the template says', () => {
    expect(orderLink(T, 'KR-D60645C17373', ['kyc.rip'])).toBe('https://kyc.rip/track/KR-D60645C17373');
    expect(orderLink('https://ex.example/o?id={order}', 'a/b?c#d', ['ex.example'])).toBe('https://ex.example/o?id=a%2Fb%3Fc%23d');
    expect(orderLink(T, 'a/../b', ['kyc.rip'])).toBe('https://kyc.rip/track/a%2F..%2Fb');
  });
  it('refuses dot steps, spaces, control or non-ASCII characters, and overlong references', () => {
    for (const id of ['.', '..', '', 'a b', 'a\nb', 'ä', 'x'.repeat(129), '\ud800']) expect(orderLink(T, id, ['kyc.rip']), JSON.stringify(id)).toBeNull();
    expect(orderLink(T, 'x'.repeat(128), ['kyc.rip'])).not.toBeNull();
  });
  it('refuses a template off the listing’s hosts, not https, or without exactly one slot', () => {
    expect(orderLink('https://evil.example/{order}', 'A', ['kyc.rip'])).toBeNull();
    expect(orderLink('http://kyc.rip/{order}', 'A', ['kyc.rip'])).toBeNull();
    expect(orderLink('https://kyc.rip:8443/{order}', 'A', ['kyc.rip'])).toBeNull();
    expect(orderLink('https://kyc.rip/track', 'A', ['kyc.rip'])).toBeNull();
    expect(orderLink('https://kyc.rip/{order}/{order}', 'A', ['kyc.rip'])).toBeNull();
    expect(orderLink('https://www.kyc.rip/t/{order}', 'A', ['kyc.rip'])).toBe('https://www.kyc.rip/t/A');
  });
});

describe('receiptOrderLink', () => {
  const agg = site({ id: 'kyc-rip-aggregator', nkip01: nk(2), orderUrl: T });
  it('finds the listing by the issuer host, www. or not', () => {
    expect(receiptOrderLink(feed([agg]), 'kyc.rip', 'KR-1', NOW)).toBe('https://kyc.rip/track/KR-1');
    expect(receiptOrderLink(feed([agg]), 'www.kyc.rip', 'KR-1', NOW)).toBe('https://kyc.rip/track/KR-1');
  });
  it('listings that issue no receipts (level 0, none) don’t count; nkip01 log listings do', () => {
    const cards = site({ id: 'cards', nkip01: nk(0), orderUrl: 'https://kyc.rip/cards/{order}' });
    const ghost = site({ id: 'ghost', orderUrl: 'https://kyc.rip/ghost/{order}' });
    expect(receiptOrderLink(feed([cards, ghost, agg]), 'kyc.rip', 'KR-1', NOW)).toBe('https://kyc.rip/track/KR-1');
    expect(receiptOrderLink(feed([cards]), 'kyc.rip', 'KR-1', NOW)).toBeNull();
    expect(receiptOrderLink(feed([site({ log: { format: 'nkip01' }, orderUrl: T })]), 'kyc.rip', 'KR-1', NOW)).toBe('https://kyc.rip/track/KR-1');
  });
  it('several listings: the same template is fine, different ones give no link', () => {
    const cli = site({ id: 'kyc-rip-cli', nkip01: nk(1), orderUrl: T });
    expect(receiptOrderLink(feed([agg, cli]), 'kyc.rip', 'KR-1', NOW)).toBe('https://kyc.rip/track/KR-1');
    const other = site({ id: 'kyc-rip-other', nkip01: nk(1), orderUrl: 'https://kyc.rip/o/{order}' });
    expect(receiptOrderLink(feed([agg, other]), 'kyc.rip', 'KR-1', NOW)).toBeNull();
  });
  it('no feed or an expired one: no link', () => {
    expect(receiptOrderLink(null, 'kyc.rip', 'KR-1', NOW)).toBeNull();
    expect(receiptOrderLink(feed([agg], NOW / 1000 - 1), 'kyc.rip', 'KR-1', NOW)).toBeNull();
  });
});

describe('letterOrderLink', () => {
  it('by the listing id', () => {
    const s = site({ id: 'stereoswap', hosts: ['stereoswap.app'], orderUrl: 'https://stereoswap.app/swap/{order}' });
    expect(letterOrderLink(feed([s]), 'stereoswap', 'STRRSXUE', NOW)).toBe('https://stereoswap.app/swap/STRRSXUE');
    expect(letterOrderLink(feed([s]), 'other', 'STRRSXUE', NOW)).toBeNull();
    expect(letterOrderLink(feed([site({ id: 'stereoswap' })]), 'stereoswap', 'STRRSXUE', NOW)).toBeNull();
  });
});

describe('savedSignatureLine', () => {
  const load = (name: string) => JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/nkip01', name), 'utf8'));
  const v1 = load('v1.json');
  const v2 = load('v2.json');
  const r2 = v2.cases[0].receipt;
  const manifest = { ...v1.manifest, keys: [{ ...v1.manifest.keys[0], key_id: r2.key_id, public_key: v2.public_key_b64u }] };
  const page = 'https://example.swap/order/EX-V2-7';
  it('checked again against the manifest kept with it', () => {
    expect(savedSignatureLine({ receipt: r2, manifest, page })).toEqual({ level: 'ok', text: 'Signed by example.swap' });
    expect(savedSignatureLine({ receipt: { ...r2, payout_amount: '9' }, manifest, page }).level).toBe('warn');
  });
  it('saved without a check, or from another host: says so', () => {
    expect(savedSignatureLine({ receipt: r2, page })).toEqual({ level: 'caution', text: 'Not checked when it was saved.' });
    expect(savedSignatureLine({ receipt: r2, manifest, page: 'https://evil.example/o' })).toMatchObject({ level: 'warn', text: expect.stringContaining('isn’t example.swap') });
  });
});

describe('savedSignatureLine: an http page', () => {
  it('says the page wasn’t secure, not that the host differs', async () => {
    const { savedSignatureLine: line } = await import('../src/receipts/check');
    const r = { issuer: 'example.swap' } as never;
    expect(line({ receipt: r, page: 'http://example.swap/o' })).toEqual({ level: 'warn', text: 'Saved from a page that wasn’t secure (not https): not checked.' });
  });
});
