import { verifyEvent, type Event, type EventTemplate } from 'nostr-tools/pure';
import type { ExtractedArticle, ExtractedImage } from '../extractors/types';
import { replaceImages } from '../extractors/html-to-markdown';

export interface PostImage {
  url: string;
  mime?: string;
  sha256?: string;
  dim?: string;
  alt?: string;
}

/** NIP-92 inline media metadata tag. */
export function imetaTag(img: PostImage): string[] {
  const tag = ['imeta', `url ${img.url}`];
  if (img.mime) tag.push(`m ${img.mime}`);
  if (img.sha256) tag.push(`x ${img.sha256}`);
  if (img.dim) tag.push(`dim ${img.dim}`);
  if (img.alt) tag.push(`alt ${img.alt.replace(/\s+/g, ' ').trim()}`);
  return tag;
}

export function buildNote(opts: {
  text: string;
  images: PostImage[];
  sourceUrl?: string;
  appendSource?: boolean;
  now?: number;
}): EventTemplate {
  const seen = new Set<string>();
  const images = opts.images.filter((img) => {
    const key = img.sha256 ?? img.url;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const parts = [opts.text.trim()];
  if (images.length) parts.push(images.map((i) => i.url).join('\n'));
  const source = opts.appendSource && opts.sourceUrl ? normalizeUrl(opts.sourceUrl) : undefined;
  if (source) parts.push(source);

  const tags = images.map(imetaTag);
  if (source) tags.push(['r', source]);
  tags.push(['client', 'XMRadar']);

  return {
    kind: 1,
    created_at: opts.now ?? Math.floor(Date.now() / 1000),
    content: parts.filter(Boolean).join('\n\n'),
    tags,
  };
}

export const KIND_ARTICLE = 30023;
export const ARTICLE_WARN_BYTES = 60_000;

/** NIP-23 long-form article. `d` is the tweet ID, so publishing again replaces the earlier version. */
export function buildArticle(opts: {
  tweetId: string;
  title: string;
  summary: string;
  markdown: string;
  cover?: PostImage;
  images: PostImage[];
  sourceUrl: string;
  publishedAt: number;
  appendSource?: boolean;
  now?: number;
}): EventTemplate {
  const source = normalizeUrl(opts.sourceUrl);
  const parts = [opts.markdown.trim()];
  if (opts.appendSource) parts.push(`---\n\nOriginally published on X: ${source}`);
  const seen = new Set<string>();
  const media = [...(opts.cover ? [opts.cover] : []), ...opts.images].filter((img) => !seen.has(img.url) && !!seen.add(img.url));
  const tags = [
    ['d', `x-${opts.tweetId}`],
    ['title', opts.title.trim()],
  ];
  if (opts.summary.trim()) tags.push(['summary', opts.summary.trim()]);
  if (opts.cover) tags.push(['image', opts.cover.url]);
  tags.push(['published_at', String(Math.floor(opts.publishedAt / 1000))], ['r', source], ['alt', `Long-form article: ${opts.title.trim()}`]);
  tags.push(...media.map(imetaTag), ['client', 'XMRadar']);
  return { kind: KIND_ARTICLE, created_at: opts.now ?? Math.floor(Date.now() / 1000), content: parts.join('\n\n'), tags };
}

/**
 * The composer's article, from what the user kept: `prepared` holds the ticked images with their
 * final (uploaded or original) URLs. Unticked images leave the Markdown; an unticked cover drops
 * the image tag.
 */
export function articleTemplate(opts: {
  article: ExtractedArticle;
  postImages: ExtractedImage[];
  prepared: Map<ExtractedImage, PostImage>;
  title: string;
  summary: string;
  markdown: string;
  sourceUrl: string;
  appendSource?: boolean;
  now?: number;
}): EventTemplate {
  const { article, postImages, prepared } = opts;
  // original URL → final URL, or null to drop an unticked image from the Markdown
  const finals = new Map(postImages.map((i) => [i.url, prepared.get(i)?.url ?? null] as const));
  const coverImg = article.cover && postImages.find((i) => i.url === article.cover!.url);
  return buildArticle({
    tweetId: article.id,
    title: opts.title,
    summary: opts.summary,
    markdown: replaceImages(opts.markdown, finals),
    cover: coverImg ? prepared.get(coverImg) : undefined,
    images: postImages.filter((i) => i !== coverImg && prepared.has(i)).map((i) => prepared.get(i)!),
    sourceUrl: opts.sourceUrl,
    publishedAt: article.publishedAt,
    appendSource: opts.appendSource,
    now: opts.now,
  });
}

export const wordCount = (markdown: string) => (markdown.replace(/!\[[^\]]*\]\(<[^>]*>\)|\]\(<[^>]*>\)|[#*_>`\\-]/g, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}'’.]*/gu) ?? []).length;

export const articleTooLarge = (content: string) => new TextEncoder().encode(content).length > ARTICLE_WARN_BYTES;

/**
 * Background-side shape check before publishing: notes, or articles whose `d` matches the
 * X status they were copied from. The signer prompt stays the real boundary.
 */
export function checkPublishable(ev: Event, sourceUrl: string, statusId: (url: string) => string | null): void {
  if (ev.kind === 1) return;
  if (ev.kind === KIND_ARTICLE) {
    const tag = (n: string) => ev.tags.find((t) => t[0] === n)?.[1];
    const id = statusId(sourceUrl);
    if (!id || tag('d') !== `x-${id}`) throw new Error('Article ID does not match its X post');
    if (!tag('title')?.trim()) throw new Error('Article has no title');
    return;
  }
  throw new Error('Refusing to publish this kind of event');
}

/** BUD-02 upload authorization event. */
export function blossomAuthTemplate(sha256: string, now = Math.floor(Date.now() / 1000)): EventTemplate {
  return {
    kind: 24242,
    created_at: now,
    content: 'Upload image',
    tags: [
      ['t', 'upload'],
      ['x', sha256],
      ['expiration', String(now + 300)],
    ],
  };
}

/** Background-side check that an upload authorization really covers this blob. */
export function checkBlossomAuth(header: string, sha256: string, now = Math.floor(Date.now() / 1000)): void {
  let ev: Event;
  try {
    const bin = atob(header.replace(/^Nostr /, ''));
    ev = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch {
    throw new Error('Malformed upload authorization');
  }
  if (!ev || !Array.isArray(ev.tags) || !ev.tags.every(Array.isArray)) throw new Error('Malformed upload authorization');
  const tag = (name: string) => ev.tags.find((t) => t[0] === name)?.[1];
  const { id, pubkey, created_at, kind, tags, content, sig } = ev;
  const expiration = Number(tag('expiration'));
  if (kind !== 24242 || tag('t') !== 'upload' || tag('x') !== sha256 || !Number.isFinite(expiration) || expiration <= now) {
    throw new Error('Upload authorization does not match this image');
  }
  if (!verifyEvent({ id, pubkey, created_at, kind, tags, content, sig })) throw new Error('Invalid upload authorization signature');
}

export function encodeAuthHeader(event: Event): string {
  const bytes = new TextEncoder().encode(JSON.stringify(event));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Nostr ${btoa(bin)}`;
}

/** The signer runs in the page's world, so never trust what comes back without checking it. */
export function checkSigned(template: EventTemplate, signed: Event, pubkey: string): void {
  if (!signed || typeof signed !== 'object') throw new Error('Signer returned nothing');
  if (signed.pubkey !== pubkey) throw new Error('Signer returned an event for a different pubkey');
  if (
    signed.kind !== template.kind ||
    signed.content !== template.content ||
    signed.created_at !== template.created_at ||
    JSON.stringify(signed.tags) !== JSON.stringify(template.tags)
  ) {
    throw new Error('Signer modified the event');
  }
  // copy plain fields: nostr-tools caches verification on a symbol that object spreads carry along
  const { id, pubkey: pk, created_at, kind, tags, content, sig } = signed;
  if (!verifyEvent({ id, pubkey: pk, created_at, kind, tags, content, sig })) throw new Error('Invalid signature');
}

const STRIP_QUERY_HOSTS = /(^|\.)(x\.com|twitter\.com|bsky\.app|linkedin\.com|facebook\.com)$/;
const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$|s$|t$)/;

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    u.hostname = u.hostname.replace(/^(www|mobile|m)\./, '').replace(/^twitter\.com$/, 'x.com');
    if (STRIP_QUERY_HOSTS.test(u.hostname)) u.search = '';
    else for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
    return u.toString().replace(/\/$/, '');
  } catch {
    return raw;
  }
}

export async function sha256Hex(data: BufferSource | string): Promise<string> {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function dedupeKey(sourceUrl: string, text: string): Promise<string> {
  return sha256Hex(`${normalizeUrl(sourceUrl)}\n${text.trim()}`);
}
