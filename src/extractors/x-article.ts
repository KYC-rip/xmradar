import { htmlToMarkdown } from './html-to-markdown';
import type { ExtractedArticle, ExtractedImage, Extractor } from './types';
import { fullSizeTwimg } from './x';

const STATUS_PATH = /^\/([A-Za-z0-9_]{1,15})\/(?:status|article)\/(\d{1,20})(?:\/|$)/;
const TWITTER_EPOCH = 1288834974657n;

/** Tweet ID → creation time in ms. BigInt: IDs are above 2^53 and `>>` is 32-bit. */
export function snowflakeTime(id: string): number {
  return Number((BigInt(id) >> 22n) + TWITTER_EPOCH);
}

/** Tweet ID from an x.com/twitter.com status URL, or null. */
export function statusIdFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !/^(?:www\.|mobile\.)?(?:x|twitter)\.com$/.test(u.hostname)) return null;
    return /^\/[A-Za-z0-9_]{1,15}\/status\/(\d{1,20})$/.exec(u.pathname.replace(/\/$/, ''))?.[1] ?? null;
  } catch {
    return null;
  }
}

function summarize(text: string, max = 300): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max / 2)).trimEnd()}…`;
}

interface ArticleParts {
  title: Element | null;
  body: Element | null;
  cover: Element | null;
}

/** Logged in: Draft.js read view. */
function loggedInParts(target: Element): ArticleParts | null {
  const view = target.closest('article[data-testid="twitterArticleReadView"]');
  if (!view) return null;
  const rich = view.querySelector('[data-testid="longformRichTextComponent"]');
  const body = rich?.querySelector('[data-contents]') ?? rich ?? null;
  const title = view.querySelector('[data-testid="twitter-article-title"]');
  // the cover is the photo above the title, outside the body
  const cover =
    [...view.querySelectorAll('[data-testid="tweetPhoto"] img')].find(
      (img) => !body?.contains(img) && (!title || img.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING),
    ) ?? null;
  return { title, body, cover };
}

/** Logged out: semantic HTML tagged with data-article-part. Matches a click anywhere in the article, title and cover included. */
function loggedOutParts(target: Element, doc: Document): ArticleParts | null {
  // the body the click is in, else the one whose article contains the click (title, cover)
  const body =
    target.closest('[data-article-part="body"]') ??
    [...doc.querySelectorAll('[data-article-part="body"]')].find((b) => {
      let root: Element | null = b.parentElement;
      while (root && !root.querySelector('[data-article-part="title"]')) root = root.parentElement;
      return root?.contains(target);
    });
  if (!body) return null;
  let root: Element | null = body.parentElement;
  while (root && !root.querySelector('[data-article-part="title"]')) root = root.parentElement;
  root ??= body.parentElement;
  if (!root?.contains(target)) return null;
  return {
    title: root.querySelector('[data-article-part="title"]'),
    body,
    cover: root.querySelector('[data-article-part="cover"] img'),
  };
}

export function extractArticle(target: Element, doc: Document): { article: ExtractedArticle; sourceUrl: string } | null {
  const path = STATUS_PATH.exec(doc.location.pathname);
  if (!path) return null; // no stable ID to replace the article by
  const parts = loggedInParts(target) ?? loggedOutParts(target, doc);
  if (!parts?.body) return null;
  const title = (parts.title?.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (!title) return null;

  const [, handle, id] = path as unknown as [string, string, string];
  const { markdown, images, firstParagraph } = htmlToMarkdown(parts.body, { baseUrl: 'https://x.com/', imageUrl: fullSizeTwimg });
  const coverSrc = parts.cover?.getAttribute('src');
  let cover: ExtractedImage | undefined;
  if (coverSrc) {
    try {
      const alt = parts.cover?.getAttribute('alt')?.trim();
      cover = { url: fullSizeTwimg(new URL(coverSrc, 'https://x.com/').toString()) };
      if (alt && alt !== 'Image' && alt !== 'Article cover image') cover.alt = alt;
    } catch {
      /* no cover */
    }
  }
  return {
    sourceUrl: `https://x.com/${handle}/status/${id}`,
    article: { id, title, markdown, summary: summarize(firstParagraph), cover, images, publishedAt: snowflakeTime(id) },
  };
}

export const xArticleExtractor: Extractor = {
  name: 'x-article',
  matches: (doc) => /(^|\.)(x|twitter)\.com$/.test(doc.location?.hostname ?? ''),
  extract(target, doc) {
    const found = extractArticle(target, doc);
    if (!found) return null;
    const { article, sourceUrl } = found;
    const images = article.cover && !article.images.some((i) => i.url === article.cover!.url) ? [article.cover, ...article.images] : article.images;
    return { site: 'x', text: article.markdown, images, sourceUrl, article };
  },
};
