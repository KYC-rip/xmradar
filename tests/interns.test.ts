// @vitest-environment happy-dom
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { bannerText } from '../src/entrypoints/content/site';
import { badgeFor, internCaution, internText, leadSite, needsBanner, publicSite, readFeed, type SiteEntry } from '../src/sites/feed';
import { renderSiteCard } from '../src/ui/site-card';

const sk = ed25519.utils.randomSecretKey();
const KEYS = new Set([bytesToHex(ed25519.getPublicKey(sk))]);
const NOW = 1_793_261_226;
const sign = (payload: unknown) => {
  const text = JSON.stringify(payload);
  return { payload: text, signature: bytesToHex(ed25519.sign(new TextEncoder().encode(text), sk)), public_key: bytesToHex(ed25519.getPublicKey(sk)), alg: 'ed25519' };
};
// the two live shapes (2026-10-31), logs left out
const NOX = { id: 'noxswap', name: 'NoxSwap', category: 'exchanges', grade: null, intern: { day: 3, days_required: 90, track: 'funds' }, incident: false, incident_detail: null, url: 'https://xmr.club/exchanges/noxswap', hosts: ['noxswap.io'], path_prefix: null, order_url: null, log: null };
const TORI = { id: 'torisim', name: 'Torisim', category: 'sims', grade: null, intern: { day: 3, days_required: 60, track: 'standard' }, incident: false, incident_detail: null, url: 'https://xmr.club/sims/torisim', hosts: ['torisim.com'], path_prefix: null, order_url: null, log: null };
const feed = (...sites: unknown[]) => readFeed(sign({ v: 1, issuer: 'xmr.club', issued_at: NOW, expires_at: NOW + 172800, sites }), NOW, 0, KEYS).sites;

describe('intern listings in the feed', () => {
  it('reads the live shapes', () => {
    const [nox, tori] = feed(NOX, TORI);
    expect(nox).toMatchObject({ grade: '', intern: { day: 3, daysRequired: 90, track: 'funds' } });
    expect(tori!.intern).toEqual({ day: 3, daysRequired: 60, track: 'standard' });
    // the popup gets it too
    expect(publicSite(nox!).intern).toEqual(nox!.intern);
  });
  it('a graded listing has graduated: its intern block is dropped', () => {
    expect(feed({ ...NOX, grade: 'B' })[0]!.intern).toBeUndefined();
  });
  it('a malformed intern block is dropped, the listing kept as ungraded', () => {
    for (const intern of [{ day: 0, days_required: 90, track: 'funds' }, { day: -1, days_required: 90, track: 'funds' }, { day: 3, days_required: 99999, track: 'funds' }, { day: 3, days_required: 90, track: 'holds funds' }, { day: '3', days_required: 90, track: 'funds' }, 'yes']) {
      const [x] = feed({ ...NOX, intern });
      expect(x).toMatchObject({ id: 'noxswap', grade: '' });
      expect(x!.intern).toBeUndefined();
    }
  });
  it('texts: the day never past the days required; the caution only for funds', () => {
    expect(internText({ day: 3, daysRequired: 90, track: 'funds' })).toBe('Intern · day 3/90 · not graded yet');
    expect(internText({ day: 95, daysRequired: 90, track: 'funds' })).toBe('Intern · day 90/90 · not graded yet');
    expect(internCaution({ day: 3, daysRequired: 90, track: 'funds' })).toBe('It holds your coins during a swap: keep amounts small.');
    expect(internCaution({ day: 3, daysRequired: 60, track: 'standard' })).toBeNull();
  });
});

describe('which listing a host is shown by', () => {
  const [nox, tori] = feed(NOX, TORI) as [SiteEntry, SiteEntry];
  const graded = (grade: string, incident = false): SiteEntry => ({ ...nox, id: `g${grade}`, name: `Graded ${grade}`, grade, incident, intern: undefined });
  it('incident, then D–F, then a funds intern, then any intern, then the worst grade', () => {
    expect(leadSite([nox, graded('A', true)])!.name).toBe('Graded A');
    expect(leadSite([nox, graded('D')])!.name).toBe('Graded D');
    expect(leadSite([graded('B'), nox])!.name).toBe('NoxSwap');
    expect(leadSite([tori, nox])!.name).toBe('NoxSwap');
    expect(leadSite([graded('A'), tori])!.name).toBe('Torisim');
    expect(leadSite([graded('A'), graded('C')])!.name).toBe('Graded C');
  });
  it('a banner for a funds intern only; the incident and D–F lead it', () => {
    expect(needsBanner([nox])).toBe(true);
    expect(needsBanner([tori])).toBe(false);
    expect(bannerText([nox]).lead).toBe('NoxSwap is new on xmr.club (intern, day 3 of 90, not graded yet). It holds your coins during a swap: keep amounts small.');
    expect(bannerText([graded('B'), nox]).site.name).toBe('NoxSwap');
    expect(bannerText([nox, graded('D')]).lead).toBe('xmr.club grades Graded D D.');
  });
});

describe('the toolbar badge', () => {
  it('an intern host: amber new, even over a verified receipt or a grade', () => {
    expect(badgeFor({ site: { grade: '', incident: false, intern: true } })).toEqual({ text: 'new', color: '#b26a00' });
    expect(badgeFor({ receipt: 'ok', site: { grade: 'A', incident: false, intern: true } })).toEqual({ text: 'new', color: '#b26a00' });
  });
  it('a receipt warning or caution and an incident still come first', () => {
    expect(badgeFor({ receipt: 'warn', site: { grade: '', incident: false, intern: true } }).text).toBe('!');
    expect(badgeFor({ receipt: 'caution', site: { grade: '', incident: false, intern: true } }).color).toBe('#b26a00');
    expect(badgeFor({ site: { grade: '', incident: true, intern: true } }).color).toBe('#d93025');
  });
});

describe('the popup card', () => {
  it('an intern: new, the day, the funds caution; no grade', () => {
    const root = document.createElement('div');
    renderSiteCard(root, { sites: feed(NOX).map(publicSite), outOfDate: false, issuedAt: NOW });
    expect(root.textContent).toContain('NoxSwap · new on xmr.club');
    expect(root.textContent).toContain('Intern · day 3/90 · not graded yet');
    expect(root.textContent).toContain('keep amounts small');
    expect(root.textContent).not.toMatch(/grade [A-F]|verified site|graded by/i);
  });
  it('a standard intern has no funds caution', () => {
    const root = document.createElement('div');
    renderSiteCard(root, { sites: feed(TORI).map(publicSite), outOfDate: false, issuedAt: NOW });
    expect(root.textContent).toContain('Intern · day 3/60');
    expect(root.textContent).not.toContain('keep amounts small');
  });
});
