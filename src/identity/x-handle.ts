import { isXHost } from '../sender';
import { HANDLE_RE } from './envelope';

// first path segments on x.com that are app pages, not profiles
const RESERVED = new Set([
  'home', 'explore', 'notifications', 'messages', 'i', 'settings', 'search', 'compose',
  'login', 'logout', 'signup', 'tos', 'privacy', 'jobs', 'communities', 'lists', 'bookmarks', 'hashtag',
]);

const fromPath = (path: string | null | undefined): string | null => {
  const seg = path?.split('/')[1];
  return seg && HANDLE_RE.test(seg) && !RESERVED.has(seg.toLowerCase()) ? seg : null;
};

/** The X handle a right-click was about: a profile link, the tweet's author, or the profile page itself. */
export function handleFromTarget(target: Element | null, loc: { hostname: string; pathname: string }): string | null {
  if (!isXHost(loc.hostname)) return null;
  // a right-clicked bare profile link ("/handle", e.g. a mention) wins, but not "/handle/status/…" or "/handle/photo"
  const href = target?.closest<HTMLAnchorElement>('a[href^="/"]')?.getAttribute('href');
  if (href && /^\/[A-Za-z0-9_]{1,15}\/?$/.test(href)) {
    const h = fromPath(href);
    if (h) return h;
  }
  const article = target?.closest('article[data-testid="tweet"]');
  if (article) {
    const link = article.querySelector<HTMLAnchorElement>('[data-testid="User-Name"] a[href^="/"]');
    const h = fromPath(link?.getAttribute('href'));
    if (h) return h;
  }
  return fromPath(loc.pathname);
}

export interface BadgeSlot {
  handle: string;
  /** `tweetId:handle` for tweets, `profile:handle` for a profile header; X reuses DOM nodes, so the slot is keyed by content */
  key: string;
  /** where the badge goes */
  anchor: Element;
}

/** Author handle and slot for a timeline tweet. */
export function tweetSlot(article: Element): BadgeSlot | null {
  const anchor = article.querySelector('[data-testid="User-Name"]');
  const handle = fromPath(anchor?.querySelector('a[href^="/"]')?.getAttribute('href'));
  if (!anchor || !handle) return null;
  const status = anchor.querySelector('a[href*="/status/"]')?.getAttribute('href') ?? '';
  const tweetId = /\/status\/(\d{1,20})/.exec(status)?.[1] ?? 'x';
  return { handle, key: `${tweetId}:${handle.toLowerCase()}`, anchor };
}

/** The profile header ("Name @handle" above the bio) on a profile page. */
export function profileSlot(doc: Document, loc: { hostname: string; pathname: string }): BadgeSlot | null {
  if (!isXHost(loc.hostname)) return null;
  const handle = fromPath(loc.pathname);
  const anchor = doc.querySelector('[data-testid="UserName"]');
  return handle && anchor ? { handle, key: `profile:${handle.toLowerCase()}`, anchor } : null;
}
