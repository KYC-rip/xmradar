import { verifyEvent, type Event, type EventTemplate } from 'nostr-tools/pure';

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
