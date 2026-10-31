import { afterEach, describe, expect, it, vi } from 'vitest';
import { composerKey } from '../src/entrypoints/content/composer-key';
import { autoCloser, autoCloses } from '../src/entrypoints/content/publish-pill';
import { makeDoc } from './helpers';

const tweet = (user: string, id: string) =>
  `<article data-testid="tweet"><a href="/${user}/status/${id}"><time datetime="2026-10-31T10:00:00Z">1h</time></a><div data-testid="tweetText">hello ${id}</div><img src="https://pbs.twimg.com/media/A${id}.jpg?format=jpg&name=small"></article>`;
const inTweet = (doc: Document, n = 0) => doc.querySelectorAll('[data-testid="tweetText"]')[n]!;

describe('composerKey (PLAN-PARALLEL §1)', () => {
  it('a tweet is its status id, on x.com and twitter.com, with tracking or a trailing slash', async () => {
    const keys = await Promise.all(
      ['https://x.com/home', 'https://twitter.com/home', 'https://x.com/alice/status/111?s=20&t=abc', 'https://x.com/alice/status/111/'].map((u) => {
        const doc = makeDoc(u, tweet('alice', '111'));
        return composerKey(inTweet(doc), {}, doc);
      }),
    );
    expect(new Set(keys)).toEqual(new Set(['x:111']));
  });
  it('two tweets are two copies', async () => {
    const doc = makeDoc('https://x.com/home', tweet('alice', '111') + tweet('bob', '222'));
    expect(await composerKey(inTweet(doc, 0), {}, doc)).toBe('x:111');
    expect(await composerKey(inTweet(doc, 1), {}, doc)).toBe('x:222');
  });
  it('a selection or an image inside a tweet is its own copy, not the tweet', async () => {
    const doc = makeDoc('https://x.com/home', tweet('alice', '111'));
    const sel = await composerKey(inTweet(doc), { selection: 'hello' }, doc);
    const img = await composerKey(inTweet(doc), { srcUrl: 'https://pbs.twimg.com/media/A111.jpg?format=jpg&name=small' }, doc);
    expect(sel).toMatch(/^sel:https:\/\/x\.com\/home:[0-9a-f]{64}$/);
    expect(img).toBe('img:https://pbs.twimg.com/media/A111.jpg');
    expect(new Set([sel, img, 'x:111']).size).toBe(3);
  });
  it('a selection: the same words on two pages are two copies; one character apart, two keys', async () => {
    const a = makeDoc('https://example.org/a', '<p>x</p>');
    const b = makeDoc('https://example.org/b', '<p>x</p>');
    expect(await composerKey(null, { selection: ' same words ' }, a)).not.toBe(await composerKey(null, { selection: 'same words' }, b));
    expect(await composerKey(null, { selection: 'same words' }, a)).toBe(await composerKey(null, { selection: ' same words ' }, a));
    expect(await composerKey(null, { selection: 'same words' }, a)).not.toBe(await composerKey(null, { selection: 'same wordz' }, a));
  });
  it('an image with and without its query is one copy; a page without a post is its address', async () => {
    const doc = makeDoc('https://example.org/post?ref=1#c', '<p>x</p>');
    expect(await composerKey(null, { srcUrl: 'https://cdn.example/i.png?w=10' }, doc)).toBe(await composerKey(null, { srcUrl: 'https://cdn.example/i.png' }, doc));
    expect(await composerKey(null, {}, doc)).toBe('page:https://example.org/post');
  });
});

describe('composerKey on other sites and without Web Crypto', () => {
  const toot = (id: string) =>
    `<div class="status"><div class="status__content"><p>toot ${id}</p></div><a class="status__relative-time" href="https://mastodon.social/@alice/${id}">1h</a></div>`;
  it('two posts in a Mastodon timeline are two copies, keyed by their own addresses', async () => {
    const doc = makeDoc('https://mastodon.social/home', toot('111') + toot('222'), '<meta name="generator" content="Mastodon v4">');
    const [a, b] = [...doc.querySelectorAll('.status__content')];
    expect(await composerKey(a!, {}, doc)).toBe('post:https://mastodon.social/@alice/111');
    expect(await composerKey(b!, {}, doc)).toBe('post:https://mastodon.social/@alice/222');
  });
  it('a page with no recognised post stays one copy', async () => {
    const doc = makeDoc('https://example.org/article?x=1', '<main><p>words</p></main>');
    expect(await composerKey(doc.querySelector('p'), {}, doc)).toBe('page:https://example.org/article');
  });
  it('without Web Crypto (plain http) selections still get their own keys', async () => {
    const subtle = vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(new Error('insecure context'));
    const doc = makeDoc('http://example.org/a', '<p>x</p>');
    const one = await composerKey(null, { selection: 'first words' }, doc);
    const two = await composerKey(null, { selection: 'second words' }, doc);
    expect(one).toMatch(/^sel:http:\/\/example\.org\/a:f[0-9a-f]{32}$/);
    expect(one).not.toBe(two);
    expect(await composerKey(null, { selection: 'first words' }, doc)).toBe(one);
    subtle.mockRestore();
  });
});

describe('auto-close after publishing', () => {
  const pub = (results: { relay: string; ok: boolean; message: string }[]) => ({ kind: 'published' as const, results, link: { href: 'x', label: 'x' }, ref: 'r', copyLabel: 'c' });
  it('only when published with nothing left to retry', () => {
    expect(autoCloses(pub([{ relay: 'wss://a', ok: true, message: '' }]))).toBe(true);
    expect(autoCloses(pub([{ relay: 'wss://a', ok: true, message: '' }, { relay: 'wss://b', ok: false, message: 'timeout' }]))).toBe(false);
    expect(autoCloses({ kind: 'publishing' })).toBe(false);
    expect(autoCloses({ kind: 'draft' })).toBe(false);
    expect(autoCloses({ kind: 'rejected', results: [] })).toBe(false);
  });
  afterEach(() => vi.useRealTimers());
  it('the timer: closes 10 s after a clean publish, restarts on a new state, stops when cancelled', () => {
    vi.useFakeTimers();
    const close = vi.fn();
    const t = autoCloser(10_000, close);
    t.arm(pub([{ relay: 'wss://a', ok: true, message: '' }]));
    vi.advanceTimersByTime(9_999);
    expect(close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(close).toHaveBeenCalledTimes(1);
    // a failed relay to retry: no timer
    t.arm(pub([{ relay: 'wss://b', ok: false, message: 'timeout' }]));
    vi.advanceTimersByTime(20_000);
    expect(close).toHaveBeenCalledTimes(1);
    // expanding cancels; minimising arms it again from zero
    t.arm(pub([{ relay: 'wss://a', ok: true, message: '' }]));
    vi.advanceTimersByTime(5_000);
    t.cancel();
    vi.advanceTimersByTime(20_000);
    expect(close).toHaveBeenCalledTimes(1);
    t.arm(pub([{ relay: 'wss://a', ok: true, message: '' }]));
    vi.advanceTimersByTime(10_000);
    expect(close).toHaveBeenCalledTimes(2);
    // a retry starting replaces the timer
    t.arm(pub([{ relay: 'wss://a', ok: true, message: '' }]));
    t.arm({ kind: 'retrying', count: 1 });
    vi.advanceTimersByTime(20_000);
    expect(close).toHaveBeenCalledTimes(2);
  });
});
