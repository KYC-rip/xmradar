import { normalizeHost, sitesFor, type SiteEntry, type SiteFeed } from '../sites/feed';

/**
 * The order page of a saved receipt or letter (PLAN-RECORDVIEW), from the listing's `orderUrl` template in
 * the xmr.club feed: nothing more than origin and path is ever stored, so the order's own page is rebuilt
 * from its reference. Background only, like the templates themselves (`publicSite`).
 */

const ORDER_ID = /^[\x21-\x7e]{1,128}$/;

/** The template with `orderId` in place, or null when anything about the result is off. */
export function orderLink(template: string, orderId: string, hosts: string[]): string | null {
  if (!ORDER_ID.test(orderId) || orderId === '.' || orderId === '..') return null;
  if (template.split('{order}').length !== 2) return null;
  const encoded = encodeURIComponent(orderId);
  let u: URL;
  try {
    u = new URL(template.replace('{order}', encoded));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash) return null;
  if (!hosts.map(normalizeHost).includes(normalizeHost(u.hostname))) return null;
  // the reference survived parsing where the template put it (no path step swallowed it)
  if (!(u.pathname + u.search).includes(encoded)) return null;
  return u.href;
}

const current = (feed: SiteFeed | null, now: number): feed is SiteFeed => !!feed && feed.expiresAt * 1000 > now;
const issuesReceipts = (s: SiteEntry) => (s.nkip01?.level ?? 0) >= 1 || s.log?.format === 'nkip01';

/** One template among the listings on the receipt's issuer host that issue receipts; several different ones → null. */
export function receiptOrderLink(feed: SiteFeed | null, issuer: string, orderId: string, now: number): string | null {
  if (!current(feed, now)) return null;
  const sites = sitesFor(feed, issuer).filter((s) => s.orderUrl && issuesReceipts(s));
  const templates = new Set(sites.map((s) => s.orderUrl!));
  if (templates.size !== 1) return null;
  return orderLink([...templates][0]!, orderId, sites[0]!.hosts);
}

export function letterOrderLink(feed: SiteFeed | null, siteId: string, orderId: string, now: number): string | null {
  if (!current(feed, now)) return null;
  const site = feed.sites.find((s) => s.id === siteId);
  return site?.orderUrl ? orderLink(site.orderUrl, orderId, site.hosts) : null;
}
