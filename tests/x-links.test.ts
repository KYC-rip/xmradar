// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { onCopy, startCopyLinks } from '../src/entrypoints/content/x-copy-links';
import { cleanXLinks, cleanXUrl } from '../src/extractors/x-links';

const POST = 'https://x.com/itsriyapal/status/2116134840290676882';

describe('cleanXUrl', () => {
  it.each([
    [`${POST}?a=Zp7IdPNtAYNhmLPhasc&s=20`, POST],
    [`${POST}?s=46&t=AbCdEf`, POST],
    [`${POST}/?s=20`, `${POST}/`],
    [`${POST}/photo/1?s=20`, `${POST}/photo/1`],
    [`${POST}/video/2?s=19`, `${POST}/video/2`],
    [`${POST}/analytics?s=20`, `${POST}/analytics`],
    [`${POST}/quotes?s=20#x`, `${POST}/quotes`],
    ['https://x.com/i/status/1?s=20', 'https://x.com/i/status/1'],
    ['https://x.com/i/web/status/1?s=20', 'https://x.com/i/web/status/1'],
    ['https://twitter.com/a/status/1?s=20', 'https://twitter.com/a/status/1'],
    ['https://mobile.twitter.com/a/status/1?s=20', 'https://mobile.twitter.com/a/status/1'],
    ['https://www.x.com/a/status/1?ref_src=twsrc', 'https://www.x.com/a/status/1'],
    ['https://x.com/XBToshi?s=20&t=abc', 'https://x.com/XBToshi'],
    ['https://x.com/XBToshi/media?s=20&t=abc', 'https://x.com/XBToshi/media'],
    ['https://x.com/XBToshi/?a=x', 'https://x.com/XBToshi/'],
    ['https://x.com/XBToshi?lang=en&s=20', 'https://x.com/XBToshi?lang=en'],
    ['https://x.com/search?q=xmr&src=typed_query&f=live&s=20', 'https://x.com/search?q=xmr&src=typed_query&f=live'],
    ['https://x.com/explore?utm_source=a&ref_src=b', 'https://x.com/explore'],
    ['https://x.com/XBToshi/followers_you_follow?t=x', 'https://x.com/XBToshi/followers_you_follow'],
    ['https://x.com/XBToshi/lists?t=x&s=20', 'https://x.com/XBToshi/lists'],
    [`${POST}?S=20&A=x`, POST],
    ['https://x.com/explore?UTM_source=a&Ref=b', 'https://x.com/explore'],
    ['https://x.com/XBToshi?T=1', 'https://x.com/XBToshi'],
  ])('%s → %s', (dirty, clean) => {
    expect(cleanXUrl(dirty)).toBe(clean);
  });

  it.each([
    'https://x.com/search?q=xmr&t=1',
    'https://x.com/home?t=1',
    POST,
    'https://x.com.evil.com/a/status/1?s=20',
    'https://evil.com/x.com/a/status/1?s=20',
    'https://x.com@evil.com/a/status/1?s=20',
    'https://user@x.com/a/status/1?s=20',
    'https://x.com:444/a/status/1?s=20',
    'https://x.com./a/status/1?s=20',
    'ftp://x.com/a/status/1?s=20',
    'https://example.com/?s=20',
    'not a url',
  ])('leaves %s alone', (url) => {
    expect(cleanXUrl(url)).toBeNull();
  });
});

describe('cleanXLinks', () => {
  it('cleans each X link in prose, keeping the punctuation around it', () => {
    expect(cleanXLinks(`See ${POST}?s=20. And (https://x.com/a/status/1?s=46), also https://x.com/b?t=1!`)).toBe(`See ${POST}. And (https://x.com/a/status/1), also https://x.com/b!`);
  });
  it('Markdown links, quotes, braces and closing quotes keep their closers', () => {
    expect(cleanXLinks(`[post](${POST}?s=20)`)).toBe(`[post](${POST})`);
    expect(cleanXLinks(`"${POST}?s=20"`)).toBe(`"${POST}"`);
    expect(cleanXLinks(`{${POST}?s=20}`)).toBe(`{${POST}}`);
    expect(cleanXLinks(`“${POST}?s=20”`)).toBe(`“${POST}”`);
  });
  it('two links joined by a comma or full stop stay two links', () => {
    expect(cleanXLinks('https://x.com/a/status/1?s=20,https://x.com/b/status/2?s=20')).toBe('https://x.com/a/status/1,https://x.com/b/status/2');
    expect(cleanXLinks('https://x.com/a/status/1?s=20.https://x.com/b/status/2?a=z')).toBe('https://x.com/a/status/1.https://x.com/b/status/2');
  });
  it('the scheme in any case', () => {
    expect(cleanXLinks(`HTTPS://x.com/a/status/1?s=20`)).toBe('https://x.com/a/status/1');
  });
  it('a link inside another link, and other sites, are left alone', () => {
    const outer = 'https://example.com/go?u=https://x.com/a/status/1?s=20';
    expect(cleanXLinks(outer)).toBe(outer);
    expect(cleanXLinks('https://example.com/?s=20 and https://youtu.be/x?si=abc')).toBe('https://example.com/?s=20 and https://youtu.be/x?si=abc');
  });
});

describe('copying on x.com', () => {
  const copy = () => {
    const data = new Map<string, string>([['text/html', '<a>old</a>']]);
    const clipboardData = { clearData: () => data.clear(), setData: (t: string, v: string) => data.set(t, v) };
    const e = { clipboardData, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    return { e: e as unknown as ClipboardEvent, data, prevented: () => e.defaultPrevented };
  };
  const select = (html: string) => {
    document.body.innerHTML = html;
    const range = document.createRange();
    range.selectNodeContents(document.body.firstElementChild!);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    (document.activeElement as HTMLElement | null)?.blur?.();
  };

  it("X's Copy link: a plain selected link is cleaned, the old HTML cleared", () => {
    select(`<p>${POST}?a=yiBW0vELHaKxo8YNEMY&amp;s=20</p>`);
    const c = copy();
    expect(onCopy(c.e, document)).toBe(true);
    expect([...c.data]).toEqual([['text/plain', POST]]);
    expect(c.prevented()).toBe(true);
  });
  it('a link selected in an input is cleaned', () => {
    document.body.innerHTML = `<input value="x ${POST}?s=20 y">`;
    const input = document.querySelector('input')!;
    input.focus();
    input.setSelectionRange(2, 2 + `${POST}?s=20`.length);
    const c = copy();
    expect(onCopy(c.e, document)).toBe(true);
    expect(c.data.get('text/plain')).toBe(POST);
  });
  it('a selected link element (only that link) is cleaned', () => {
    select(`<div><a href="${POST}?s=20"><span>${POST}?s=20</span></a></div>`);
    const c = copy();
    expect(onCopy(c.e, document)).toBe(true);
  });
  it("a post's text with a link in it, or a block of markup, is left alone", () => {
    select(`<p>Look ${POST}?s=20</p>`);
    expect(onCopy(copy().e, document)).toBe(false);
    select(`<div><div>${POST}?s=20</div></div>`);
    expect(onCopy(copy().e, document)).toBe(false);
  });
  it('switched off: the listener is gone and the copy is left alone', () => {
    select(`<p>${POST}?s=20</p>`);
    const stop = startCopyLinks(document);
    const on = new Event('copy') as ClipboardEvent;
    const data = new Map<string, string>();
    Object.defineProperty(on, 'clipboardData', { value: { clearData: () => data.clear(), setData: (t: string, v: string) => data.set(t, v) } });
    document.dispatchEvent(on);
    expect(data.get('text/plain')).toBe(POST);
    stop();
    data.clear();
    const off = new Event('copy') as ClipboardEvent;
    Object.defineProperty(off, 'clipboardData', { value: { clearData: () => data.clear(), setData: (t: string, v: string) => data.set(t, v) } });
    document.dispatchEvent(off);
    expect(data.size).toBe(0);
  });
  it('a clean link or another site is left alone', () => {
    select(`<p>${POST}</p>`);
    expect(onCopy(copy().e, document)).toBe(false);
    select('<p>https://example.com/?s=20</p>');
    expect(onCopy(copy().e, document)).toBe(false);
  });
});
