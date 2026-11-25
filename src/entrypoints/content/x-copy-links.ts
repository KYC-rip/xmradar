import { cleanXUrl } from '../../extractors/x-links';

/**
 * On x.com, a copied X link loses its share tracking (PLAN-CLEANLINKS):
 * - Desktop X's `copy` event / selection copy (`onCopy`).
 * - Mobile X's async `navigator.clipboard.writeText` and `navigator.share` (handled by the MAIN-world
 *   companion script `x-clean-links.content.ts`, gated live by `CLEAN_LINKS_ATTR` on `<html>`).
 * A selection with anything else in it (a post's text) is left alone, formatting and all.
 */

export const CLEAN_LINKS_ATTR = 'data-xmradar-clean-links';
const INLINE = new Set(['A', 'SPAN', 'B', 'I', 'EM', 'STRONG', 'CODE']);

/** The plain text this copy would put on the clipboard, when it is plain enough to replace; else null. */
export function copiedText(doc: Document): string | null {
  const active = doc.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    const { selectionStart: a, selectionEnd: b, value } = active;
    return a != null && b != null && b > a ? value.slice(a, b) : null;
  }
  const sel = doc.getSelection();
  if (!sel || sel.rangeCount !== 1 || sel.isCollapsed) return null;
  const frag = sel.getRangeAt(0).cloneContents();
  for (const el of frag.querySelectorAll('*')) if (!INLINE.has(el.tagName)) return null;
  return frag.textContent;
}

/** The copy event handler; returns whether it replaced the clipboard text. */
export function onCopy(e: ClipboardEvent, doc: Document): boolean {
  const text = copiedText(doc)?.trim();
  if (!text || /\s/.test(text) || !e.clipboardData) return false;
  const clean = cleanXUrl(text);
  if (!clean) return false;
  e.clipboardData.clearData();
  e.clipboardData.setData('text/plain', clean);
  e.preventDefault();
  return true;
}

/** Clean a single X URL string (with no surrounding prose), returning original text when untouched. */
export function cleanCopiedString(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return raw;
  return cleanXUrl(trimmed) ?? raw;
}

export function startCopyLinks(doc: Document) {
  const listener = (e: Event) => void onCopy(e as ClipboardEvent, doc);
  doc.addEventListener('copy', listener, true);
  doc.documentElement?.setAttribute(CLEAN_LINKS_ATTR, '1');
  return () => {
    doc.removeEventListener('copy', listener, true);
    doc.documentElement?.removeAttribute(CLEAN_LINKS_ATTR);
  };
}
