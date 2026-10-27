import { blueskyExtractor } from './bluesky';
import { facebookExtractor } from './facebook';
import { genericExtract } from './generic';
import { linkedinExtractor } from './linkedin';
import { mastodonExtractor } from './mastodon';
import type { ExtractedPost, Extractor } from './types';
import { xExtractor } from './x';
import { xArticleExtractor } from './x-article';

export type { ExtractedArticle, ExtractedImage, ExtractedPost } from './types';

// order matters: X Articles live at /status/ URLs too, so they go before tweets; mastodon detection is selector-based and could match anywhere
export const extractors: Extractor[] = [xArticleExtractor, xExtractor, blueskyExtractor, linkedinExtractor, facebookExtractor, mastodonExtractor];

export interface ExtractResult {
  post: ExtractedPost;
  /** Set when no site-specific post was found and the generic fallback was used. */
  fallback: boolean;
}

export function extractPost(target: Element | null, doc: Document, opts: { selection?: string; srcUrl?: string } = {}): ExtractResult {
  let post: ExtractedPost | null = null;
  // no target (shortcut with nothing hovered): site extractors can still use the page itself
  const from = target ?? doc.body;
  if (from) {
    for (const ex of extractors) {
      if (!ex.matches(doc)) continue;
      post = ex.extract(from, doc);
      if (post) break;
    }
  }
  const fallback = !post;
  post ??= genericExtract(target, doc, opts.srcUrl);
  // an explicit selection is the clearest signal of what the user wants to share
  const selection = opts.selection?.trim();
  // (and means "share this fragment as a note", even inside an article)
  if (selection) {
    const { article: _article, ...rest } = post;
    post = { ...rest, text: selection };
  }
  return { post, fallback };
}
