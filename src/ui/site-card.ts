import type { SiteInfo } from '../messaging';
import { firstSentence, incidentWhen, levelText } from '../sites/feed';

/**
 * The popup's "This site" card (PLAN-SITEFEED §3): every xmr.club listing for the current tab's host,
 * with grade, NKIP-0001 level, any open incident and the listing link. Hidden when nothing matches.
 */

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = '') => {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};

export function renderSiteCard(root: HTMLElement, info: SiteInfo | null) {
  root.classList.toggle('hidden', !info?.sites.length);
  if (!info?.sites.length) return root.replaceChildren();
  const rows = info.sites.map((s) => {
    const row = el('div', '', 'site-row');
    const title = el('div', '', 'row-title');
    title.append(el('span', s.name), el('span', s.grade ? ` · grade ${s.grade}` : '', 'grade'));
    row.append(title);
    const level = levelText(s.nkip01);
    const checked = s.nkip01?.lastOkAt ? ` · checked ${new Date(s.nkip01.lastOkAt * 1000).toLocaleDateString()}` : '';
    if (level) row.append(el('div', level + checked, 'row-hint'));
    const d = s.incidentDetail;
    if (s.incident) row.append(el('div', d ? `⚠ Open incident (${incidentWhen(d)}): ${firstSentence(d.summary, 240)}` : '⚠ Open incident on xmr.club', 'row-hint warn'));
    if (d?.sourceUrl) row.append(Object.assign(el('a', 'Incident source', 'link'), { href: d.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }));
    const link = Object.assign(el('a', 'Listing on xmr.club', 'link'), { href: s.url, target: '_blank', rel: 'noopener noreferrer' });
    row.append(link);
    return row;
  });
  const foot = el('div', '', 'row-hint');
  foot.textContent = info.outOfDate
    ? `List out of date (issued ${info.issuedAt ? new Date(info.issuedAt * 1000).toLocaleDateString() : 'unknown'}). Data from xmr.club, run by the same team as XMRadar.`
    : 'Data from xmr.club, run by the same team as XMRadar.';
  root.replaceChildren(el('div', 'This site', 'card-head'), ...rows, foot);
}
