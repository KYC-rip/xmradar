import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { extractPost } from '../src/extractors';
import { expandTweet } from '../src/extractors/x';
import { makeDoc } from './helpers';

const fixture = (name: string) => readFileSync(join(process.cwd(), 'tests/fixtures', `${name}.html`), 'utf8');

describe('x', () => {
  const doc = makeDoc('https://x.com/home', fixture('x'));
  const target = doc.querySelector('[data-testid="tweetPhoto"] img')!;
  const { post, fallback } = extractPost(target, doc);

  it('detects the tweet', () => {
    expect(fallback).toBe(false);
    expect(post.site).toBe('x');
    expect(post.sourceUrl).toBe('https://x.com/me/status/1850000000000000001');
  });
  it('keeps emoji, recovers truncated links, keeps short links and mentions', () => {
    expect(post.text).toBe(
      'Shipping a thing today 🚀\nRead more: https://example.com/blog/a-very-long-post and https://nostr.com by @fiatjaf',
    );
  });
  it('takes full-size own images and skips quoted ones', () => {
    expect(post.images).toEqual([
      { url: 'https://pbs.twimg.com/media/GAbc?format=jpg&name=orig', alt: 'A rocket on a launchpad' },
      { url: 'https://pbs.twimg.com/media/GDef?format=png&name=orig', alt: undefined },
    ]);
  });
  it('falls back to t.co when the display text is truncated without the hidden remainder', () => {
    const d = makeDoc('https://x.com/home', `<article data-testid="tweet"><div data-testid="tweetText"><a href="https://t.co/zzz">example.com/abc…</a></div></article>`);
    expect(extractPost(d.querySelector('a')!, d).post.text).toBe('https://t.co/zzz');
  });
});

describe('x, outside any tweet on a tweet page', () => {
  const tweet = (id: string, text: string, extra = '') =>
    `<article data-testid="tweet"><div data-testid="tweetText">${text}</div>${extra}<a href="/XBToshi/status/${id}"><time>1h</time></a></article>`;
  const page = (path: string) =>
    makeDoc(`https://x.com${path}`, `<div id="side">menu</div>${tweet('1', 'parent')}${tweet('2', 'the focal tweet', '<div role="link"><a href="/a/status/9"><time>x</time></a></div>')}${tweet('3', 'a reply')}`);

  it('takes the tweet the URL names', () => {
    const doc = page('/XBToshi/status/2');
    for (const target of [doc.getElementById('side'), null]) {
      const { post, fallback } = extractPost(target, doc);
      expect(fallback).toBe(false);
      expect(post.text).toBe('the focal tweet');
      expect(post.sourceUrl).toBe('https://x.com/XBToshi/status/2');
    }
  });
  it('still prefers the tweet that was clicked, and a quoted link does not count as the focal one', () => {
    const doc = page('/XBToshi/status/2');
    expect(extractPost(doc.querySelectorAll('[data-testid="tweetText"]')[2]!, doc).post.text).toBe('a reply');
    expect(extractPost(null, page('/a/status/9')).fallback).toBe(true);
  });
  it('falls back off tweet pages', () => {
    expect(extractPost(null, page('/home')).fallback).toBe(true);
  });
});

describe('x, long tweets behind Show more', () => {
  const page = (more: string, quoteMore = '') =>
    makeDoc(
      'https://x.com/home',
      `<article data-testid="tweet"><div data-testid="tweetText">cut…</div>${more}<div role="link"><div data-testid="tweetText">quoted</div>${quoteMore}</div><a href="/a/status/1"><time>1h</time></a></article>`,
    );
  const wire = (doc: Document, sel: string, full: string) =>
    doc.querySelector(sel)!.addEventListener('click', (e) => {
      const btn = e.currentTarget as Element;
      btn.closest('article')!.querySelector('[data-testid="tweetText"]')!.textContent = full;
      btn.remove();
    });

  it("clicks the tweet's own Show more and extracts the full text", async () => {
    const doc = page('<button data-testid="tweet-text-show-more-link">Show more</button>');
    wire(doc, 'button', 'the whole long tweet');
    const target = doc.querySelector('[data-testid="tweetText"]')!;
    const full = await expandTweet(target, doc);
    expect(full).toBe(doc.querySelector('article'));
    expect(extractPost(full, doc).post.text).toBe('the whole long tweet');
  });
  it("leaves a quoted tweet's Show more, links and short tweets alone", async () => {
    const quoted = page('', '<button data-testid="tweet-text-show-more-link">Show more</button>');
    const click = vi.fn();
    quoted.querySelector('button')!.addEventListener('click', click);
    await expandTweet(quoted.querySelector('[data-testid="tweetText"]'), quoted);
    expect(click).not.toHaveBeenCalled();
    const link = page('<a data-testid="tweet-text-show-more-link" href="/a/status/1">Show more</a>');
    const linkClick = vi.fn((e: Event) => e.preventDefault());
    link.querySelector('a[data-testid]')!.addEventListener('click', linkClick);
    expect(await expandTweet(link.querySelector('[data-testid="tweetText"]'), link)).toBe(link.querySelector('article'));
    expect(linkClick).not.toHaveBeenCalled();
  });
  it('gives up after the timeout if nothing expands', async () => {
    const doc = page('<button data-testid="tweet-text-show-more-link">Show more</button>');
    expect(extractPost(await expandTweet(doc.querySelector('[data-testid="tweetText"]'), doc, 60), doc).post.text).toBe('cut…');
  });
  it('reads the redrawn tweet when X replaces it instead of expanding in place', async () => {
    const doc = page('<button data-testid="tweet-text-show-more-link">Show more</button>');
    const old = doc.querySelector('article')!;
    old.querySelector('button')!.addEventListener('click', () => {
      const fresh = old.cloneNode(true) as Element;
      fresh.querySelector('[data-testid="tweetText"]')!.textContent = 'the whole long tweet';
      fresh.querySelector('button')!.remove();
      old.replaceWith(fresh);
    });
    const full = await expandTweet(old.querySelector('[data-testid="tweetText"]'), doc);
    expect(full).not.toBe(old);
    expect(extractPost(full, doc).post.text).toBe('the whole long tweet');
  });
});

describe('bluesky', () => {
  const doc = makeDoc('https://bsky.app/', fixture('bluesky'));
  const { post } = extractPost(doc.querySelector('[data-testid="postText"]')!, doc);
  it('extracts text, full-size images and permalink', () => {
    expect(post.text).toBe('Hello from Bluesky\nsecond line https://example.org/x');
    expect(post.images).toEqual([{ url: 'https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:abc/bafy123@jpeg', alt: 'cat' }]);
    expect(post.sourceUrl).toBe('https://bsky.app/profile/me.bsky.social/post/3kabc');
  });
});

describe('bluesky quote posts', () => {
  it('ignores the embedded quoted post', () => {
    const doc = makeDoc(
      'https://bsky.app/',
      `<div data-testid="feedItem-by-me">
        <a href="/profile/me/post/outer">1h</a>
        <div data-testid="postText">my take</div>
        <div data-testid="contentHider-embed"><a href="/profile/them/post/inner">x</a>
          <div data-testid="postText">their post</div>
          <img src="https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:x/q@jpeg"></div>
      </div>`,
    );
    const { post } = extractPost(doc.querySelector('[data-testid="postText"]')!, doc);
    expect(post.text).toBe('my take');
    expect(post.images).toEqual([]);
    expect(post.sourceUrl).toBe('https://bsky.app/profile/me/post/outer');
  });
});

describe('quote-only posts', () => {
  it('X does not copy the quoted tweet when the outer one has no text', () => {
    const doc = makeDoc('https://x.com/home', `<article data-testid="tweet"><div role="link"><div data-testid="tweetText">quoted</div></div></article>`);
    expect(extractPost(doc.querySelector('article')!, doc).post.text).toBe('');
  });
  it('Bluesky does not copy the embedded post', () => {
    const doc = makeDoc('https://bsky.app/', `<div data-testid="feedItem-by-me"><div data-testid="contentHider-embed"><a href="/profile/t/post/in">x</a><div data-testid="postText">quoted</div></div></div>`);
    const { post } = extractPost(doc.querySelector('[data-testid^="feedItem"]')!, doc);
    expect(post.text).toBe('');
    expect(post.sourceUrl).toBe('https://bsky.app/');
  });
});

describe('mastodon', () => {
  it.each([
    ['generator meta', 'https://mastodon.social/home', '<meta name="generator" content="Mastodon v4.3">'],
    ['selector only', 'https://fosstodon.example/home', ''],
  ])('works on any instance (%s)', (_, url, head) => {
    const doc = makeDoc(url, fixture('mastodon'), head);
    const { post, fallback } = extractPost(doc.querySelector('p')!, doc);
    expect(fallback).toBe(false);
    expect(post.text).toBe('First paragraph with #nostr\n\nLink: https://example.com/some/really/long/path');
    expect(post.images).toEqual([{ url: 'https://files.mastodon.social/media/original/a.png', alt: 'diagram' }]);
    expect(post.sourceUrl).toBe('https://mastodon.social/@me/113000000000000001');
  });
});

describe('linkedin', () => {
  const doc = makeDoc('https://www.linkedin.com/feed/', fixture('linkedin'));
  const { post } = extractPost(doc.querySelector('span')!, doc);
  it('extracts text, image and activity URL', () => {
    expect(post.text).toBe('Excited to share\n\nour new release');
    expect(post.images[0]?.alt).toBe('screenshot');
    expect(post.sourceUrl).toBe('https://www.linkedin.com/feed/update/urn:li:activity:7250000000000000000/');
  });
});

describe('facebook', () => {
  const doc = makeDoc('https://www.facebook.com/', fixture('facebook'));
  const { post } = extractPost(doc.querySelector('[data-ad-preview] div')!, doc);
  it('extracts message, large images only, permalink', () => {
    expect(post.text).toBe('Weekend hike\nGreat views!');
    expect(post.images).toEqual([{ url: 'https://scontent.xx.fbcdn.net/v/t39/big.jpg', alt: 'mountain' }]);
    expect(post.sourceUrl).toBe('https://www.facebook.com/me/posts/pfbid0abc?__cft__=x');
  });
});

describe('generic fallback', () => {
  it('uses og tags when no post is detected', () => {
    const doc = makeDoc(
      'https://blog.example/post',
      '<p id="p">hi</p>',
      '<meta property="og:description" content="Desc"><meta property="og:image" content="/cover.png"><meta property="og:url" content="https://blog.example/post">',
    );
    const { post, fallback } = extractPost(doc.getElementById('p'), doc);
    expect(fallback).toBe(true);
    expect(post).toEqual({ site: 'generic', text: 'Desc', images: [{ url: 'https://blog.example/cover.png', alt: undefined }], sourceUrl: 'https://blog.example/post' });
  });
  it('prefers the selection and the right-clicked image', () => {
    const doc = makeDoc('https://x.com/home', fixture('x'));
    const { post } = extractPost(doc.querySelector('[data-testid="tweetText"]')!, doc, { selection: '  just this  ' });
    expect(post.text).toBe('just this');
    expect(post.site).toBe('x');
    const g = extractPost(null, makeDoc('https://a.example/', ''), { srcUrl: 'https://a.example/i.png' });
    expect(g.post.images[0]?.url).toBe('https://a.example/i.png');
  });
});
