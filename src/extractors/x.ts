import { absUrl, htmlToText, resolveDisplayedLink } from './html-to-text';
import type { ExtractedImage, Extractor } from './types';

export function fullSizeTwimg(src: string): string {
  try {
    const u = new URL(src);
    if (u.hostname === 'pbs.twimg.com' && u.pathname.startsWith('/media/')) u.searchParams.set('name', 'orig');
    return u.toString();
  } catch {
    return src;
  }
}

const statusId = (path: string | null | undefined) => /^\/[A-Za-z0-9_]{1,15}\/status\/(\d{1,20})(?:[/?#]|$)/.exec(path ?? '')?.[1];

/** The tweet's own timestamp link, not a quoted tweet's (on a tweet's page the timestamp comes after the quote). */
function ownPermalink(article: Element): Element | undefined {
  return [...article.querySelectorAll('a[href*="/status/"]')].find((l) => {
    if (!l.querySelector('time')) return false;
    const quote = l.closest('div[role="link"]');
    return !quote || !article.contains(quote);
  });
}

/** The status ID of the tweet itself; the share menu and the extractor both identify tweets by it. */
export const ownStatusId = (article: Element): string | null => statusId(ownPermalink(article)?.getAttribute('href')) ?? null;

/** On a tweet's own page, the tweet the URL names; replies and quotes don't count. */
function focalTweet(doc: Document): Element | null {
  const id = statusId(doc.location?.pathname);
  if (!id) return null;
  return [...doc.querySelectorAll('article[data-testid="tweet"]')].find((a) => ownStatusId(a) === id) ?? null;
}

export const xExtractor: Extractor = {
  name: 'x',
  matches: (doc) => /(^|\.)(x|twitter)\.com$/.test(doc.location?.hostname ?? ''),
  extract(target, doc) {
    // a click or hover outside any tweet on a tweet's own page means that tweet
    const article = target.closest('article[data-testid="tweet"]') ?? focalTweet(doc);
    if (!article) return null;
    // quoted tweets are nested in div[role=link]; the outer tweet's own content is not
    const own = (el: Element) => {
      const quote = el.closest('div[role="link"]');
      return !quote || !article.contains(quote);
    };
    // if X ever wraps the outer tweet in role=link too, fall back to the first text block,
    // but not for quote-only tweets, where the first text block is the quoted one
    const textEl =
      [...article.querySelectorAll('[data-testid="tweetText"]')].find(own) ??
      (article.querySelector('div[role="link"] [data-testid="tweetText"]') ? null : article.querySelector('[data-testid="tweetText"]'));
    const text = textEl
      ? htmlToText(textEl, {
          link: (a) => (a.getAttribute('href')?.startsWith('/') ? null : resolveDisplayedLink(a)),
        })
      : '';
    const images: ExtractedImage[] = [...article.querySelectorAll('[data-testid="tweetPhoto"] img')]
      .filter(own)
      .map((img) => {
        const alt = img.getAttribute('alt') ?? undefined;
        return { url: fullSizeTwimg(img.getAttribute('src') ?? ''), alt: alt && alt !== 'Image' ? alt : undefined };
      })
      .filter((i) => i.url);
    const permalink = ownPermalink(article)?.getAttribute('href');
    // best effort: X may render the shared-article card through a different link
    const articleCard = !!article.querySelector('a[href*="/article/"]');
    return { site: 'x', text, images, sourceUrl: absUrl(permalink, doc) ?? doc.location.href, ...(articleCard ? { articleCard } : {}) };
  },
};
