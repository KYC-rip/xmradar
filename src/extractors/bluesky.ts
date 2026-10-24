import { absUrl, htmlToText, resolveDisplayedLink } from './html-to-text';
import type { Extractor } from './types';

export const blueskyExtractor: Extractor = {
  name: 'bluesky',
  matches: (doc) => /(^|\.)bsky\.app$/.test(doc.location?.hostname ?? ''),
  extract(target, doc) {
    const item = target.closest('[data-testid^="postThreadItem"], [data-testid^="feedItem"]');
    if (!item) return null;
    // quoted posts are embedded inside the item; prefer nodes that aren't part of an embed
    const own = (el: Element) => {
      const embed = el.closest('[data-testid*="embed" i]');
      return !embed || embed === item || !item.contains(embed);
    };
    const hasEmbed = [...item.querySelectorAll('[data-testid*="embed" i]')].some((e) => e !== item);
    const textEl = [...item.querySelectorAll('[data-testid="postText"]')].find(own) ?? (hasEmbed ? null : item.querySelector('[data-testid="postText"]'));
    const text = textEl ? htmlToText(textEl, { link: (a) => (a.getAttribute('href')?.startsWith('/') ? null : resolveDisplayedLink(a)) }) : '';
    const images = [...item.querySelectorAll('img[src*="cdn.bsky.app/img/feed_"]')].filter(own).map((img) => ({
      url: (img.getAttribute('src') ?? '').replace('/img/feed_thumbnail/', '/img/feed_fullsize/'),
      alt: img.getAttribute('alt') || undefined,
    }));
    const permalink = ([...item.querySelectorAll('a[href*="/post/"]')].find(own) ?? (hasEmbed ? null : item.querySelector('a[href*="/post/"]')))?.getAttribute('href');
    return { site: 'bluesky', text, images, sourceUrl: absUrl(permalink, doc) ?? doc.location.href };
  },
};
