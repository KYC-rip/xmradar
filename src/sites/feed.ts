import { verifySignedEnvelope } from '../identity/envelope';

/**
 * Site info from the signed xmr.club feed (PLAN-SITEFEED): one file, the same for everyone, downloaded
 * about twice a day and matched against the current tab's host on the device. Nothing about the sites
 * you visit leaves the browser.
 */

export const FEED_URL = 'https://xmr.club/api/v1/swap-sites.json';
/**
 * xmr.club's feed key, also published at https://xmr.club/.well-known/xmrclub-feed-key.txt and, from its
 * next refresh, in xmr.club's PGP-signed warrant canary. All of these are xmr.club's own channels, so
 * XMRadar says "data from xmr.club", never "independently verified". A set, so a rotation can ship both.
 */
export const PINNED_XMRCLUB_KEYS: ReadonlySet<string> = new Set(['8046f1d1d6712a415124aea6b7bc266b16b1dd3c9dd89f3ffe6c819ec7023d17']);
/** clocks differ; a feed issued further ahead than this is refused */
const MAX_SKEW_SECS = 600;

/**
 * Hosts that serve many unrelated services (code hosting, video, forums, chat): a listing that lives
 * there is a page on the platform, not the platform, so they never get a badge or a banner. xmr.club
 * leaves them out of the feed too; this list is the second line.
 */
export const PLATFORM_HOSTS: ReadonlySet<string> = new Set([
  'github.com',
  'gitlab.com',
  'codeberg.org',
  'youtube.com',
  'reddit.com',
  'x.com',
  'twitter.com',
  'matrix.to',
  't.me',
  'telegram.me',
  'medium.com',
  'substack.com',
  'mastodon.social',
  'discord.com',
  'discord.gg',
]);

export interface SiteNkip01 {
  level: 0 | 1 | 2 | 3;
  /** a per-order letter of guarantee, but no NKIP-0001 manifest */
  logOnly: boolean;
  checkedAt: number | null;
  /** the last check that really ran (a failed one only moves checkedAt) */
  lastOkAt: number | null;
  l3VerifiedAt: number | null;
}

export interface IncidentDetail {
  /** YYYY-MM-DD */
  date: string;
  severity: string;
  summary: string;
  sourceUrl: string | null;
}

export interface SiteEntry {
  id: string;
  name: string;
  category: string;
  /** A–F with an optional + or − (`B-`), or '' when the listing has none */
  grade: string;
  /** an open incident (resolved ones aren't in the feed) */
  incident: boolean;
  /** what the open incident is, when xmr.club says */
  incidentDetail?: IncidentDetail;
  /** the listing on xmr.club */
  url: string;
  hosts: string[];
  /** absent: out of NKIP-0001 scope (not level 0) */
  nkip01?: SiteNkip01;
}

/** bumped when XMRadar reads more of the feed, so a copy kept by an older version is fetched again */
export const FEED_READER_V = 3;

export interface SiteFeed {
  /** the FEED_READER_V that parsed it */
  reader?: number;
  issuedAt: number;
  expiresAt: number;
  sites: SiteEntry[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 200) => typeof v === 'string' && v.length <= max;
const int = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const HOST_RE = /^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const IP_RE = /^\d+\.\d+\.\d+\.\d+$/;

/** A feed host: lowercase name with a dot, no IP, no localhost; onion names are fine. */
export const validFeedHost = (h: unknown): h is string => typeof h === 'string' && HOST_RE.test(h) && !IP_RE.test(h) && !h.endsWith('.localhost') && !h.endsWith('.local');

function parseSite(v: unknown): SiteEntry | null {
  if (!isObj(v) || !str(v.id, 100) || !str(v.name) || !str(v.category, 50) || typeof v.incident !== 'boolean') return null;
  if (!(v.grade === '' || v.grade === null || v.grade === undefined || (typeof v.grade === 'string' && /^[A-F][+-]?$/.test(v.grade)))) return null;
  // the listing link must be on xmr.club, so the popup and banner never link elsewhere
  if (typeof v.url !== 'string' || !/^https:\/\/xmr\.club\/[A-Za-z0-9/_.-]*$/.test(v.url) || v.url.includes('..')) return null;
  const hosts = Array.isArray(v.hosts) ? v.hosts.filter(validFeedHost) : [];
  if (!hosts.length) return null;
  const site: SiteEntry = { id: v.id as string, name: v.name as string, category: v.category as string, grade: (v.grade as string) || '', incident: v.incident, url: v.url, hosts };
  const d = v.incident_detail;
  if (site.incident && isObj(d) && typeof d.summary === 'string' && d.summary.trim() && typeof d.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.date)) {
    site.incidentDetail = {
      date: d.date,
      severity: typeof d.severity === 'string' && /^[a-z]{1,12}$/.test(d.severity) ? d.severity : '',
      summary: d.summary.trim().slice(0, 2000),
      // a link the popup opens: https only
      sourceUrl: typeof d.source_url === 'string' && /^https:\/\/[^\s"<>]+$/.test(d.source_url) ? d.source_url : null,
    };
  }
  const n = v.nkip01;
  if (isObj(n) && [0, 1, 2, 3].includes(n.level as number)) {
    site.nkip01 = {
      level: n.level as SiteNkip01['level'],
      logOnly: n.log_only === true,
      checkedAt: int(n.checked_at) ? (n.checked_at as number) : null,
      lastOkAt: int(n.last_ok_at) ? (n.last_ok_at as number) : null,
      l3VerifiedAt: int(n.l3_verified_at) ? (n.l3_verified_at as number) : null,
    };
  }
  return site;
}

/**
 * The feed, accepted only if signed with a pinned key, version 1 from xmr.club, not expired, not
 * issued in the future, and newer than the copy already kept (no rollback). Bad entries are dropped.
 */
export function readFeed(envelope: unknown, nowSecs: number, keptIssuedAt = 0, keys = PINNED_XMRCLUB_KEYS): SiteFeed {
  const { data } = verifySignedEnvelope(envelope, keys);
  if (!isObj(data) || data.v !== 1 || data.issuer !== 'xmr.club' || !int(data.issued_at) || !int(data.expires_at) || !Array.isArray(data.sites)) throw new Error('Not an xmr.club site feed');
  const issuedAt = data.issued_at as number;
  const expiresAt = data.expires_at as number;
  if (nowSecs >= expiresAt) throw new Error('Feed expired');
  if (issuedAt > nowSecs + MAX_SKEW_SECS) throw new Error('Feed issued in the future');
  if (issuedAt <= keptIssuedAt) throw new Error('Feed is not newer than the one kept');
  return { reader: FEED_READER_V, issuedAt, expiresAt, sites: data.sites.map(parseSite).filter((s): s is SiteEntry => !!s) };
}

/** A page host as the feed writes hosts: lowercase, no trailing dot, no leading `www.`. */
export const normalizeHost = (host: string) =>
  host
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '');

/** Every listing for this exact host (all of them, never one picked); none for a platform host. */
export function sitesFor(feed: SiteFeed, host: string): SiteEntry[] {
  const h = normalizeHost(host);
  if (!h || PLATFORM_HOSTS.has(h)) return [];
  return feed.sites.filter((s) => s.hosts.includes(h));
}

/** How bad a grade is: none 0, A+ 1, A 2, A− 3, B+ 4 … F− 18. */
const gradeRank = (g: string) => (g ? ('ABCDEF'.indexOf(g[0]!) * 3 + (g[1] === '+' ? 1 : g[1] === '-' ? 3 : 2)) : 0);
/** the worst grade among the listings: F− > … > A+ > none */
export const worstGrade = (sites: SiteEntry[]) => sites.reduce((w, s) => (gradeRank(s.grade) > gradeRank(w) ? s.grade : w), '');

/** A banner only for an open incident or a D, E or F grade (with any + or −). */
export const needsBanner = (sites: SiteEntry[]) => sites.some((s) => s.incident) || ['D', 'E', 'F'].includes(worstGrade(sites)[0] ?? '');

export function levelText(n: SiteNkip01 | undefined): string | null {
  if (!n) return null;
  if (n.level === 0 && n.logOnly) return 'Letter of guarantee only';
  return ['No verifiable receipts yet', 'NKIP-0001 manifest only', 'NKIP-0001 · attesting', 'NKIP-0001 · verified receipts'][n.level]!;
}

// ---- the toolbar badge, one owner per tab ----

export type ReceiptLevel = 'ok' | 'caution' | 'warn';
export interface TabState {
  receipt?: ReceiptLevel;
  site?: { grade: string; incident: boolean };
}

/** The badge from both inputs, highest first: receipt warn, site incident, receipt caution, receipt ok, listed site. */
export function badgeFor(s: TabState): { text: string; color: string } {
  if (s.receipt === 'warn') return { text: '!', color: '#d93025' };
  if (s.site?.incident) return { text: s.site.grade || '!', color: '#d93025' };
  if (s.receipt === 'caution') return { text: '!', color: '#b26a00' };
  if (s.receipt === 'ok') return { text: '✓', color: '#1e7d34' };
  if (s.site) return { text: s.site.grade || '•', color: '#6b6880' };
  return { text: '', color: '#000000' };
}

/** The first sentence of an incident summary, at most `max` characters, for the banner and the menu. */
export function firstSentence(text: string, max = 180): string {
  const m = /^.*?[.!?](?=\s|$)/.exec(text.trim());
  const s = (m ? m[0] : text.trim()).trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** "high, 2026-10-27" or just the date. */
export const incidentWhen = (d: IncidentDetail) => [d.severity, d.date].filter(Boolean).join(', ');

