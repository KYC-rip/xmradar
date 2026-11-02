import { describe, expect, it } from 'vitest';
import { MAX_THREAD, authorOf, combineThread, loadThread, placeImages, withoutMarkers, xThread } from '../src/extractors/x-thread';
import { makeDoc } from './helpers';

const tweet = (id: string, text: string, opts: { by?: string; extra?: string; cut?: boolean } = {}) =>
  `<article data-testid="tweet" id="t${id}"><div data-testid="User-Name"><a href="/${opts.by ?? 'XBToshi'}">name</a></div>` +
  `<div data-testid="tweetText">${text}</div>${opts.cut ? '<button data-testid="tweet-text-show-more-link">Show more</button>' : ''}` +
  `${opts.extra ?? ''}<a href="/${opts.by ?? 'XBToshi'}/status/${id}"><time>1h</time></a></article>`;
const cell = (inner = '') => `<div data-testid="cellInnerDiv">${inner}</div>`;
const img = (n: string) => `<div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/${n}?format=jpg&name=small"></div>`;

// the live layout: the opened tweet, the reply box's empty cell, the author's continuation, then others
const thread = (cells: string[], path = '/XBToshi/status/1') => makeDoc(`https://x.com${path}`, `<section><div>${cells.join('')}</div></section>`);
const five = [
  cell(tweet('1', 'one', { extra: img('a') })),
  cell(),
  cell(tweet('2', 'two', { extra: img('b') })),
  cell(tweet('3', 'three')),
  cell(tweet('4', 'four')),
  cell(tweet('5', 'five', { extra: img('c') })),
  cell(tweet('6', 'a reply', { by: 'someone' })),
];
const ids = (els: Element[] | undefined) => els?.map((e) => e.id);
const no = () => false;

describe('xThread', () => {
  it('finds the thread from its first, a middle and its last tweet', () => {
    const doc = thread(five);
    for (const id of ['t1', 't3', 't5']) expect(ids(xThread(doc.getElementById(id), doc, no)?.tweets)).toEqual(['t1', 't2', 't3', 't4', 't5']);
  });
  it('takes the earlier tweets above a tweet opened mid-thread', () => {
    const doc = thread([cell('<h2>Conversation</h2>'), cell(tweet('1', 'one')), cell(tweet('2', 'two')), cell(), cell(tweet('3', 'three')), cell(tweet('9', 'x', { by: 'b' }))], '/XBToshi/status/2');
    expect(ids(xThread(doc.getElementById('t2'), doc, no)?.tweets)).toEqual(['t1', 't2', 't3']);
  });
  it('stops at another author, a promoted tweet, or a cell with text', () => {
    for (const stop of [cell(tweet('9', 'x', { by: 'other' })), cell(`<div data-testid="placementTracking">${tweet('9', 'ad')}</div>`), cell('Show replies')]) {
      const doc = thread([cell(tweet('1', 'one')), cell(tweet('2', 'two')), stop, cell(tweet('3', 'three'))]);
      expect(ids(xThread(doc.getElementById('t1'), doc, no)?.tweets)).toEqual(['t1', 't2']);
    }
  });
  it("doesn't count a quoted tweet's author", () => {
    const quoted = `<div role="link"><div data-testid="User-Name"><a href="/XBToshi">me</a></div></div>`;
    const a = makeDoc('https://x.com/h', tweet('1', 'x', { by: 'other', extra: quoted })).getElementById('t1')!;
    expect(authorOf(a)).toBe('other');
    const doc = thread([cell(tweet('1', 'one')), cell(tweet('2', 'quoting me', { by: 'other', extra: quoted }))]);
    expect(xThread(doc.getElementById('t1'), doc, no)).toBeNull();
  });
  it('is null for a single tweet and off a tweet page', () => {
    const doc = thread([cell(tweet('1', 'one')), cell(), cell(tweet('6', 'r', { by: 'b' }))]);
    expect(xThread(doc.getElementById('t1'), doc, no)).toBeNull();
    const home = thread(five, '/home');
    expect(xThread(home.getElementById('t1'), home, no)).toBeNull();
  });
  it('may continue when X draws the line on below the last tweet, or at the cap', () => {
    const doc = thread(five.slice(0, 6));
    expect(xThread(doc.getElementById('t1'), doc, no)?.mayContinue).toBe(false);
    expect(xThread(doc.getElementById('t1'), doc, (a) => a.id === 't5')?.mayContinue).toBe(true);
    const long = thread(Array.from({ length: MAX_THREAD + 5 }, (_, i) => cell(tweet(String(i + 1), `n${i + 1}`))));
    const t = xThread(long.getElementById('t1'), long, no)!;
    expect(t.tweets).toHaveLength(MAX_THREAD);
    expect(t).toMatchObject({ mayContinue: true, capped: true });
    // opened at the end: the 50 before it, and said so
    const last = xThread(long.getElementById(`t${MAX_THREAD + 5}`), long, no)!;
    expect(last.tweets).toHaveLength(MAX_THREAD);
    expect(last.tweets[0]!.id).toBe('t6');
    expect(last.capped).toBe(true);
    expect(xThread(long.getElementById('t30'), long, no)?.capped).toBe(true);
  });
});

describe('combineThread', () => {
  it('joins texts by a blank line, skips empty ones, marks each image under its tweet, keeps the first link', () => {
    const doc = makeDoc('https://x.com/XBToshi/status/1', '');
    const p = (n: string, text: string, images: string[] = [], articleCard?: boolean) => ({
      site: 'x',
      text,
      images: images.map((url) => ({ url })),
      sourceUrl: `https://x.com/XBToshi/status/${n}`,
      ...(articleCard ? { articleCard } : {}),
    });
    expect(combineThread([p('1', ' one\n', ['a']), p('2', '  '), p('3', 'three', ['b', 'c']), p('4', '', ['d'])], doc)).toEqual({
      site: 'x',
      text: 'one\n[🖼 1]\n\nthree\n[🖼 2]\n[🖼 3]\n\n[🖼 4]',
      images: [{ url: 'a' }, { url: 'b' }, { url: 'c' }, { url: 'd' }],
      sourceUrl: 'https://x.com/XBToshi/status/1',
      inlineImages: true,
    });
    const plain = combineThread([p('1', 'a'), p('2', 'b', [], true)], doc);
    expect(plain.articleCard).toBe(true);
    expect(plain.inlineImages).toBeUndefined();
  });
  it('keeps the images at the end when a tweet already has a marker of its own', () => {
    const doc = makeDoc('https://x.com/XBToshi/status/1', '');
    const p = (text: string, images: string[]) => ({ site: 'x', text, images: images.map((url) => ({ url })), sourceUrl: 'https://x.com/XBToshi/status/1' });
    const t = combineThread([p('see [🖼 1] here', ['a']), p('two', ['b'])], doc);
    expect(t.text).toBe('see [🖼 1] here\n\ntwo');
    expect(t.inlineImages).toBeUndefined();
  });
});

describe('placeImages', () => {
  it('puts each ticked image where its marker is and drops an unticked one with its line', () => {
    expect(placeImages('one\n[🖼 1]\n\ntwo\n[🖼 2]\n[🖼 3]\n\nthree', ['https://b/1', null, 'https://b/3'])).toEqual({
      text: 'one\nhttps://b/1\n\ntwo\nhttps://b/3\n\nthree',
      placed: ['https://b/1', 'https://b/3'],
    });
    // an unticked last image takes no trailing blank line with it
    expect(placeImages('one\n[🖼 1]', [null]).text).toBe('one');
  });
  it("leaves a marker with no such image as the user's text, and moved markers work inline", () => {
    expect(placeImages('see [🖼 9] and [🖼 0]; here [🖼 1] too', ['https://b/1'])).toEqual({ text: 'see [🖼 9] and [🖼 0]; here https://b/1 too', placed: ['https://b/1'] });
  });
  it('reports nothing placed for a deleted marker, so the image is appended', () => {
    expect(placeImages('one', ['https://b/1'])).toEqual({ text: 'one', placed: [] });
  });
  it('strips markers for tag suggestions', () => {
    expect(withoutMarkers('a\n[🖼 1]\nb')).toBe('a\n\nb');
  });
});

describe('loadThread', () => {
  it('extracts the whole thread with its images', async () => {
    const doc = thread(five);
    const t = (await loadThread(doc.getElementById('t3'), doc, no))!;
    expect(t.post.text).toBe('one\n[🖼 1]\n\ntwo\n[🖼 2]\n\nthree\n\nfour\n\nfive\n[🖼 3]');
    expect(t.post.images.map((i) => i.url)).toEqual(['a', 'b', 'c'].map((n) => `https://pbs.twimg.com/media/${n}?format=jpg&name=orig`));
    expect(t.post.sourceUrl).toBe('https://x.com/XBToshi/status/1');
    expect(t).toMatchObject({ count: 5, mayContinue: false, capped: false, cut: [] });
  });
  it("opens a cut tweet's Show more, also when X redraws it, and reports one that stays cut", async () => {
    const doc = thread([cell(tweet('1', 'one')), cell(tweet('2', 'two', { cut: true })), cell(tweet('3', 'three', { cut: true }))]);
    // tweet 2 is redrawn whole on click; tweet 3's button does nothing
    doc.querySelector('#t2 button')!.addEventListener('click', () => {
      doc.getElementById('t2')!.closest('[data-testid="cellInnerDiv"]')!.innerHTML = tweet('2', 'two, and the rest of it');
    });
    const t = (await loadThread(doc.getElementById('t1'), doc, no))!;
    expect(t.post.text).toBe('one\n\ntwo, and the rest of it\n\nthree');
    expect(t.cut).toEqual([3]);
  }, 10_000);
  it('is null without a thread', async () => {
    const doc = thread([cell(tweet('1', 'one'))]);
    expect(await loadThread(doc.getElementById('t1'), doc, no)).toBeNull();
  });
});
