/**
 * X's share tracking taken out of links (PLAN-CLEANLINKS): "Copy link" gives
 * `https://x.com/<user>/status/<id>?a=<token>&s=20`, where `s` names the app that shared it and `a`
 * (formerly `t`) is a fresh token per share. A post link needs no query at all.
 */

const HOSTS = new Set(['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']);
const POST = /^\/(?:[A-Za-z0-9_]{1,15}|i|i\/web)\/status\/\d+(?:\/(?:photo\/\d+|video\/\d+|analytics|quotes|retweets|likes))?\/?$/;
const RESERVED = new Set(['home', 'explore', 'search', 'i', 'settings', 'messages', 'notifications', 'compose', 'login', 'logout', 'signup', 'tos', 'privacy', 'hashtag', 'intent', 'share']);
// a profile or one of its pages (media, likes, followers_you_follow, lists…)
const PROFILE_TAB = /^\/([A-Za-z0-9_]{1,15})(?:\/[a-z_]{1,30})?\/?$/;
// share tokens and referrers, on every X URL; parameter names in any case
const TRACKING = /^(s|a|ref|ref_src|ref_url|utm_.*)$/i;

/** The X URL without share tracking, or null when it isn't an X URL or has none. */
export function cleanXUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !HOSTS.has(u.hostname) || u.username || u.password || u.port) return null;
  if (POST.test(u.pathname)) {
    if (!u.search && !u.hash) return null;
    u.search = '';
    u.hash = '';
    return u.toString();
  }
  const profile = PROFILE_TAB.exec(u.pathname);
  // `t` is the old share token on profiles; elsewhere (search) it may mean something
  const drop = (k: string) => TRACKING.test(k) || (!!profile && !RESERVED.has(profile[1]!.toLowerCase()) && k.toLowerCase() === 't');
  const keys = [...u.searchParams.keys()].filter(drop);
  if (!keys.length) return null;
  for (const k of keys) u.searchParams.delete(k);
  return u.toString();
}

// a link runs to whitespace or a quote, or to a `,` `.` `;` that a next link follows straight on
const URL_RUN = /https?:\/\/(?:(?![,.;]https?:\/\/)[^\s<>"'`])+/gi;
const TRAIL = /[.,;:!?'"’”»」』]+$/;
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/** The URL as written in prose: trailing punctuation and an unmatched closing bracket are not part of it. */
function trimRun(run: string): string {
  for (;;) {
    const before = run;
    run = run.replace(TRAIL, '');
    const last = run.at(-1);
    if (last && CLOSERS[last]) {
      const opens = run.split(CLOSERS[last]).length - 1;
      const closes = run.split(last).length - 1;
      if (closes > opens) run = run.slice(0, -1);
    }
    if (run === before) return run;
  }
}

/** Every X link in a text cleaned in place; everything else as it was. */
export function cleanXLinks(text: string): string {
  return text.replace(URL_RUN, (run) => {
    const url = trimRun(run);
    const clean = cleanXUrl(url);
    return clean ? clean + run.slice(url.length) : run;
  });
}
