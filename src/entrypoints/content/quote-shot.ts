import type { ExtractedImage } from '../../extractors/types';
import { hideForShot, quoteAlt, quoteBox } from '../../extractors/x-quote';
import { sendToBackground } from '../../messaging';

/** XMRadar's own overlays, hidden while the tab is captured so none ends up in the picture */
const OVERLAYS = 'xmradar-ui, xmradar-tip, xmradar-site, xmradar-receipt';
const ANSWER_MS = 3000;

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

function hideOverlays(doc: Document): () => void {
  const undo = [...doc.querySelectorAll<HTMLElement>(OVERLAYS)].map((el) => {
    const before = el.getAttribute('style');
    el.style.setProperty('visibility', 'hidden', 'important');
    return () => (before === null ? el.removeAttribute('style') : el.setAttribute('style', before));
  });
  return () => undo.forEach((f) => f());
}

const inView = (r: DOMRect) => r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;

export type QuoteShot = { image: ExtractedImage; size: number } | { error: string } | null;

/**
 * The opened tweet's quoted post as a picture (PLAN-QUOTESHOT), or null when it quotes nothing. Taken
 * before the composer appears; the quote's time and X's labels, and XMRadar's overlays, are hidden only
 * for the capture and always put back.
 */
export async function takeQuoteShot(article: Element, sessionId: string): Promise<QuoteShot> {
  const box = quoteBox(article);
  if (!box) return null;
  // a pinch zoom makes the page's measurements differ from the captured pixels
  if ((visualViewport?.scale ?? 1) !== 1) return { error: 'the page is zoomed in' };
  if (!inView(box.getBoundingClientRect())) {
    box.scrollIntoView({ block: 'center' });
    await frame();
    await frame();
  }
  const alt = quoteAlt(box);
  let restoreOverlays = () => {};
  let restoreBox = () => {};
  let switched = false;
  let restored = false;
  const onVisibility = () => (switched ||= document.visibilityState !== 'visible');
  const restore = () => {
    if (restored) return;
    restored = true;
    restoreBox();
    restoreOverlays();
    document.removeEventListener('visibilitychange', onVisibility);
    removeEventListener('pagehide', restore);
  };
  document.addEventListener('visibilitychange', onVisibility);
  addEventListener('pagehide', restore);
  try {
    // inside the try, so a failure while hiding still puts back what was hidden
    restoreOverlays = hideOverlays(document);
    restoreBox = hideForShot(box);
    await frame();
    const r = box.getBoundingClientRect();
    const answer = sendToBackground({
      type: 'capture-quote',
      sessionId,
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      view: { width: innerWidth, height: innerHeight },
      client: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('no answer')), ANSWER_MS)));
    const { dataUrl } = await Promise.race([answer, late]).finally(() => clearTimeout(timer));
    // the tab left the screen during the capture: the picture may show something else
    if (switched || document.visibilityState !== 'visible') return { error: 'the tab was switched during the capture' };
    if (!dataUrl.startsWith('data:image/png;base64,')) return { error: 'not a picture' };
    const blob = await (await fetch(dataUrl)).blob();
    return { image: { url: URL.createObjectURL(blob), alt }, size: blob.size };
  } catch (e) {
    return { error: (e as Error).message };
  } finally {
    restore();
  }
}
