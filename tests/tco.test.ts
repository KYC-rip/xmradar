import { describe, expect, it } from 'vitest';
import { expandTco, resolveTco, tcoCodes, tcoDestination } from '../src/extractors/tco';
import { xExtractor } from '../src/extractors/x';

const PAGE = (url: string) =>
  `<head><noscript><META http-equiv="refresh" content="0;URL=${url}"></noscript><title>${url}</title></head><script>window.opener = null; location.replace("${url.replace(/\//g, '\\/')}")</script>`;

describe("t.co's own page", () => {
  it('the destination from the refresh and the title', () => {
    expect(tcoDestination(PAGE('https://xmr.club/hosting/vps'))).toBe('https://xmr.club/hosting/vps');
    expect(tcoDestination('<title>https://a.example/x?y=1&amp;z=2</title>')).toBe('https://a.example/x?y=1&z=2');
    expect(tcoDestination('<title>https://a.example/it&#x27;s&#38;x</title>')).toBe("https://a.example/it's&x");
  });
  it('nothing when they disagree, point back at t.co, or are not web links', () => {
    expect(tcoDestination('<meta http-equiv="refresh" content="0;URL=https://a.example/"><title>https://b.example/</title>')).toBeNull();
    expect(tcoDestination(PAGE('https://t.co/abcd1234'))).toBeNull();
    expect(tcoDestination(PAGE('javascript:alert(1)'))).toBeNull();
    expect(tcoDestination('<title>X</title>')).toBeNull();
  });
  it('asked with redirects off and no cookies; a redirect answer or failure is null', async () => {
    let init: RequestInit | undefined;
    const ok = (async (_u: string, i?: RequestInit) => ((init = i), new Response(PAGE('https://xmr.club/')))) as typeof fetch;
    expect(await resolveTco('tEdOVD5Eme', ok)).toBe('https://xmr.club/');
    expect(init).toMatchObject({ redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer' });
    const redirected = (async () => ({ ok: false, type: 'opaqueredirect', status: 0, headers: new Headers() }) as unknown as Response) as typeof fetch;
    expect(await resolveTco('tEdOVD5Eme', redirected)).toBeNull();
    expect(await resolveTco('tEdOVD5Eme', (async () => Promise.reject(new Error('net'))) as typeof fetch)).toBeNull();
    expect(await resolveTco('../evil', ok)).toBeNull();
    // a body far past the cap, with no length stated: read only as far as needed
    const big = (async () => new Response(PAGE('https://xmr.club/') + 'x'.repeat(1_000_000))) as typeof fetch;
    expect(await resolveTco('tEdOVD5Eme', big)).toBe('https://xmr.club/');
  });
});

describe('links in the text', () => {
  it('codes once each, at most ten', () => {
    expect(tcoCodes('a https://t.co/abcd1 b https://t.co/abcd1 https://t.co/efgh2')).toEqual(['abcd1', 'efgh2']);
    expect(tcoCodes(Array.from({ length: 12 }, (_, i) => `https://t.co/code${i}`).join(' '))).toHaveLength(10);
  });
  it('a found link becomes its destination; one not found stays', () => {
    expect(expandTco('Read\n\nhttps://t.co/abcd1\nhttps://t.co/efgh2', { abcd1: 'https://xmr.club/vps', efgh2: null })).toBe('Read\n\nhttps://xmr.club/vps\nhttps://t.co/efgh2');
  });
  it('a card link already written out in the text goes, with its line', () => {
    expect(expandTco('See https://xmr.club/vps\n\nhttps://t.co/abcd1', { abcd1: 'https://xmr.club/vps' })).toBe('See https://xmr.club/vps');
    expect(expandTco('See https://xmr.club/vps.\n\nhttps://t.co/abcd1', { abcd1: 'https://xmr.club/vps' })).toBe('See https://xmr.club/vps.');
  });
  it('compared whole, and two links to one place give it once', () => {
    expect(expandTco('Home https://xmr.club\n\nhttps://t.co/abcd1', { abcd1: 'https://xmr.club/vps' })).toBe('Home https://xmr.club\n\nhttps://xmr.club/vps');
    expect(expandTco('Home https://xmr.club\nhttps://t.co/abcd1', { abcd1: 'https://xmr.club/' })).toBe('Home https://xmr.club');
    expect(expandTco('a https://t.co/abcd1\nhttps://t.co/efgh2', { abcd1: 'https://xmr.club/', efgh2: 'https://xmr.club/' })).toBe('a https://xmr.club/');
  });
});

describe('a tweet with a link card', () => {
  const tweet = (text: string, card: string) => {
    document.body.innerHTML = `<article data-testid="tweet"><a href="/xmr_club/status/77"><time>1h</time></a>
      <div data-testid="tweetText">${text}</div>${card}</article>`;
    return xExtractor.extract(document.querySelector('article')!, document)!;
  };
  const CARD = (href: string) => `<div data-testid="card.wrapper"><div data-testid="card.layoutLarge.media"><a href="${href}" aria-label="xmr.club VPS">VPS · xmr.club</a></div></div>`;
  it("the card's t.co link after the text", () => {
    expect(tweet('Want a VPS?', CARD('https://t.co/tEdOVD5Eme')).text).toBe('Want a VPS?\n\nhttps://t.co/tEdOVD5Eme');
    expect(tweet('', CARD('https://t.co/tEdOVD5Eme')).text).toBe('https://t.co/tEdOVD5Eme');
  });
  it("not a quoted tweet's card, nor a link that isn't t.co", () => {
    expect(tweet('Mine', `<div role="link">${CARD('https://t.co/quoted12')}</div>`).text).toBe('Mine');
    expect(tweet('Mine', CARD('https://evil.example/x')).text).toBe('Mine');
  });
});
