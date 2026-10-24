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

export const xExtractor: Extractor = {
  name: 'x',
  matches: (doc) => /(^|\.)(x|twitter)\.com$/.test(doc.location?.hostname ?? ''),
  extract(target, doc) {
    const article = target.closest('article[data-testid="tweet"]');
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
    const permalink = article.querySelector('a[href*="/status/"] time')?.closest('a')?.getAttribute('href');
    // best effort: X may render the shared-article card through a different link
    const articleCard = !!article.querySelector('a[href*="/article/"]');
    return { site: 'x', text, images, sourceUrl: absUrl(permalink, doc) ?? doc.location.href, ...(articleCard ? { articleCard } : {}) };
  },
};
