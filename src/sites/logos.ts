import { normalizeHost, type LogoPackRef, type SiteEntry, type SiteFeed } from './feed';

/**
 * Exchange logos on the saved swap records (PLAN-LOGOS), from xmr.club's logo pack: one file for everyone,
 * named in the signed site list with its SHA-256, downloaded only when that hash changes. It reveals no
 * exchange or record; like the list, the request shows the IP address and its timing.
 */

export interface LogoPack {
  sha256: string;
  /** site id → data:image/webp URI (a null-prototype record; read with `logoFor`) */
  logos: Record<string, string>;
  /** host → site id, for a receipt's issuer: only hosts whose listings all show the same logo */
  hosts: Record<string, string>;
}

const MAX_LOGO_BYTES = 4096;
const DATA_URI = /^data:image\/webp;base64,([A-Za-z0-9+/]+={0,2})$/;
const record = () => Object.create(null) as Record<string, string>;
const own = (r: Record<string, string>, k: string) => (Object.hasOwn(r, k) ? r[k]! : undefined);

/** A logo for a letter (site id) or a receipt (issuer host); undefined without one. */
export function logoFor(pack: LogoPack | null | undefined, ref: { siteId?: string; host?: string }): string | undefined {
  if (!pack) return undefined;
  const id = ref.siteId ?? (ref.host ? own(pack.hosts, normalizeHost(ref.host)) : undefined);
  return id === undefined ? undefined : own(pack.logos, id);
}

/** A WebP file's width and height from its first chunk (VP8, VP8L or VP8X), or null when it isn't one. */
export function webpSize(b: Uint8Array): { width: number; height: number } | null {
  const ascii = (at: number) => String.fromCharCode(...b.subarray(at, at + 4));
  const u32 = (at: number) => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
  if (b.length < 30 || ascii(0) !== 'RIFF' || ascii(8) !== 'WEBP' || u32(4) + 8 !== b.length) return null;
  const chunk = ascii(12);
  if (chunk === 'VP8X') return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = u32(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8 ') {
    // a key frame: the start code, then 14-bit width and height
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: (b[26]! | (b[27]! << 8)) & 0x3fff, height: (b[28]! | (b[29]! << 8)) & 0x3fff };
  }
  return null;
}

const base64Bytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** The pack's logos for the feed's sites: each one a small WebP of at most min(size_px × 2, 64) px a side, or dropped. */
export function readLogos(json: unknown, feed: SiteFeed, sizePx: number): Record<string, string> {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('Logo pack is not an object');
  const ids = new Set(feed.sites.map((s) => s.id));
  const max = Math.min(sizePx * 2, 64);
  const out = record();
  for (const [id, uri] of Object.entries(json as Record<string, unknown>)) {
    if (!ids.has(id) || typeof uri !== 'string') continue;
    const m = DATA_URI.exec(uri);
    if (!m || m[1]!.length > Math.ceil(MAX_LOGO_BYTES / 3) * 4) continue;
    let bytes: Uint8Array;
    try {
      bytes = base64Bytes(m[1]!);
    } catch {
      continue;
    }
    const size = bytes.length <= MAX_LOGO_BYTES ? webpSize(bytes) : null;
    if (size && size.width >= 1 && size.height >= 1 && size.width <= max && size.height <= max) out[id] = uri;
  }
  return out;
}

/** a listing that can issue a saved record: an NKIP-0001 receipt (level 1 and up) or a letter of guarantee */
const issuesRecords = (s: SiteEntry) => (s.nkip01?.level ?? 0) >= 1 || !!s.log;

/**
 * Host → site id, for a receipt's issuer: only listings that can issue a record count (kyc.rip's card and
 * CLI listings share its host but never issue one), and only when they all show the very same logo.
 */
export function logoHosts(feed: SiteFeed, logos: Record<string, string>): Record<string, string> {
  const owners = new Map<string, Set<string>>();
  for (const s of feed.sites.filter(issuesRecords)) for (const h of new Set(s.hosts.map(normalizeHost))) owners.set(h, (owners.get(h) ?? new Set()).add(s.id));
  const out = record();
  for (const [h, ids] of owners) {
    const uris = new Set([...ids].map((id) => own(logos, id)));
    if (uris.size === 1 && !uris.has(undefined)) out[h] = [...ids][0]!;
  }
  return out;
}

/** The kept logos, limited to the feed's sites, with hosts rebuilt from it. */
export function forFeed(sha256: string, logos: Record<string, string>, feed: SiteFeed): LogoPack {
  const ids = new Set(feed.sites.map((s) => s.id));
  const kept = record();
  for (const [id, uri] of Object.entries(logos)) if (ids.has(id)) kept[id] = uri;
  return { sha256, logos: kept, hosts: logoHosts(feed, kept) };
}

interface Item<T> {
  getValue(): Promise<T>;
  setValue(v: T): Promise<void>;
  removeValue(): Promise<void>;
}

export interface LogoDeps {
  held: Item<LogoPack | null>;
  /** the feed kept right now (a download for another hash is dropped) */
  feed(): Promise<SiteFeed | null>;
  fetch: typeof fetch;
  readBody: (res: Response, max: number) => Promise<Uint8Array>;
  sha256Hex(bytes: Uint8Array): Promise<string>;
  /** site info is on */
  enabled(): Promise<boolean>;
}

/**
 * Keeps the pack in step with the feed: hosts and ids follow every feed; the file is fetched only for a new
 * hash, one download per hash, and stored only while the kept feed still names that hash.
 */
export function logoKeeper(deps: LogoDeps) {
  const downloads = new Map<string, Promise<void>>();

  async function download(ref: LogoPackRef) {
    const res = await deps.fetch(ref.url, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!/^application\/json\b/i.test(res.headers.get('content-type') ?? '')) throw new Error('Logo pack is not JSON');
    const body = await deps.readBody(res, ref.bytes);
    if ((await deps.sha256Hex(body)) !== ref.sha256) throw new Error('Logo pack hash mismatch');
    const json = JSON.parse(new TextDecoder().decode(body));
    // still the feed that asked for it, and still on
    const feed = await deps.feed();
    if (feed?.logoPack?.sha256 !== ref.sha256 || !(await deps.enabled())) return;
    await deps.held.setValue(forFeed(ref.sha256, readLogos(json, feed, ref.sizePx), feed));
    // switched off while it was being stored
    if (!(await deps.enabled())) await deps.held.removeValue();
  }

  /** After a feed is kept (or at start). Never throws: the kept pack stays on any failure. */
  async function sync(feed: SiteFeed | null) {
    try {
      if (!feed?.logoPack || !(await deps.enabled())) return void (await deps.held.removeValue());
      const held = await deps.held.getValue();
      // hosts and ids follow every feed, whatever happens to the download
      if (held) await deps.held.setValue(forFeed(held.sha256, held.logos, feed));
      const ref = feed.logoPack;
      if (held?.sha256 === ref.sha256) return;
      let run = downloads.get(ref.sha256);
      if (!run) {
        run = download(ref).finally(() => downloads.delete(ref.sha256));
        downloads.set(ref.sha256, run);
      }
      await run;
    } catch (e) {
      console.warn('[XMRadar] logo pack', (e as Error).message);
    }
  }

  return { sync };
}
