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
  /** the tweet's own X status id, when its link has one; a Xap from it tips that post */
  statusId?: string;
}

/** Author handle and slot for a timeline tweet. */
export function tweetSlot(article: Element): BadgeSlot | null {
  const name = article.querySelector('[data-testid="User-Name"]');
  const handle = fromPath(name?.querySelector('a[href^="/"]')?.getAttribute('href'));
  if (!name || !handle) return null;
  // the timestamp link: in the name row on timelines; on a tweet's own page X puts it under the text, so
  // take the article's timestamp link outside any quoted tweet, by the same author
  const own = (a: Element) => {
    const m = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,20})$/.exec(a.getAttribute('href') ?? '');
    return m && m[1]!.toLowerCase() === handle.toLowerCase() ? m[2]! : null;
  };
  const inName = name.querySelector('a[href*="/status/"]');
  const stamp = [...article.querySelectorAll('a[href*="/status/"]')].find((a) => a.querySelector('time') && !a.closest('div[role="link"]') && own(a));
  // both by the tweet's author, so a link to another status can never name the post
  const tweetId = (inName ? own(inName) : stamp && own(stamp)) ?? 'x';
  // inside the display-name row, right after the name: on a tweet's own page X stacks the name
  // and @handle rows, and a badge after both would sit on a line of its own
  const row = name.firstElementChild;
  const anchor = row && row.localName !== 'xmradar-badge' && row.querySelector('a[href^="/"]') ? row : name;
  // only a well-formed id names a post; otherwise the Xap is a profile tip
  const statusId = /^[1-9]\d{0,19}$/.test(tweetId) ? tweetId : undefined;
  return { handle, key: `${tweetId}:${handle.toLowerCase()}`, anchor, article, ...(statusId ? { statusId } : {}) };
}

/**
 * An X Article's reading page (`/<handle>/article/<status id>`): X renders it as its own article element,
 * with no name row, so the author and post come from the URL. Its action bar gets a Xap button.
 */
export function articleViewSlot(article: Element, loc: { hostname: string; pathname: string }): BadgeSlot | null {
  if (!isXHost(loc.hostname)) return null;
  const m = /^\/([A-Za-z0-9_]{1,15})\/article\/([1-9]\d{0,19})(?:\/|$)/.exec(loc.pathname);
  const handle = m ? fromPath(`/${m[1]}`) : null;
  return handle && m ? { handle, key: `${m[2]}:${handle.toLowerCase()}`, anchor: article, article, statusId: m[2]! } : null;
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

/**
 * A person row in X's lists (Relevant people, Who to follow, followers, search): the pill goes after the
 * name, as in the hover card. The name link must point where the row's avatar does, so a mention in the
 * bio is never taken for the row's person.
 */
export function userCellSlot(cell: Element): BadgeSlot | null {
  const links = [...cell.querySelectorAll<HTMLAnchorElement>('a[href^="/"][role="link"]')];
  const avatar = links.find((a) => a.getAttribute('tabindex') === '-1')?.getAttribute('href');
  if (!avatar || !/^\/[A-Za-z0-9_]{1,15}$/.test(avatar)) return null;
  const link = links.find((a) => a.getAttribute('tabindex') !== '-1' && a.getAttribute('href') === avatar);
  const handle = fromPath(avatar);
  const row = link?.firstElementChild;
  return handle && row ? { handle, key: `cell:${handle.toLowerCase()}`, anchor: row } : null;
}
