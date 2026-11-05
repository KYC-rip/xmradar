import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { directoryIndex, readDirectory } from '../src/identity/directory';
import { mergeBadge, xoCountOf } from '../src/identity/resolve';
import { buildBadge, badgeLook } from '../src/identity/badge-look';
import { postAvatar, profileAvatar, RING_ATTR, ringHost, setRing } from '../src/entrypoints/content/x-xo-ring';
import { validateMoneroAddress } from '../src/xmr/address';
import { xoOf } from '../src/xo/event';
import { xoRingsOn } from '../src/settings';

// PLAN-XORINGS
const sk = ed25519.utils.randomSecretKey();
const KEYS = new Set([bytesToHex(ed25519.getPublicKey(sk))]);
const A = '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';
const NOW = Date.parse('2026-11-03T12:00:00Z');
const sign = (payload: object) => {
  const text = JSON.stringify(payload);
  return { payload: text, signature: bytesToHex(ed25519.sign(new TextEncoder().encode(text), sk)), public_key: bytesToHex(ed25519.getPublicKey(sk)), alg: 'ed25519' };
};
const dir = (entries: object[]) => sign({ v: 1, service: 'xmr.bio', generated_at: '2026-11-03T11:50:00Z', count: entries.length, entries });
const entry = (handle: string, extra: object = {}) => ({ handle, address: A, verified_at: '2025-12-23T14:12:18.787Z', ...extra });

describe('shared vectors (with the xmr.bio API)', () => {
  const v = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/xo-vectors-v1.json'), 'utf8')) as {
    version: number;
    now: number;
    xo: { name: string; event: Parameters<typeof xoOf>[0]; expected: unknown }[];
    addresses: { name: string; address: string; valid: boolean }[];
  };
  it('is the version this code was written for', () => expect(v.version).toBe(1));
  it('xoOf gives every expected result', () => {
    for (const x of v.xo) expect(xoOf(x.event, v.now), x.name).toEqual(x.expected);
  });
  it('the address check gives every expected result', () => {
    for (const a of v.addresses) expect(validateMoneroAddress(a.address).ok, a.name).toBe(a.valid);
  });
});

describe('xo_count in the directory', () => {
  it('a whole number from 1 to 10^7 is kept; anything else drops the field, not the entry', () => {
    const d = readDirectory(
      dir([entry('a', { xo_count: 37 }), entry('b', { xo_count: 0 }), entry('c', { xo_count: -1 }), entry('d', { xo_count: 2.5 }), entry('e', { xo_count: '9' }), entry('f', { xo_count: 10_000_001 }), entry('g')]),
      null,
      { now: NOW, keys: KEYS },
    )!;
    expect(d.entries.map((e) => [e.handle, e.xoCount])).toEqual([['a', 37], ['b', undefined], ['c', undefined], ['d', undefined], ['e', undefined], ['f', undefined], ['g', undefined]]);
  });
  it('an older reader’s view: the field is extra and changes nothing else', () => {
    const d = readDirectory(dir([entry('a', { xo_count: 37, nostr_pubkey: 'b'.repeat(64) })]), null, { now: NOW, keys: KEYS })!;
    expect(d.entries[0]).toEqual({ handle: 'a', address: A, verifiedAt: '2025-12-23T14:12:18.787Z', pubkey: 'b'.repeat(64), xoCount: 37 });
  });
  it('the badge carries it from xmr.bio only', () => {
    const d = readDirectory(dir([entry('a', { xo_count: 37 })]), null, { now: NOW, keys: KEYS })!;
    const fromDir = directoryIndex(d)('A');
    expect(xoCountOf(mergeBadge('a', fromDir))).toBe(37);
    const nostrOnly = mergeBadge('a', [{ source: 'nostr', address: A, check: validateMoneroAddress(A), verified: true, method: 'nip39:x', xoCount: 99 }]);
    expect(xoCountOf(nostrOnly)).toBe(0);
    expect(xoCountOf(null)).toBe(0);
  });
  it('the switch is on unless turned off', () => {
    expect(xoRingsOn({})).toBe(true);
    expect(xoRingsOn({ xoRings: false })).toBe(false);
  });
});

describe('the badge with a count', () => {
  it('shows ɱ❤ N and says it in its label', () => {
    const b = buildBadge(document, badgeLook(null), 'alice', 37);
    expect(b.textContent).toContain('ɱ❤ 37');
    expect(b.getAttribute('aria-label')).toBe('Accepts Monero — tip @alice. 37 xos from Monero people (counted by xmr.bio, every 10 minutes)');
    // the round look is a 16 px circle: the total goes in the label only
    const round = buildBadge(document, badgeLook({ badgeIcon: 'mono', badgeLabel: false }), 'alice', 37);
    expect(round.textContent).not.toContain('ɱ❤');
    expect(round.getAttribute('aria-label')).toContain('37 xos');
    const none = buildBadge(document, badgeLook(null), 'alice', 0);
    expect(none.textContent).not.toContain('ɱ❤');
    expect(none.getAttribute('aria-label')).toBe('Accepts Monero — tip @alice');
  });
});

describe('the ring', () => {
  const rect = (el: Element, r: { left: number; top: number; width: number; height: number }) =>
    (el.getBoundingClientRect = () => ({ ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => r }) as DOMRect);
  function post(clip = false) {
    document.body.innerHTML = `<main data-testid="primaryColumn"><article data-testid="tweet"><div id="cell"><div id="wrap" style="${clip ? 'overflow:hidden' : ''}"><div data-testid="Tweet-User-Avatar"><img style="border-radius:9999px"></div></div></div></article></main>
      <nav><article data-testid="tweet"><div><div data-testid="Tweet-User-Avatar"></div></div></article></nav>`;
    const article = document.querySelector('main article')!;
    const av = postAvatar(article)!;
    rect(av, { left: 110, top: 210, width: 40, height: 40 });
    rect(document.getElementById('wrap')!, { left: 100, top: 200, width: 60, height: 60 });
    rect(document.getElementById('cell')!, { left: 90, top: 190, width: 80, height: 80 });
    return { article, av };
  }
  it('sits 2 px outside the avatar, on a parent that doesn’t clip, without restyling the avatar', () => {
    const { av } = post();
    setRing(av, 'k1', 3);
    const ring = document.querySelector<HTMLElement>(`[${RING_ATTR}]`)!;
    expect(ring.parentElement!.id).toBe('wrap');
    expect([ring.style.left, ring.style.top, ring.style.width, ring.style.height]).toEqual(['6px', '6px', '48px', '48px']);
    expect(ring.style.pointerEvents).toBe('none');
    expect(ring.getAttribute('aria-hidden')).toBe('true');
    expect(av.getAttribute('style')).toBeNull();
  });
  it('skips a clipping parent for the next one up', () => {
    const { av } = post(true);
    expect(ringHost(av)!.id).toBe('cell');
    setRing(av, 'k1', 3);
    expect(document.querySelector(`[${RING_ATTR}]`)!.parentElement!.id).toBe('cell');
  });
  it('one per avatar; redrawn for another key; gone at count 0', () => {
    const { av } = post();
    setRing(av, 'k1', 3);
    setRing(av, 'k1', 3);
    expect(document.querySelectorAll(`[${RING_ATTR}]`).length).toBe(1);
    setRing(av, 'k2', 3);
    expect(document.querySelector(`[${RING_ATTR}]`)!.getAttribute(RING_ATTR)).toBe('k2');
    setRing(av, 'k2', 0);
    expect(document.querySelectorAll(`[${RING_ATTR}]`).length).toBe(0);
  });
  it('follows its avatar on later passes, with the same key', () => {
    const { av } = post();
    setRing(av, 'k1', 3);
    rect(av, { left: 120, top: 230, width: 40, height: 40 });
    setRing(av, 'k1', 3);
    const ring = document.querySelector<HTMLElement>(`[${RING_ATTR}]`)!;
    expect([ring.style.left, ring.style.top]).toEqual(['16px', '26px']);
  });
  it('a ring on a shared parent is never taken for another avatar’s', () => {
    document.body.innerHTML = `<main data-testid="primaryColumn"><div id="shared"><div><div data-testid="Tweet-User-Avatar" id="a1"></div></div><div><div data-testid="Tweet-User-Avatar" id="a2"></div></div></div></main>`;
    const a1 = document.getElementById('a1')!;
    const a2 = document.getElementById('a2')!;
    rect(a1, { left: 10, top: 10, width: 40, height: 40 });
    rect(a2, { left: 10, top: 80, width: 40, height: 40 });
    for (const el of document.querySelectorAll('#shared, #shared > div')) rect(el, { left: 0, top: 0, width: 100, height: 200 });
    setRing(a1, 'k1', 3);
    setRing(a2, 'k2', 3);
    setRing(a1, 'k1', 3);
    expect([...document.querySelectorAll(`[${RING_ATTR}]`)].map((r) => r.getAttribute(RING_ATTR)).sort()).toEqual(['k1', 'k2']);
    setRing(a2, 'k2', 0);
    expect([...document.querySelectorAll(`[${RING_ATTR}]`)].map((r) => r.getAttribute(RING_ATTR))).toEqual(['k1']);
  });
  it('a parent it made relative is put back when its ring goes', () => {
    const { av } = post();
    setRing(av, 'k1', 3);
    const host = document.getElementById('wrap')!;
    expect(host.style.position).toBe('relative');
    setRing(av, 'k1', 0);
    expect(host.style.position).toBe('');
  });
  it('only avatars in the main column', () => {
    post();
    expect(postAvatar(document.querySelector('nav article')!)).toBeNull();
  });
  it('finds the profile header avatar by its handle, as X marks it up (beside the /photo link)', () => {
    document.body.innerHTML = `<div data-testid="primaryColumn"><a href="/XBToshi/photo"></a><div data-testid="UserAvatar-Container-XBToshi" id="big"></div>
      <article data-testid="tweet"><div data-testid="UserAvatar-Container-XBToshi" id="inpost"></div></article><div data-testid="UserAvatar-Container-unknown"></div></div>
      <div data-testid="UserAvatar-Container-XBToshi" id="outside"></div>`;
    expect(profileAvatar(document, 'xbtoshi')?.id).toBe('big');
    expect(profileAvatar(document, 'bob')).toBeNull();
  });
});
