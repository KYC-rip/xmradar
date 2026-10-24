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
