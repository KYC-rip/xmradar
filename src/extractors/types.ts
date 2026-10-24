export interface ExtractedImage {
  url: string;
  alt?: string;
}

export interface ExtractedArticle {
  /** Tweet ID the article is published under; also its Nostr `d` tag. */
  id: string;
  title: string;
  markdown: string;
  summary: string;
  cover?: ExtractedImage;
  /** Inline images, in order. Not the cover; `ExtractedPost.images` is cover + inline. */
  images: ExtractedImage[];
  /** ms since epoch */
  publishedAt: number;
}

export interface ExtractedPost {
  site: string;
  text: string;
  images: ExtractedImage[];
  sourceUrl: string;
  /** Set for long-form X Articles. */
  article?: ExtractedArticle;
  /** A tweet that only shares an X Article (the full article is on its own page). */
  articleCard?: boolean;
}

export interface Extractor {
  name: string;
  matches(doc: Document): boolean;
  /** Return null when `target` isn't inside a recognisable post. */
  extract(target: Element, doc: Document): ExtractedPost | null;
}
