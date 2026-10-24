import { absUrl, htmlToText } from './html-to-text';
import type { Extractor } from './types';

export const facebookExtractor: Extractor = {
  name: 'facebook',
  matches: (doc) => /(^|\.)facebook\.com$/.test(doc.location?.hostname ?? ''),
  extract(target, doc) {
    const article = target.closest('[role="article"]');
    if (!article) return null;
    let textEl: Element | null | undefined = article.querySelector('[data-ad-preview="message"], [data-ad-comet-preview="message"]');
    if (!textEl) {
      // fall back to the longest dir=auto block, which is how FB renders post bodies
      textEl = [...article.querySelectorAll('div[dir="auto"]')].sort((a, b) => (b.textContent?.length ?? 0) - (a.textContent?.length ?? 0))[0];
    }
    const text = textEl ? htmlToText(textEl) : '';
    const images = [...article.querySelectorAll<HTMLImageElement>('img[src*="scontent"]')]
      .filter((img) => Math.max(img.naturalWidth, Number(img.getAttribute('width')) || 0) > 100)
      .map((img) => ({ url: img.src, alt: img.alt || undefined }));
    const permalink = article.querySelector('a[href*="/posts/"], a[href*="story_fbid"], a[href*="/permalink/"]')?.getAttribute('href');
    return { site: 'facebook', text, images, sourceUrl: absUrl(permalink, doc) ?? doc.location.href };
  },
};
