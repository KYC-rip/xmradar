import type { SiteInfo } from '../messaging';
import { firstSentence, incidentWhen, internCaution, internText, levelText } from '../sites/feed';
import { lookalikeHref, lookalikeText } from '../sites/lookalike-text';

/**
 * The popup's "This site" card (PLAN-SITEFEED §3): every xmr.club listing for the current tab's host,
 * with grade, NKIP-0001 level, any open incident and the listing link, led by a lookalike warning when
 * the host poses as a listed service. Hidden when nothing matches.
 */

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = '') => {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};

export function renderSiteCard(root: HTMLElement, info: SiteInfo | null) {
  const l = info?.lookalike ?? null;
  root.classList.toggle('hidden', !info?.sites.length && !l);
  if (!info || (!info.sites.length && !l)) return root.replaceChildren();
  const rows = info.sites.map((s) => {
    const row = el('div', '', 'site-row');
    const title = el('div', '', 'row-title');
    // an intern: no grade and nothing that reads as an endorsement, only that it is new
    title.append(el('span', s.name), el('span', s.grade ? ` · grade ${s.grade}` : s.intern ? ' · new on xmr.club' : '', 'grade'));
    row.append(title);
    if (s.intern) {
      row.append(el('div', internText(s.intern), 'row-hint'));
      const caution = internCaution(s.intern);
      if (caution) row.append(el('div', caution, 'row-hint caution'));
    }
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
  if (l) {
    // red for a copy, amber for the same name on another domain; the link is the listed host, from the feed
    const row = el('div', '', 'site-row');
    row.append(
      el('div', lookalikeText(l), `row-hint ${l.kind === 'same-name' ? 'caution' : 'warn'}`),
      Object.assign(el('a', `Go to ${l.target}`, 'link'), { href: lookalikeHref(l), target: '_blank', rel: 'noopener noreferrer' }),
    );
    rows.unshift(row);
  }
  const foot = el('div', '', 'row-hint');
  foot.textContent = info.outOfDate
    ? `List out of date (issued ${info.issuedAt ? new Date(info.issuedAt * 1000).toLocaleDateString() : 'unknown'}). Data from xmr.club, run by the same team as XMRadar.`
    : 'Data from xmr.club, run by the same team as XMRadar.';
  root.replaceChildren(el('div', 'This site', 'card-head'), ...rows, foot);
}
