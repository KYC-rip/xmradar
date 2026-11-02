import { logoFor, type LogoPack } from '../sites/logos';

/**
 * An exchange's logo from xmr.club's pack (PLAN-LOGOS), or a same-size circle with the name's first letter,
 * so record cards line up either way. Only a data:image/webp URI from the checked pack ever becomes a src.
 */
export function siteLogo(pack: LogoPack | null | undefined, ref: { siteId?: string; host?: string }, name: string): HTMLElement {
  const uri = logoFor(pack, ref);
  if (uri?.startsWith('data:image/webp;base64,')) {
    return Object.assign(document.createElement('img'), { src: uri, alt: '', width: 28, height: 28, className: 'site-logo', decoding: 'async' });
  }
  const span = document.createElement('span');
  span.className = 'site-logo initial';
  span.setAttribute('aria-hidden', 'true');
  span.textContent = (name.trim().match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase();
  return span;
}
