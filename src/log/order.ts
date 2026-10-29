import { normalizeHost, PLATFORM_HOSTS, type SiteEntry, type SiteLog } from '../sites/feed';

/**
 * Recognising an operator's order page from the feed's `order_url` (PLAN-LOG §2). Runs in the
 * background on the tab's URL from the browser, never on a URL a page sends.
 */

/** what an order id may look like; anything else is not an order page */
export const ORDER_RE = /^[A-Za-z0-9_-]{4,80}$/;
const SLOT = 'ORDERSLOT';

/** Background-only: carries the feed's letter keys. A message to a page sends a projection without `site.log` or `log`. */
export interface OrderMatch {
  site: SiteEntry;
  log: SiteLog;
  orderId: string;
  /** the letter on the page's own origin (an onion mirror keeps its onion), or null if the feed has none */
  letterUrl: string | null;
}

/** The order id if `page` is an order page of `template` (same path segments; the slot as a whole segment or query value). */
export function orderIdFor(template: string, page: URL): string | null {
  const t = new URL(template.replace('{order}', SLOT));
  const trim = (p: string) => p.replace(/\/+$/, '').split('/');
  const ts = trim(t.pathname);
  const ps = trim(page.pathname);
  if (ts.length !== ps.length) return null;
  let id: string | null = null;
  for (let i = 0; i < ts.length; i++) {
    if (ts[i] === SLOT) id = ps[i]!;
    else if (ts[i] !== ps[i]) return null;
  }
  for (const [name, value] of t.searchParams) {
    // a parameter given twice is ambiguous: not an order page
    const all = page.searchParams.getAll(name);
    const got = all.length === 1 ? all[0]! : null;
    if (value === SLOT) id = got;
    else if (got !== value) return null;
  }
  return id !== null && ORDER_RE.test(id) ? id : null;
}

/** The letter URL for this order, moved onto the page's origin; null if the feed names none. */
export function letterUrlFor(log: SiteLog, orderId: string, page: URL): string | null {
  if (log.format === 'nkip01' || !log.url) return null;
  const u = new URL(log.url.replace('{order}', orderId));
  return `${page.origin}${u.pathname}${u.search}`;
}

/** Order pages are https, or http on an onion mirror, on the default port (feed templates have none either). */
const pageOk = (u: URL) => !u.port && !u.username && !u.password && (u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname.endsWith('.onion')));

/**
 * Every listing for which `pageUrl` is an order page, with its order id. Several listings can share a
 * host and a template (kyc.rip): all are returned, none is picked.
 */
export function matchOrderPage(sites: SiteEntry[], pageUrl: string): OrderMatch[] {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return [];
  }
  const host = normalizeHost(page.hostname);
  // a listing on a shared platform is a page there, not the platform (as for badges)
  if (!pageOk(page) || PLATFORM_HOSTS.has(host)) return [];
  const out: OrderMatch[] = [];
  for (const site of sites) {
    if (!site.orderUrl || !site.log || !site.hosts.includes(host)) continue;
    const orderId = orderIdFor(site.orderUrl, page);
    if (orderId) out.push({ site, log: site.log, orderId, letterUrl: letterUrlFor(site.log, orderId, page) });
  }
  return out;
}
