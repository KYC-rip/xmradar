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
  /** set for tweets, which get a Xap button in the action bar instead of a badge */
  article?: Element;
}

/** Author handle and slot for a timeline tweet. */
export function tweetSlot(article: Element): BadgeSlot | null {
  const name = article.querySelector('[data-testid="User-Name"]');
  const handle = fromPath(name?.querySelector('a[href^="/"]')?.getAttribute('href'));
  if (!name || !handle) return null;
  const status = name.querySelector('a[href*="/status/"]')?.getAttribute('href') ?? '';
  const tweetId = /\/status\/(\d{1,20})/.exec(status)?.[1] ?? 'x';
  // inside the display-name row, right after the name: on a tweet's own page X stacks the name
  // and @handle rows, and a badge after both would sit on a line of its own
  const row = name.firstElementChild;
  const anchor = row && row.localName !== 'xmradar-badge' && row.querySelector('a[href^="/"]') ? row : name;
  return { handle, key: `${tweetId}:${handle.toLowerCase()}`, anchor, article };
}

/** The profile header ("Name @handle" above the bio) on a profile page. */
export function profileSlot(doc: Document, loc: { hostname: string; pathname: string }): BadgeSlot | null {
  if (!isXHost(loc.hostname)) return null;
  const handle = fromPath(loc.pathname);
  const anchor = doc.querySelector('[data-testid="UserName"]');
  return handle && anchor ? { handle, key: `profile:${handle.toLowerCase()}`, anchor } : null;
}


/** The hover card X shows over a name or avatar: the badge goes after the name and verified tick. */
export function hoverCardSlot(card: Element): BadgeSlot | null {
  // the visible name link; the avatar and @handle links are tabindex=-1 copies
  const link = [...card.querySelectorAll<HTMLAnchorElement>('a[href^="/"][role="link"]')].find((a) => a.getAttribute('tabindex') !== '-1' && fromPath(a.getAttribute('href')) && /^\/[A-Za-z0-9_]{1,15}$/.test(a.getAttribute('href')!));
  const handle = fromPath(link?.getAttribute('href'));
  const row = link?.firstElementChild;
  return handle && row ? { handle, key: `hover:${handle.toLowerCase()}`, anchor: row } : null;
}
