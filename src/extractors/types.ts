export interface ExtractedImage {
  /** the image; for a video, its poster (or '' for a GIF X shows none for) */
  url: string;
  alt?: string;
  /** an X video or GIF (PLAN-XVIDEO); a photo has none */
  kind?: 'video' | 'gif';
  /** X's media id, from the poster's path: what the mp4 lookup matches */
  mediaId?: string;
  /** a GIF's own mp4 on video.twimg.com (videos are looked up instead) */
  mp4?: string;
  /** the tweet the media is in (a thread's later tweet, not the first) */
  statusId?: string;
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
  /** A combined X thread: `[🖼 N]` markers in the text stand for `images[N-1]` (PLAN-THREADS §4). */
  inlineImages?: boolean;
}

export interface Extractor {
  name: string;
  matches(doc: Document): boolean;
  /** Return null when `target` isn't inside a recognisable post. */
  extract(target: Element, doc: Document): ExtractedPost | null;
}
