import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.hoisted(() => vi.fn());
vi.mock('../src/messaging', async (orig) => ({ ...(await orig<typeof import('../src/messaging')>()), sendToBackground: send }));

import { insertXo, publicCount, XO_SELECTOR, xoManager } from '../src/entrypoints/content/x-xo';
import { directoryIndex, readDirectory, readXoPosts, XO_POST_CAP } from '../src/identity/directory';
import { mergeBadge, xoPostsOf } from '../src/identity/resolve';

// PLAN-XOPOSTS
const P = (n: number) => `f${n.toString(16).padStart(15, '0')}`;
const ME = P(999);
const AUTHOR = 'a'.repeat(64);

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

describe('xo_posts in the directory', () => {
  it('keeps good posts and drops bad ones, never the entry', () => {
    const many = Array.from({ length: XO_POST_CAP + 1 }, (_, i) => P(i));
    expect(
      readXoPosts({
        '123': [P(1), P(2)],
        '0123': [P(1)], // not a canonical id
        abc: [P(1)],
        '124': [P(1), P(1)], // a duplicate
        '125': ['short'],
        '126': [P(1).toUpperCase()],
        '127': [],
        '128': many,
        '129': 'x',
      }),
    ).toEqual({ '123': [P(1), P(2)] });
    expect(readXoPosts(null)).toBeUndefined();
    expect(readXoPosts([])).toBeUndefined();
    expect(readXoPosts({ '1': [P(1)] })).toEqual({ '1': [P(1)] });
  });
  it('at most 50 posts an entry', () => {
    const posts = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [String(1000 + i), [P(1)]]));
    expect(Object.keys(readXoPosts(posts)!).length).toBe(50);
  });
  it('a badge carries it from xmr.bio only, and finds a post’s list', () => {
    const d = readDirectory(dir([entry('a', { xo_count: 3, xo_posts: { '77': [P(1), P(2)], bad: [P(3)] } })]), null, { now: NOW, keys: KEYS })!;
    expect(d.entries[0]!.xoPosts).toEqual({ '77': [P(1), P(2)] });
    const badge = mergeBadge('a', directoryIndex(d)('a'));
    expect(xoPostsOf(badge, '77')).toEqual([P(1), P(2)]);
    expect(xoPostsOf(badge, '78')).toEqual([]);
    expect(xoPostsOf(null, '77')).toEqual([]);
  });
  it('the field changes nothing else in an entry (older readers skip unknown fields the same way)', () => {
    const d = readDirectory(dir([entry('a', { xo_posts: { '77': [P(1)] } })]), null, { now: NOW, keys: KEYS })!;
    const { xoPosts, ...rest } = d.entries[0]!;
    expect(xoPosts).toEqual({ '77': [P(1)] });
    expect(rest).toEqual({ handle: 'a', address: A, verifiedAt: '2025-12-23T14:12:18.787Z' });
  });
  it('the shared vectors’ directory section reads as expected', () => {
    const v = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/xo-vectors-v1.json'), 'utf8')) as { directory_xo_posts?: { input: unknown; expected: unknown }[] };
    for (const c of v.directory_xo_posts ?? []) expect(readXoPosts(c.input) ?? null, (c as { name?: string }).name).toEqual(c.expected);
    expect(v.directory_xo_posts?.length).toBeGreaterThan(0);
  });
});

describe('the count on others’ posts', () => {
  it.each([
    // list, me, sent → shown, text
    [[P(1), P(2)], ME, false, 2, '2'],
    [[P(1), P(2)], ME, true, 3, '3'],
    [[P(1), ME], ME, true, 2, '2'],
    [[P(1), ME], ME, false, 1, '1'], // taken back: gone at once, before xmr.bio's next build
    [[P(1), ME], undefined, false, 2, '2'],
    [[], ME, true, 1, '1'],
    [[], ME, false, 0, ''],
    [[P(1), ME], undefined, true, 2, '2'], // no key yet: never counted twice
  ] as const)('%j me=%s sent=%s → %s', (list, me, sent, shown, text) => {
    expect(publicCount([...list], me, sent)).toMatchObject({ shown, text });
  });
  it('a full list reads 200+, whatever the user’s own xo does', () => {
    const full = Array.from({ length: XO_POST_CAP }, (_, i) => P(i));
    const withMe = [...full.slice(1), ME];
    for (const [list, sent] of [[full, false], [full, true], [withMe, false], [withMe, true]] as const) expect(publicCount([...list], ME, sent).text).toBe('200+');
  });
});

function tweet() {
  document.body.innerHTML = `<article data-testid="tweet"><a href="/bob/status/123"><time>1h</time></a><div role="group">
    <div><button data-testid="reply"><div><svg></svg><span>3</span></div></button></div>
    <div><button data-testid="like"><svg></svg></button></div>
    <div data-xmradar="xap"><button type="button"><div><div></div><svg data-xmradar="xap-icon"></svg><span data-xmradar="xap-count"></span></div></button></div>
    <div><button aria-haspopup="menu"><svg></svg></button></div>
  </div></article>`;
  return document.querySelector('article')!;
}
const click = (el: Element) => {
  const e = new MouseEvent('click', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'isTrusted', { value: true });
  el.dispatchEvent(e);
};
const countOf = (a: Element) => a.querySelector(`${XO_SELECTOR} [data-xmradar="xo-count"]`)!.textContent;
const labelOf = (a: Element) => a.querySelector(`${XO_SELECTOR} button`)!.getAttribute('aria-label');
const fill = (a: Element) => a.querySelector(`${XO_SELECTOR} svg path`)!.getAttribute('fill');

describe('the xo button with xmr.bio’s count', () => {
  beforeEach(() => send.mockReset());
  const base = { post: '123', author: AUTHOR, handle: 'bob', own: false, sent: false, myKey: ME };

  it('shows the count and says it; the heart stays outline until the user sends one', () => {
    const a = tweet();
    insertXo(a, { ...base, public: [P(1), P(2)] });
    expect(countOf(a)).toBe('2');
    expect(fill(a)).toBe('none');
    expect(labelOf(a)).toBe('2 Monero people sent xos (counted by xmr.bio). Click: xo · Hold: xo + like on X');
  });
  it('the user alone: a send shows 1 and fills the heart', async () => {
    send.mockResolvedValue({ ok: true, id: 'x' });
    const a = tweet();
    insertXo(a, { ...base, public: [] });
    const wrap = a.querySelector<HTMLElement>(XO_SELECTOR)!;
    click(wrap.querySelector('button')!);
    expect(countOf(a)).toBe('1');
    expect(fill(a)).toBe('#f26822');
    await vi.waitFor(() => expect(wrap.dataset.busy).toBeUndefined());
  });
  it('one person, singular; handle-only authors keep the waiting sentence', () => {
    const a = tweet();
    insertXo(a, { ...base, author: null, public: [P(1)] });
    expect(labelOf(a)).toBe('1 Monero person sent an xo (counted by xmr.bio). Your xo waits for @bob to set up XMRadar. Click: xo · Hold: xo + like on X');
  });
  it('no count: today’s labels exactly', () => {
    const a = tweet();
    insertXo(a, { ...base, public: [] });
    expect(countOf(a)).toBe('');
    expect(labelOf(a)).toBe('Send @bob an xo (a Monero like, over Nostr). Click: xo · Hold: xo + like on X');
  });
  it('a send adds the user at once, an undo takes them off, and the list stays through both', async () => {
    send.mockResolvedValue({ ok: true, id: 'x' });
    const a = tweet();
    insertXo(a, { ...base, public: [P(1), P(2)] });
    const wrap = a.querySelector<HTMLElement>(XO_SELECTOR)!;
    click(wrap.querySelector('button')!);
    expect(countOf(a)).toBe('3');
    expect(fill(a)).toBe('#f26822');
    expect(labelOf(a)).toBe('You and 2 Monero people sent xos (counted by xmr.bio). Click to take yours back.');
    await vi.waitFor(() => expect(wrap.dataset.busy).toBeUndefined());
    click(wrap.querySelector('button')!);
    await vi.waitFor(() => expect(wrap.dataset.busy).toBeUndefined());
    expect(countOf(a)).toBe('2');
  });
  it('the manager keeps each post’s list across updates, follows a new list and the user’s key', () => {
    const a = tweet();
    const m = xoManager({ on: true, me: null, sent: {}, counts: {}, seen: {} }, () => {});
    m.place(a, '123', AUTHOR, 'bob', [P(1), ME]);
    expect(countOf(a)).toBe('2'); // key not known yet: xmr.bio's list as it is
    m.update({ myKey: ME });
    expect(countOf(a)).toBe('1');
    m.update({ sent: { '123': { id: 'x', at: 1 } } });
    expect(countOf(a)).toBe('2');
    m.update({ sent: {} });
    expect(countOf(a)).toBe('1');
    // the next directory: a third person
    m.place(a, '123', AUTHOR, 'bob', [P(1), P(2), ME]);
    expect(countOf(a)).toBe('2');
    // switched off: x-badges passes []
    m.place(a, '123', AUTHOR, 'bob', []);
    expect(countOf(a)).toBe('');
  });
  it('own posts keep the inbox count, not xmr.bio’s', () => {
    const a = tweet();
    const m = xoManager({ on: true, me: { handle: 'bob', proven: true }, sent: {}, counts: { '123': 5 }, seen: {} }, () => {});
    m.place(a, '123', AUTHOR, 'bob', [P(1)]);
    expect(countOf(a)).toBe('5');
  });
});
