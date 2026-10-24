import { htmlToText } from './html-to-text';
import type { Extractor } from './types';

export const linkedinExtractor: Extractor = {
  name: 'linkedin',
  matches: (doc) => /(^|\.)linkedin\.com$/.test(doc.location?.hostname ?? ''),
  extract(target, doc) {
    const root = target.closest('.feed-shared-update-v2, [data-urn^="urn:li:activity:"]');
    if (!root) return null;
    const textEl = root.querySelector('.update-components-text, .feed-shared-update-v2__description');
    const text = textEl ? htmlToText(textEl) : '';
    const images = [...root.querySelectorAll('.update-components-image img')].map((img) => ({
      url: img.getAttribute('src') ?? '',
      alt: img.getAttribute('alt') || undefined,
    })).filter((i) => i.url);
    const urn = (root.closest('[data-urn]') ?? root.querySelector('[data-urn]'))?.getAttribute('data-urn');
    const sourceUrl = urn?.startsWith('urn:li:activity:') ? `https://www.linkedin.com/feed/update/${urn}/` : doc.location.href;
    return { site: 'linkedin', text, images, sourceUrl };
  },
};
