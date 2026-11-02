import { absUrl } from './html-to-text';
import type { ExtractedPost } from './types';
import { cutTweet, expandTweet, ownStatusId, tweetFor, xExtractor } from './x';

/**
 * A whole X thread as one note (PLAN-THREADS): on a tweet's own page, the author's tweets right above and
 * below the opened one, each in its own cell of the conversation list.
 */

const TWEET = 'article[data-testid="tweet"]';
const CELL = '[data-testid="cellInnerDiv"]';
export const MAX_THREAD = 50;

const own = (article: Element, el: Element) => {
  const quote = el.closest('div[role="link"]');
  return !quote || !article.contains(quote);
};

/** The tweet's author handle, lower-cased; a quoted tweet's author doesn't count. */
export function authorOf(article: Element): string | null {
  for (const link of article.querySelectorAll('[data-testid="User-Name"] a[href]')) {
    if (!own(article, link)) continue;
    const handle = /^\/([A-Za-z0-9_]{1,15})$/.exec(link.getAttribute('href') ?? '')?.[1];
    if (handle) return handle.toLowerCase();
  }
  return null;
}

/** X draws a line down from the avatar when the author's thread goes on below this tweet. */
function lineBelow(article: Element): boolean {
  const avatar = article.querySelector('[data-testid="Tweet-User-Avatar"]')?.getBoundingClientRect();
  if (!avatar) return false;
  const view = article.ownerDocument.defaultView;
  return [...article.querySelectorAll('div')].some((d) => {
    if (view?.getComputedStyle(d).width !== '2px') return false;
    const r = d.getBoundingClientRect();
    return r.height > 0 && r.top >= avatar.top + avatar.height / 2;
  });
}

export interface XThread {
  tweets: Element[];
  /** more of the thread may be below what X has rendered so far */
  mayContinue: boolean;
  /** longer than MAX_THREAD: only that many around the opened tweet were taken */
  capped: boolean;
}

/** a cell X uses as a spacer or for the reply box: no tweet, no text */
const blank = (cell: Element) => !cell.querySelector(TWEET) && !cell.textContent?.trim();

/**
 * The thread around `tweet`: two or more tweets by its author in adjacent cells, in page order; null when
 * there is no thread or off a tweet's page. `continues` tells whether X shows the thread
 * going on below a tweet (its layout; replaced in tests).
 */
export function xThread(tweet: Element | null, doc: Document, continues: (article: Element) => boolean = lineBelow): XThread | null {
  if (!tweet || !/^\/[A-Za-z0-9_]{1,15}\/status\/\d{1,20}\/?$/.test(doc.location?.pathname ?? '')) return null;
  const cell = tweet.closest(CELL);
  const author = authorOf(tweet);
  if (!cell?.parentElement || !author) return null;
  const cells = [...cell.parentElement.children].filter((c) => c.matches(CELL));
  const at = cells.indexOf(cell);
  // a cell of the thread's author, or undefined to stop; promoted tweets never belong
  const take = (c: Element) => {
    const a = c.querySelector(TWEET);
    return a && !c.querySelector('[data-testid="placementTracking"]') && authorOf(a) === author ? a : undefined;
  };
  const before: Element[] = [];
  let capped = false;
  for (let i = at - 1; i >= 0; i--) {
    if (blank(cells[i]!)) continue;
    const a = take(cells[i]!);
    if (!a) break;
    if (before.length + 1 >= MAX_THREAD) {
      capped = true;
      break;
    }
    before.unshift(a);
  }
  const after: Element[] = [];
  for (let i = at + 1; i < cells.length; i++) {
    if (blank(cells[i]!)) continue;
    const a = take(cells[i]!);
    if (!a) break;
    if (before.length + 1 + after.length >= MAX_THREAD) {
      capped = true;
      break;
    }
    after.push(a);
  }
  const tweets = [...before, tweet, ...after];
  if (tweets.length < 2) return null;
  return { tweets, capped, mayContinue: capped || continues(tweets.at(-1)!) };
}

export const imageMarker = (n: number) => `[🖼 ${n}]`;
const MARKER = /\[🖼 (\d{1,3})\]/g;
/** the text without image markers, for what reads it as words (tag suggestions) */
export const withoutMarkers = (text: string) => text.replace(MARKER, '');

/**
 * The thread's tweets as one post: their texts in order with a blank line between, each tweet's images
 * marked right under it (`[🖼 N]`, made URLs at publish, PLAN-THREADS §4), the first tweet's link.
 */
export function combineThread(posts: ExtractedPost[], doc: Document): ExtractedPost {
  const first = posts[0]!;
  // a thread whose own text already has a marker keeps its images at the end, so no tweet text is taken for one
  const inline = !posts.some((p) => new RegExp(MARKER.source).test(p.text));
  let n = 0;
  const parts = posts.map((p) => [p.text.trim(), ...(inline ? p.images.map(() => imageMarker(++n)) : [])].filter(Boolean).join('\n'));
  return {
    site: 'x',
    text: parts.filter(Boolean).join('\n\n'),
    images: posts.flatMap((p) => p.images),
    sourceUrl: first.sourceUrl || (absUrl(doc.location.pathname, doc) ?? doc.location.href),
    ...(posts.some((p) => p.articleCard) ? { articleCard: true } : {}),
    ...(inline && n ? { inlineImages: true } : {}),
  };
}

/**
 * The note text with each marker made its image's final URL: `finals[i]` for `images[i]`, null when it was
 * unticked (its marker goes, and its line too when the marker stood alone). A marker with no such image is
 * the user's own text and stays. Returns the URLs placed, so they aren't appended again.
 */
export function placeImages(text: string, finals: (string | null)[]): { text: string; placed: string[] } {
  const placed: string[] = [];
  const known = (d: string) => +d >= 1 && +d <= finals.length;
  const out = text
    .replace(/^[ \t]*\[🖼 (\d{1,3})\][ \t]*(?:\n|$)/gm, (m, d: string) => (known(d) && finals[+d - 1] === null ? '' : m))
    .replace(MARKER, (m, d: string) => {
      if (!known(d)) return m;
      const url = finals[+d - 1];
      if (url) placed.push(url);
      return url ?? '';
    });
  return { text: out.replace(/\n+$/, ''), placed };
}

export interface LoadedThread {
  post: ExtractedPost;
  count: number;
  mayContinue: boolean;
  capped: boolean;
  /** 1-based positions of tweets whose "Show more" didn't open */
  cut: number[];
}

const byId = (doc: Document, id: string | null) => (id ? ([...doc.querySelectorAll(TWEET)].find((a) => ownStatusId(a) === id) ?? null) : null);

/**
 * Finds the thread around the target, opens each tweet's own "Show more" (by status id, since X may redraw
 * a tweet between clicks), then reads the thread again and extracts it.
 */
export async function loadThread(target: Element | null, doc: Document, continues?: (article: Element) => boolean): Promise<LoadedThread | null> {
  const opened = tweetFor(target, doc);
  const found = xThread(opened, doc, continues);
  if (!found) return null;
  const openedId = ownStatusId(opened!);
  for (const id of found.tweets.map(ownStatusId)) {
    const a = byId(doc, id);
    if (a && cutTweet(a)) await expandTweet(a, doc).catch(() => null);
  }
  const thread = xThread(byId(doc, openedId) ?? (opened!.isConnected ? opened : null), doc, continues) ?? found;
  const posts = thread.tweets.flatMap((t) => xExtractor.extract(t, doc) ?? []);
  if (posts.length < 2) return null;
  return {
    post: combineThread(posts, doc),
    count: posts.length,
    mayContinue: thread.mayContinue,
    capped: thread.capped,
    cut: thread.tweets.flatMap((t, i) => (cutTweet(t) ? [i + 1] : [])),
  };
}
