import { absUrl, htmlToText } from './html-to-text';
import type { ExtractedImage, ExtractedPost } from './types';

const meta = (doc: Document, prop: string) =>
  doc.querySelector(`meta[property="${prop}"], meta[name="${prop}"]`)?.getAttribute('content') ?? undefined;

export function genericExtract(target: Element | null, doc: Document, srcUrl?: string): ExtractedPost {
  const container = target?.closest('article, [role="article"]');
  const text = container ? htmlToText(container) : meta(doc, 'og:description') ?? doc.title;
  const images: ExtractedImage[] = [];
  const img = target?.closest('img');
  const imgUrl = srcUrl ?? absUrl(img?.getAttribute('src'), doc) ?? absUrl(meta(doc, 'og:image'), doc);
  if (imgUrl) images.push({ url: imgUrl, alt: img?.getAttribute('alt') || undefined });
  return { site: 'generic', text, images, sourceUrl: meta(doc, 'og:url') ?? doc.location.href };
}
