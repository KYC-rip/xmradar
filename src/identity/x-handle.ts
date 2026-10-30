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

/** The profile header in the main column: X keeps it while it swaps in the next profile's text. */
export const profileHeader = (doc: Document) => doc.querySelector('[data-testid="primaryColumn"] [data-testid="UserName"]') ?? doc.querySelector('[data-testid="UserName"]');

/**
 * The profile header ("Name @handle" above the bio) on a profile page, only once it shows the page's
 * @handle: right after X's client-side navigation the header still shows the previous profile.
 */
export function profileSlot(doc: Document, loc: { hostname: string; pathname: string }): BadgeSlot | null {
  if (!isXHost(loc.hostname)) return null;
  const handle = fromPath(loc.pathname);
  const anchor = profileHeader(doc);
  if (!handle || !anchor) return null;
  // the @handle row comes after the name, so the last @handle in the header is the one; read per text
  // node, as the header's text runs together ("@foo" + "Follows you" = "@fooFollows you")
  const texts: string[] = [];
  const walker = doc.createTreeWalker(anchor, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n.textContent ?? '');
  const shown = texts.flatMap((t) => [...t.matchAll(/@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/g)].map((m) => m[1])).pop();
  return shown?.toLowerCase() === handle.toLowerCase() ? { handle, key: `profile:${handle.toLowerCase()}`, anchor } : null;
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

/** The pin icon of X's "Pinned" row; its label is localised, the icon isn't (PLAN-XCLAIMS §8). */
const PIN_PATH = 'M13 21l-1 2-1-2v-5H4.5v-2.287';

/** One place on a profile, read in full: `text` null means the place isn't there (no bio, no Website). */
export interface ClaimRead {
  text: string | null;
}

export interface ProfileClaimScope {
  handle: string;
  /** null while the header hasn't rendered in full, so nothing can be removed */
  bio: ClaimRead | null;
  url: ClaimRead | null;
}

const CLAIM_TABS = /^\/([A-Za-z0-9_]{1,15})(?:\/(?:with_replies|media|likes|highlights|articles))?\/?$/;

/**
 * A profile page's bio and Website field, bound to the page's handle (X5): the path is the profile or
 * one of its tabs, the main column's header shows that @handle, and the header has rendered as far as
 * its items row (location, Website, join date), so a missing bio or Website is really missing.
 */
export function profileClaimScope(doc: Document, loc: { hostname: string; pathname: string }): ProfileClaimScope | null {
  if (!isXHost(loc.hostname)) return null;
  const m = CLAIM_TABS.exec(loc.pathname);
  const handle = m ? fromPath(`/${m[1]}`) : null;
  const column = doc.querySelector('[data-testid="primaryColumn"]');
  if (!handle || !column) return null;
  const slot = profileSlot(doc, loc);
  if (!slot || !column.contains(slot.anchor)) return null;
  const items = column.querySelector('[data-testid="UserProfileHeader_Items"]');
  if (!items) return { handle, bio: null, url: null };
  const desc = column.querySelector('[data-testid="UserDescription"]');
  const url = items.querySelector('[data-testid="UserUrl"]');
  return { handle, bio: { text: desc ? (desc.textContent ?? '') : null }, url: { text: url ? (url.textContent ?? '') : null } };
}

export interface PinnedRead {
  /** the first post, its text without a quoted post; null when it isn't the account's pinned post */
  text: string | null;
  tweetId?: string;
  /** the element read, so a caller can wait for it to stay */
  article: Element;
}

/**
 * The profile's pinned post (§8): the main column's first post, marked by a social-context row with the
 * pin icon that isn't a link (a repost's context links to the reposter), written by the profile itself.
 * Only on the profile's main tab, where X shows the pinned post first.
 */
export function pinnedPost(doc: Document, loc: { hostname: string; pathname: string }, handle: string): PinnedRead | null {
  if (!isXHost(loc.hostname) || !/^\/[A-Za-z0-9_]{1,15}\/?$/.test(loc.pathname) || fromPath(loc.pathname)?.toLowerCase() !== handle.toLowerCase()) return null;
  const article = doc.querySelector('[data-testid="primaryColumn"] article[data-testid="tweet"]');
  if (!article) return null;
  const ctx = article.querySelector('[data-testid="socialContext"]');
  // the row's icon: the nearest block around the label that holds an svg, short of the author's name row
  let row: Element | null = ctx;
  while (row && row !== article && !row.querySelector('svg')) row = row.parentElement;
  const icon = row && row !== article && !row.querySelector('[data-testid="User-Name"]') ? row.querySelector('svg path') : null;
  const pinned = !!ctx && !ctx.closest('a') && !!icon?.getAttribute('d')?.startsWith(PIN_PATH);
  const slot = tweetSlot(article);
  if (!pinned || slot?.handle.toLowerCase() !== handle.toLowerCase()) return { text: null, article };
  // the post's own text: a quoted post sits in a role=link block with its own tweetText
  const own = [...article.querySelectorAll('[data-testid="tweetText"]')].filter((t) => !t.closest('div[role="link"]'));
  return { text: own.map((t) => t.textContent ?? '').join('\n'), ...(slot.statusId ? { tweetId: slot.statusId } : {}), article };
}
