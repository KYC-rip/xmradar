import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { extractPost } from '../src/extractors';
import { destination, escapeText, htmlToMarkdown, replaceImages } from '../src/extractors/html-to-markdown';
import { snowflakeTime, statusIdFromUrl } from '../src/extractors/x-article';
import type { ExtractedImage } from '../src/extractors';
import { ARTICLE_WARN_BYTES, articleTemplate, articleTooLarge, buildArticle, checkPublishable, wordCount, type PostImage } from '../src/nostr/event';
import { makeDoc } from './helpers';

const URL = 'https://x.com/XBToshi/status/2113662765525282909';
const fixture = (name: string) => readFileSync(join(process.cwd(), 'tests/fixtures', `${name}.html`), 'utf8');
const loggedIn = makeDoc(URL, fixture('x-article-loggedin'));
const loggedOut = makeDoc(URL, fixture('x-article-loggedout'));
const md = (html: string) => htmlToMarkdown(makeDoc('https://x.com/', `<div id="r">${html}</div>`).getElementById('r')!, { baseUrl: 'https://x.com/' });

describe('snowflakeTime', () => {
  it('uses BigInt, so IDs above 2^53 decode correctly', () => {
    expect(new Date(snowflakeTime('2113662765525282909')).toISOString()).toBe('2026-10-23T16:04:07.913Z');
    expect(snowflakeTime('20')).toBe(1288834974657);
  });
});

describe('statusIdFromUrl', () => {
  it('takes the ID from https X status URLs only', () => {
    expect(statusIdFromUrl(URL)).toBe('2113662765525282909');
    expect(statusIdFromUrl('https://twitter.com/a/status/12/')).toBe('12');
    expect(statusIdFromUrl('http://x.com/a/status/12')).toBeNull();
    expect(statusIdFromUrl('https://evil.com/a/status/12')).toBeNull();
    expect(statusIdFromUrl('https://x.com/a/status/12/photo/1')).toBeNull();
  });
});

describe('X Article, logged in (Draft.js)', () => {
  const target = loggedIn.querySelector('[data-testid="longformRichTextComponent"] h2')!;
  const { post, fallback } = extractPost(target, loggedIn);
  const a = post.article!;

  it('is detected as an article, not a tweet or the generic fallback', () => {
    expect(fallback).toBe(false);
    expect(a).toBeDefined();
    expect(post.sourceUrl).toBe(URL);
    expect(a.id).toBe('2113662765525282909');
  });
  it('takes the title, cover, summary and date', () => {
    expect(a.title).toBe('The Web-App Cash Register Nobody Can Delist');
    expect(a.cover?.url).toBe('https://pbs.twimg.com/media/HVU6ugabYAAnzMr?format=jpg&name=orig');
    expect(a.summary.startsWith('TL;DR: pwa.cash is a point of sale')).toBe(true);
    expect(a.summary.length).toBeLessThanOrEqual(301);
    const time = loggedIn.querySelector('time')!.getAttribute('datetime')!;
    expect(Math.abs(a.publishedAt - Date.parse(time))).toBeLessThan(1000);
  });
  it('finds the 9 inline images, full size, with the cover first in the image list', () => {
    expect(a.images).toHaveLength(9);
    expect(a.images.every((i) => /^https:\/\/pbs\.twimg\.com\/media\/.+name=orig$/.test(i.url) && i.alt === undefined)).toBe(true);
    expect(post.images[0]).toBe(a.cover);
    expect(post.images).toHaveLength(10);
  });
  it('converts headings, bold, links, lists, images and separators', () => {
    const m = a.markdown;
    expect(m.startsWith('**TL;DR:** [pwa.cash](<https://pwa.cash/>) is a point of sale')).toBe(true);
    expect(m).toContain('\n\n## What [pwa.cash](<https://pwa.cash/>) used to be\n\n');
    expect(m).toContain('\n- [**uPay.rip**](<https://upay.rip/>) detects USDT');
    expect(m).toContain('\n1. Go to <https://pwa.cash/> and sign in with a passkey.\n2. Name your shop');
    expect(m).toContain('\n\n![](<https://pbs.twimg.com/media/HVU62u3aIAAiQW2?format=jpg&name=orig>)\n\n');
    expect(m).toContain('\n\n---\n\n');
    expect(m.match(/^## /gm)).toHaveLength(14);
    expect(m.match(/^!\[/gm)).toHaveLength(9);
  });
  it('keeps a paragraph with links as one paragraph (link wrapper divs are inline)', () => {
    const para = a.markdown.split('\n\n').find((p) => p.startsWith('**TL;DR:**'))!;
    expect(para).not.toContain('\n');
    expect(para.match(/\[pwa\.cash\]/g)).toHaveLength(2);
  });
  it('leaves out the title, author line and action bar', () => {
    expect(a.markdown).not.toContain('The Web-App Cash Register Nobody Can Delist');
    expect(a.markdown).not.toMatch(/CyberSatoshi|@XBToshi|Bookmark|Reply|Repost/);
  });
  it('ends with the last paragraph, with no call-to-action chrome', () => {
    expect(a.markdown.endsWith('goto my shop: <https://pwa.cash/s/xbtoshi>')).toBe(true);
    expect(a.markdown).not.toMatch(/Join X|More articles/i);
  });
});

describe('X Article, logged out (semantic HTML)', () => {
  const extract = (sel: string) => extractPost(loggedOut.querySelector(sel)!, loggedOut).post;
  const body = extract('[data-article-part="body"] h3');

  it('right-clicking the title, the cover or the body gives the same article', () => {
    for (const sel of ['[data-article-part="title"]', '[data-article-part="cover"] img']) {
      expect(extract(sel).article).toEqual(body.article);
    }
  });
  it('matches the logged-in extraction: title, image count, headings and text', () => {
    const inA = extractPost(loggedIn.querySelector('[data-testid="twitter-article-title"]')!, loggedIn).post.article!;
    const outA = body.article!;
    expect(outA.title).toBe(inA.title);
    expect(outA.images).toHaveLength(inA.images.length);
    // the logged-out page uses h3 where the logged-in one uses h2, doesn't autolink bare
    // domains, and puts bold one character off after an emoji: compare plain text only
    const words = (m: string) =>
      m
        .replace(/!\[[^\]]*\]\(<[^>]*>\)/g, '')
        .replace(/\[([^\]]*)\]\(<[^>]*>\)/g, '$1')
        .replace(/<(https?:[^>]*)>/g, '$1')
        .replace(/^#+ /gm, '')
        .replace(/[*\\]/g, '')
        .replace(/\s+/g, ' ');
    expect(words(outA.markdown)).toBe(words(inA.markdown));
  });
  it('drops the plain-text tail X leaves after a shortened link', () => {
    expect(body.article!.markdown).toContain('\n\n👉 <https://pwa.cash/>\n\n');
  });
  it('picks the article the click is in when a page has two', () => {
    const second = fixture('x-article-loggedout').replace('The Web-App Cash Register Nobody Can Delist', 'Second Article');
    const doc = makeDoc(URL, fixture('x-article-loggedout') + second);
    const titles = [...doc.querySelectorAll('[data-article-part="title"]')];
    const bodies = [...doc.querySelectorAll('[data-article-part="body"] h3')];
    expect(extractPost(titles[1]!, doc).post.article!.title).toBe('Second Article');
    expect(extractPost(bodies[bodies.length - 1]!, doc).post.article!.title).toBe('Second Article');
    expect(extractPost(titles[0]!, doc).post.article!.title).toBe('The Web-App Cash Register Nobody Can Delist');
  });
  it("doesn't match outside the article", () => {
    const doc = makeDoc(URL, `<p id="x">hello</p>${fixture('x-article-loggedout')}`);
    expect(extractPost(doc.getElementById('x')!, doc).post.article).toBeUndefined();
  });
});

describe('extractor order and selection', () => {
  it('normal tweets still go to the tweet extractor', () => {
    const doc = makeDoc('https://x.com/me/status/1850000000000000001', fixture('x'));
    const { post } = extractPost(doc.querySelector('[data-testid="tweetText"]')!, doc);
    expect(post.article).toBeUndefined();
    expect(post.text.startsWith('Shipping a thing today')).toBe(true);
  });
  it('needs a status URL for a stable ID', () => {
    const doc = makeDoc('https://x.com/home', fixture('x-article-loggedin'));
    expect(extractPost(doc.querySelector('h2')!, doc).post.article).toBeUndefined();
  });
  it('a text selection shares the fragment as a note', () => {
    const { post } = extractPost(loggedIn.querySelector('h2')!, loggedIn, { selection: 'just this' });
    expect(post.text).toBe('just this');
    expect(post.article).toBeUndefined();
  });
  it('flags a tweet that shares an article card', () => {
    const doc = makeDoc('https://x.com/home', `<article data-testid="tweet"><div data-testid="tweetText">read</div><a href="/me/article/1">card</a></article>`);
    expect(extractPost(doc.querySelector('[data-testid="tweetText"]')!, doc).post.articleCard).toBe(true);
  });
});

describe('htmlToMarkdown escaping and safety', () => {
  it('escapes Markdown and HTML in text', () => {
    expect(md('<p>a *b* _c_ [d] &lt;script&gt; &amp;amp; `e`</p>').markdown).toBe('a \\*b\\* \\_c\\_ \\[d\\] \\<script\\> \\&amp; \\`e\\`');
    expect(md('<p># not a heading</p><p>1. not a list</p><p>- nor this</p>').markdown).toBe('\\# not a heading\n\n1\\. not a list\n\n\\- nor this');
  });
  it('turns non-http links into plain text', () => {
    expect(md('<p><a href="javascript:alert(1)">x</a> <a href="data:text/html,1">y</a></p>').markdown).toBe('x y');
  });
  it('wraps destinations so ")" and spaces cannot break out', () => {
    expect(md('<p><a href="https://e.com/a_(b) c">t</a></p>').markdown).toBe('[t](<https://e.com/a_(b)%20c>)');
    expect(destination('https://e.com/<x>')).toBe('<https://e.com/%3Cx%3E>');
  });
  it('escapes alt text', () => {
    expect(md('<figure><img src="https://e.com/i.png" alt="a ] b"></figure>').markdown).toBe('![a \\] b](<https://e.com/i.png>)');
  });
  it('nests bold and italic and keeps spaces outside the markers', () => {
    expect(md('<p><b>bold <i>both</i></b><span style="font-weight: bold"> s</span></p>').markdown).toBe('**bold *both*** **s**');
  });
  it('restarts ordered numbering after a paragraph', () => {
    expect(md('<ol><li>a</li><li>b</li></ol><p>x</p><ol><li>c</li></ol>').markdown).toBe('1. a\n2. b\n\nx\n\n1. c');
  });
  it('fences code with more backticks than it contains', () => {
    expect(md('<pre>a ``` b</pre>').markdown).toBe('````\na ``` b\n````');
  });
  it('keeps the text of an unknown embed and skips empty paragraphs', () => {
    expect(md('<p></p><section data-block="true"><div>Embedded post text</div></section><p> </p><p>end</p>').markdown).toBe('Embedded post text\n\nend');
  });
  it('consumes a shortened link tail only when the URL really ends there', () => {
    const html = (after: string) => `<p><a href="https://pwa.cash/"><span>https://pwa.cas</span></a><span>${after}</span></p>`;
    expect(md(html('h. Next')).markdown).toBe('<https://pwa.cash/>. Next');
    expect(md(html('hello')).markdown).toBe('<https://pwa.cash/>hello');
  });
  it('escapes lines that would make the line above a setext heading', () => {
    expect(md('<p>Title<br>===<br>- - -</p>').markdown).toBe('Title\n\\===\n\\- - -');
  });
  it('numbers nested ordered lists separately', () => {
    expect(md('<ol><li>a<ol><li>x</li><li>y</li></ol></li><li>b</li></ol>').markdown).toBe('1. a\n   1. x\n   2. y\n2. b');
  });
  it('escapeText covers every special character', () => {
    expect(escapeText('\\`*_[]<>&|~')).toBe('\\\\\\`\\*\\_\\[\\]\\<\\>\\&\\|\\~');
  });
});

describe('replaceImages', () => {
  const a = 'https://pbs.twimg.com/media/A?name=orig';
  const ab = 'https://pbs.twimg.com/media/A?name=orig&x=1';
  const text = `p\n\n![](<${a}>)\n\n![](<${ab}>)\n\nsee ${a}\n\n![](<${a}>)`;

  it('replaces whole image tokens only, never other occurrences or prefixes of a URL', () => {
    const out = replaceImages(text, new Map([[a, 'https://blossom/1.jpg']]));
    expect(out).toBe(`p\n\n![](<https://blossom/1.jpg>)\n\n![](<${ab}>)\n\nsee ${a}\n\n![](<https://blossom/1.jpg>)`);
  });
  it('drops unticked images, including duplicates, without leaving blank runs', () => {
    expect(replaceImages(text, new Map([[a, null]]))).toBe(`p\n\n![](<${ab}>)\n\nsee ${a}`);
  });
  it('handles URLs with parentheses', () => {
    const p = 'https://e.com/a_(1).png';
    expect(replaceImages(`![x](${destination(p)})`, new Map([[p, 'https://b/2.png']]))).toBe('![x](<https://b/2.png>)');
  });
});

describe('buildArticle', () => {
  const base = {
    tweetId: '2113662765525282909',
    title: ' Title ',
    summary: 'Sum',
    markdown: 'Body ![](<https://b/1.jpg>)',
    images: [{ url: 'https://b/1.jpg', sha256: 'aa', mime: 'image/jpeg' }],
    sourceUrl: URL,
    publishedAt: 1761235447913,
    now: 1800000000,
  };

  it('builds a NIP-23 event that replaces itself by tweet ID', () => {
    const t = buildArticle({ ...base, cover: { url: 'https://b/c.jpg' } });
    expect(t.kind).toBe(30023);
    expect(t.created_at).toBe(1800000000);
    expect(t.content).toBe('Body ![](<https://b/1.jpg>)');
    expect(t.tags).toEqual([
      ['d', 'x-2113662765525282909'],
      ['title', 'Title'],
      ['summary', 'Sum'],
      ['image', 'https://b/c.jpg'],
      ['published_at', '1761235447'],
      ['r', URL],
      ['alt', 'Long-form article: Title'],
      ['imeta', 'url https://b/c.jpg'],
      ['imeta', 'url https://b/1.jpg', 'm image/jpeg', 'x aa'],
      ['client', 'XMRadar'],
    ]);
  });
  it('omits the image tag without a cover and appends the source link on request', () => {
    const t = buildArticle({ ...base, appendSource: true });
    expect(t.tags.some((x) => x[0] === 'image')).toBe(false);
    expect(t.content).toBe(`Body ![](<https://b/1.jpg>)\n\n---\n\nOriginally published on X: ${URL}`);
  });
  it('warns above 60 KB', () => {
    expect(articleTooLarge('x'.repeat(ARTICLE_WARN_BYTES))).toBe(false);
    expect(articleTooLarge('é'.repeat(ARTICLE_WARN_BYTES / 2 + 1))).toBe(true);
  });
});

describe('articleTemplate (composer images)', () => {
  const cover: ExtractedImage = { url: 'https://pbs.twimg.com/media/C?name=orig' };
  const one: ExtractedImage = { url: 'https://pbs.twimg.com/media/A?name=orig' };
  const two: ExtractedImage = { url: 'https://pbs.twimg.com/media/B?name=orig', alt: 'b' };
  const article = { id: '2113662765525282909', title: 'T', markdown: '', summary: 'S', cover, images: [one, two], publishedAt: 1761235447913 };
  const markdown = `Intro\n\n![](<${one.url}>)\n\nMiddle\n\n![b](<${two.url}>)`;
  const up = (url: string, sha: string): PostImage => ({ url, sha256: sha });
  const build = (prepared: Map<ExtractedImage, PostImage>) =>
    articleTemplate({ article, postImages: [cover, one, two], prepared, title: 'T', summary: 'S', markdown, sourceUrl: URL, now: 1 });
  const tag = (t: { tags: string[][] }, n: string) => t.tags.filter((x) => x[0] === n);

  it('uses the uploaded URL for the cover tag, the Markdown and imeta', () => {
    const t = build(new Map([[cover, up('https://b/c.jpg', 'cc')], [one, up('https://b/1.jpg', '11')], [two, up('https://b/2.jpg', '22')]]));
    expect(tag(t, 'image')).toEqual([['image', 'https://b/c.jpg']]);
    expect(t.content).toBe('Intro\n\n![](<https://b/1.jpg>)\n\nMiddle\n\n![b](<https://b/2.jpg>)');
    expect(tag(t, 'imeta').map((x) => x[1])).toEqual(['url https://b/c.jpg', 'url https://b/1.jpg', 'url https://b/2.jpg']);
    expect(t.content).not.toContain('pbs.twimg.com');
  });
  it('drops the image tag and cover imeta when the cover is unticked', () => {
    const t = build(new Map([[one, up('https://b/1.jpg', '11')], [two, up('https://b/2.jpg', '22')]]));
    expect(tag(t, 'image')).toEqual([]);
    expect(tag(t, 'imeta').map((x) => x[1])).toEqual(['url https://b/1.jpg', 'url https://b/2.jpg']);
  });
  it('removes an unticked inline image from the Markdown and imeta', () => {
    const t = build(new Map([[cover, up('https://b/c.jpg', 'cc')], [two, up('https://b/2.jpg', '22')]]));
    expect(t.content).toBe('Intro\n\nMiddle\n\n![b](<https://b/2.jpg>)');
    expect(tag(t, 'imeta').map((x) => x[1])).toEqual(['url https://b/c.jpg', 'url https://b/2.jpg']);
  });
  it('counts words without Markdown syntax or URLs', () => {
    expect(wordCount(markdown)).toBe(2);
    expect(wordCount("## It's **bold** and [a link](<https://e.com/x>)")).toBe(5);
  });
});

describe('checkPublishable (background)', () => {
  const sk = generateSecretKey();
  const ev = (kind: number, tags: string[][]) => finalizeEvent({ kind, tags, content: 'x', created_at: 1 }, sk);

  it('accepts notes, and articles whose d matches the X post', () => {
    expect(() => checkPublishable(ev(1, []), 'https://example.com', statusIdFromUrl)).not.toThrow();
    expect(() => checkPublishable(ev(30023, [['d', 'x-2113662765525282909'], ['title', 'T']]), URL, statusIdFromUrl)).not.toThrow();
  });
  it('rejects a mismatched or missing d, a missing title, a non-X source and other kinds', () => {
    expect(() => checkPublishable(ev(30023, [['d', 'x-1'], ['title', 'T']]), URL, statusIdFromUrl)).toThrow(/does not match/);
    expect(() => checkPublishable(ev(30023, [['title', 'T']]), URL, statusIdFromUrl)).toThrow(/does not match/);
    expect(() => checkPublishable(ev(30023, [['d', 'x-2113662765525282909']]), URL, statusIdFromUrl)).toThrow(/title/);
    expect(() => checkPublishable(ev(30023, [['d', 'x-1'], ['title', 'T']]), 'https://evil.com/a/status/1', statusIdFromUrl)).toThrow(/does not match/);
    expect(() => checkPublishable(ev(0, []), URL, statusIdFromUrl)).toThrow(/kind/);
    expect(() => checkPublishable(ev(10002, []), URL, statusIdFromUrl)).toThrow(/kind/);
  });
});
