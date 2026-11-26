import { normalizeHost, PLATFORM_HOSTS, type SiteEntry, type SiteFeed } from './feed';
import { logoFor, type LogoPack } from './logos';
import { ANDROID_NATIVE_APP, type NativeRuntimeLike } from '../nostr/native-signer';

/**
 * Bridges XMRadar's already-verified xmr.club site feed and SHA-256-verified logo pack to the
 * standalone Android GeckoView shell (`MainActivity.kt`) over native messaging.
 *
 * - Zero extra network requests: reuses `siteFeedItem` (Ed25519-verified) + `logoPackItem` (SHA-256-verified).
 * - Zero-cost no-op on desktop Chrome/Firefox and AMO Firefox Android (where `nativeMessaging` is absent).
 * - Strips private verification keys, order URL templates, and phishing host lists before sending.
 */

export interface AndroidCatalogSite {
  id: string;
  name: string;
  category: string;
  grade: string;
  incident: boolean;
  intern: boolean;
  internHoldsFunds: boolean;
  hosts: string[];
  nkip01Level: number | null;
  logOnly: boolean;
  hasLog: boolean;
  logo?: string;
}

export interface AndroidSiteCatalogPayload {
  type: 'sync_site_catalog';
  issuedAt: number;
  sites: AndroidCatalogSite[];
}

function toCatalogSite(entry: SiteEntry, pack: LogoPack | null | undefined): AndroidCatalogSite | null {
  const hosts: string[] = [];
  const seen = new Set<string>();
  for (const raw of entry.hosts) {
    const h = normalizeHost(raw);
    if (!h || !h.includes('.') || PLATFORM_HOSTS.has(h) || seen.has(h)) continue;
    seen.add(h);
    hosts.push(h);
  }
  if (hosts.length === 0) return null;
  const logo = logoFor(pack, { siteId: entry.id });
  const out: AndroidCatalogSite = {
    id: entry.id,
    name: entry.name,
    category: entry.category,
    grade: entry.grade,
    incident: entry.incident,
    intern: Boolean(entry.intern),
    internHoldsFunds: entry.intern?.track === 'funds',
    hosts,
    nkip01Level: entry.nkip01 ? entry.nkip01.level : null,
    logOnly: Boolean(entry.nkip01?.logOnly),
    hasLog: Boolean(entry.log),
  };
  if (logo) out.logo = logo;
  return out;
}

export function buildAndroidSiteCatalogPayload(
  feed: SiteFeed | null | undefined,
  pack: LogoPack | null | undefined,
): AndroidSiteCatalogPayload {
  if (!feed) {
    return { type: 'sync_site_catalog', issuedAt: 0, sites: [] };
  }
  const sites: AndroidCatalogSite[] = [];
  for (const s of feed.sites) {
    const item = toCatalogSite(s, pack);
    if (item) sites.push(item);
  }
  return {
    type: 'sync_site_catalog',
    issuedAt: feed.issuedAt,
    sites,
  };
}

export function hasAndroidNativeCatalogBridge(runtime: NativeRuntimeLike | undefined): boolean {
  if (typeof runtime?.sendNativeMessage !== 'function') return false;
  if (typeof runtime.getManifest === 'function') {
    try {
      const perms = runtime.getManifest()?.permissions;
      if (Array.isArray(perms) && !perms.includes('nativeMessaging')) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Sends the verified site catalog + logos to the Android native shell when running in the APK. */
export async function syncAndroidSiteCatalog(
  runtime: NativeRuntimeLike | undefined,
  feed: SiteFeed | null | undefined,
  pack: LogoPack | null | undefined,
): Promise<boolean> {
  if (!hasAndroidNativeCatalogBridge(runtime)) return false;
  if (typeof runtime?.getPlatformInfo === 'function') {
    try {
      const info = await runtime.getPlatformInfo();
      if (info?.os && info.os !== 'android') return false;
    } catch {
      // Proceed if getPlatformInfo fails; sendNativeMessage itself is best-effort.
    }
  }
  const payload = buildAndroidSiteCatalogPayload(feed, pack);
  try {
    await runtime!.sendNativeMessage!(ANDROID_NATIVE_APP, payload);
    return true;
  } catch {
    return false;
  }
}
