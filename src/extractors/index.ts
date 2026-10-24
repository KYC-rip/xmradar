import { blueskyExtractor } from './bluesky';
import { facebookExtractor } from './facebook';
import { genericExtract } from './generic';
import { linkedinExtractor } from './linkedin';
import { mastodonExtractor } from './mastodon';
import type { ExtractedPost, Extractor } from './types';
import { xExtractor } from './x';

export type { ExtractedImage, ExtractedPost } from './types';

// order matters: mastodon detection is selector-based and could match anywhere
export const extractors: Extractor[] = [xExtractor, blueskyExtractor, linkedinExtractor, facebookExtractor, mastodonExtractor];

export interface ExtractResult {
  post: ExtractedPost;
  /** Set when no site-specific post was found and the generic fallback was used. */
  fallback: boolean;
}

export function extractPost(target: Element | null, doc: Document, opts: { selection?: string; srcUrl?: string } = {}): ExtractResult {
  let post: ExtractedPost | null = null;
  if (target) {
    for (const ex of extractors) {
      if (!ex.matches(doc)) continue;
      post = ex.extract(target, doc);
      if (post) break;
    }
  }
  const fallback = !post;
  post ??= genericExtract(target, doc, opts.srcUrl);
  // an explicit selection is the clearest signal of what the user wants to share
  const selection = opts.selection?.trim();
  if (selection) post = { ...post, text: selection };
  return { post, fallback };
}
