export interface ExtractedImage {
  url: string;
  alt?: string;
}

export interface ExtractedPost {
  site: string;
  text: string;
  images: ExtractedImage[];
  sourceUrl: string;
}

export interface Extractor {
  name: string;
  matches(doc: Document): boolean;
  /** Return null when `target` isn't inside a recognisable post. */
  extract(target: Element, doc: Document): ExtractedPost | null;
}
