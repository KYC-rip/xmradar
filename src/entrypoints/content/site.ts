import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { storage } from 'wxt/utils/storage';
import { sendToBackground, type SiteInfo } from '../../messaging';
import { isXHost } from '../../sender';
import { firstSentence, incidentWhen, internCaution, leadSite, needsBanner, normalizeHost, type SiteEntry } from '../../sites/feed';
import { isCoinListing, lookalikeHref, lookalikeText, type Lookalike } from '../../sites/lookalike-text';
import { siteInfoOn, siteWarningsOn, xmrSettingsItem } from '../../settings';
import { h } from './dom';

/**
 * Site info from the xmr.club feed on the page (PLAN-SITEFEED §2, §3): only `location.hostname` goes to
 * the background, which matches it against the downloaded feed. A banner appears only for an open
 * incident, a D–F grade, a funds intern or a site posing as a listed one, bottom centre (sites keep their menus at the top; the receipt chip is top
 * right), and × hides it for 7 days.
 */

export const DISMISS_MS = 7 * 24 * 3600_000;
const dismissedItem = storage.defineItem<Record<string, number>>('local:siteBannerDismissed', { fallback: {} });

const CSS = `
:host { all: initial; }
.bar { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); z-index: 2147483646; width: max-content; max-width: min(560px, calc(100vw - 32px));
  display: flex; gap: 10px; align-items: center; padding: 8px 10px 8px 14px; border-radius: 10px; border: 1px solid #d93025;
  font: 13px/1.45 system-ui, -apple-system, sans-serif; color: #1d1b26; background: #fff; box-shadow: 0 6px 24px rgba(0,0,0,.18); }
.msg { flex: 1; min-width: 0; }
.msg b { color: #d93025; }
/* an intern: a caution, not an alarm */
.bar.caution { border-color: #b26a00; }
.bar.caution .msg b { color: #b26a00; }
a { color: #7b3fe4; white-space: nowrap; }
button { font: inherit; border: 0; background: transparent; font-size: 16px; line-height: 1; padding: 0 4px; cursor: pointer; color: #6b6880; }
@media (prefers-color-scheme: dark) { .bar { color: #ececf1; background: #1f1e26; } a { color: #a98bf0; } button { color: #a9a6b8; } }`;

/** The banner's wording: the worst listing, and how many more the menu has. */
export function bannerText(sites: SiteEntry[]): { lead: string; rest: string; site: SiteEntry } {
  const site = leadSite(sites)!;
  const d = site.incidentDetail;
  const i = site.intern;
  const lead = site.incident
    ? d
      ? `Open incident for ${site.name} (${incidentWhen(d)}): ${firstSentence(d.summary)}`
      : `xmr.club lists an open incident for ${site.name}.`
    : i
      ? `${site.name} is new on xmr.club (intern, day ${Math.min(i.day, i.daysRequired)} of ${i.daysRequired}, not graded yet).${internCaution(i) ? ` ${internCaution(i)}` : ''}`
      : `xmr.club grades ${site.name} ${site.grade}.`;
  const more = sites.length - 1;
  return { lead, rest: more ? ` (+${more} more in XMRadar's menu)` : '', site };
}

/**
 * A red lookalike leads; then the listings, when they need a banner; then the same name as a service that
 * takes coins (amber, PLAN-PRELOAD §5). Same-name of any other listing stays in the badge and popup.
 */
export function bannerFor(info: SiteInfo): { lookalike: Lookalike } | { sites: SiteEntry[] } | null {
  const l = info.lookalike;
  if (l && l.kind !== 'same-name') return { lookalike: l };
  if (info.sites.length && needsBanner(info.sites)) return { sites: info.sites };
  return l && isCoinListing(l) ? { lookalike: l } : null;
}

export function mountBanner(doc: Document, what: { lookalike: Lookalike } | { sites: SiteEntry[] }, onDismiss: () => void): HTMLElement {
  const host = doc.createElement('xmradar-site');
  const root = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = CSS;
  const close = h('button', { textContent: '×', attrs: { 'aria-label': 'Hide for 7 days on this site' } });
  close.addEventListener('click', onDismiss);
  let bar: HTMLElement;
  if ('lookalike' in what) {
    // text and link come from the feed only, never from this page
    const l = what.lookalike;
    const link = h('a', { textContent: `Go to ${l.target}`, href: lookalikeHref(l), target: '_blank', rel: 'noopener noreferrer' });
    const cls = l.kind === 'same-name' ? 'bar caution' : 'bar';
    bar = h('div', { class: cls, attrs: { role: 'alert' } }, h('span', { class: 'msg' }, h('b', { textContent: 'XMRadar · ' }), lookalikeText(l)), link, close);
  } else {
    const { lead, rest, site } = bannerText(what.sites);
    const link = h('a', { textContent: 'Details', href: site.url, target: '_blank', rel: 'noopener noreferrer' });
    bar = h('div', { class: site.intern && !site.incident ? 'bar caution' : 'bar', attrs: { role: 'alert' } }, h('span', { class: 'msg' }, h('b', { textContent: 'XMRadar · ' }), lead, rest), link, close);
  }
  root.append(style, bar);
  doc.documentElement.append(host);
  return host;
}

export function startSiteInfo(ctx: ContentScriptContext) {
  if (window !== window.top || isXHost(location.hostname)) return;
  let banner: HTMLElement | null = null;
  let alive = true;
  const hide = () => {
    banner?.remove();
    banner = null;
  };

  // the first visits after the browser starts can come before the list has downloaded: ask again later
  let retries = 3;
  async function check() {
    const settings = await xmrSettingsItem.getValue();
    if (!alive || !siteInfoOn(settings)) return hide();
    let info: SiteInfo;
    try {
      info = await sendToBackground({ type: 'site-info', host: location.hostname });
    } catch {
      return;
    }
    if (info.issuedAt === null && retries-- > 0) {
      setTimeout(() => void check(), 5000);
      return;
    }
    const what = bannerFor(info);
    if (!alive || !what || !siteWarningsOn(settings)) return hide();
    const key = normalizeHost(location.hostname);
    const until = (await dismissedItem.getValue())[key] ?? 0;
    if (Date.now() < until || banner || !alive) return;
    banner = mountBanner(document, what, async () => {
      hide();
      const all = await dismissedItem.getValue();
      // drop old entries while writing, so the record stays small
      const kept = Object.fromEntries(Object.entries(all).filter(([, t]) => t > Date.now()));
      await dismissedItem.setValue({ ...kept, [key]: Date.now() + DISMISS_MS });
    });
  }

  void check();
  const unwatch = xmrSettingsItem.watch(() => void check());
  // a single-page app keeps its host, but the background clears the tab's badge on a URL change
  ctx.addEventListener(window, 'wxt:locationchange', () => void check());
  ctx.onInvalidated(() => {
    alive = false;
    unwatch();
    hide();
  });
}
