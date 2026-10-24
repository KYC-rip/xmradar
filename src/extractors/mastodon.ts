import { absUrl, htmlToText } from './html-to-text';
import type { Extractor } from './types';

export const mastodonExtractor: Extractor = {
  name: 'mastodon',
  matches: (doc) =>
    !!doc.querySelector('meta[name="generator"][content*="Mastodon" i]') ||
    !!doc.querySelector('.status__content, .detailed-status'),
  extract(target, doc) {
    const status = target.closest('.detailed-status, .status');
    if (!status) return null;
    const content = status.querySelector('.status__content__text') ?? status.querySelector('.status__content');
    // Mastodon puts the full URL in href and hides parts of the display text with .invisible/.ellipsis
    const text = content ? htmlToText(content, { link: (a) => (a.classList.contains('mention') || a.classList.contains('hashtag') ? null : a.href) }) : '';
    const images = [...status.querySelectorAll('.media-gallery__item')].flatMap((item) => {
      const img = item.querySelector('img');
      if (!img) return [];
      const full = item.querySelector('a[href]')?.getAttribute('href') ?? img.getAttribute('src');
      const url = absUrl(full, doc);
      return url ? [{ url, alt: img.getAttribute('alt') || undefined }] : [];
    });
    const permalink = status.querySelector('a.status__relative-time, a.detailed-status__datetime')?.getAttribute('href');
    return { site: 'mastodon', text, images, sourceUrl: absUrl(permalink, doc) ?? doc.location.href };
  },
};
