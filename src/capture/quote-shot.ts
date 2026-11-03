/**
 * The background half of a quoted post's picture (PLAN-QUOTESHOT): the tab is captured, cropped to the
 * quote's box and only the crop is returned. The full capture never leaves this module.
 */

export interface ShotRequest {
  /** the box in CSS pixels, as the page measured it */
  rect: { x: number; y: number; width: number; height: number };
  /** window.innerWidth / innerHeight */
  view: { width: number; height: number };
  /** documentElement.clientWidth / clientHeight: the same without scrollbars */
  client?: { width: number; height: number };
}

export interface Crop {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** separate x and y scales may differ this much (rounding), well under a scrollbar's width */
const SCALE_TOLERANCE = 0.005;
const MAX_HEIGHT_SHARE = 0.9;
export const MAX_SHOT_BYTES = 8 * 1024 * 1024;

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** Whether a page-sent request has the right shape; anything else is refused before capturing. */
export function validRequest(r: unknown): r is ShotRequest {
  const q = r as ShotRequest;
  const sizes = (v: unknown) => !!v && [(v as ShotRequest['view']).width, (v as ShotRequest['view']).height].every((n) => finite(n) && n > 0);
  return !!q && [q.rect?.x, q.rect?.y, q.rect?.width, q.rect?.height].every(finite) && sizes(q.view) && (q.client === undefined || sizes(q.client));
}

/**
 * The bitmap area to keep, or null: the box must lie inside the viewport, be no wider than it and at most
 * 90% of its height, and the capture's x and y scales must agree (a mismatch means the page measured a
 * different viewport than was captured).
 */
export function cropRect(req: ShotRequest, bitmap: { width: number; height: number }): Crop | null {
  // the capture may or may not include the scrollbars: whichever viewport it matches
  for (const view of [req.view, ...(req.client ? [req.client] : [])]) {
    const crop = cropIn(req.rect, view, bitmap);
    if (crop) return crop;
  }
  return null;
}

function cropIn(rect: ShotRequest['rect'], view: ShotRequest['view'], bitmap: { width: number; height: number }): Crop | null {
  if (rect.width < 1 || rect.height < 1 || rect.x < 0 || rect.y < 0) return null;
  if (rect.x + rect.width > view.width + 0.5 || rect.y + rect.height > view.height + 0.5) return null;
  if (rect.height > view.height * MAX_HEIGHT_SHARE) return null;
  const sx = bitmap.width / view.width;
  const sy = bitmap.height / view.height;
  if (!(sx > 0) || Math.abs(sx - sy) / Math.max(sx, sy) > SCALE_TOLERANCE) return null;
  const x = Math.round(rect.x * sx);
  const y = Math.round(rect.y * sy);
  const w = Math.min(Math.round(rect.width * sx), bitmap.width - x);
  const h = Math.min(Math.round(rect.height * sy), bitmap.height - y);
  return w >= 1 && h >= 1 ? { sx: x, sy: y, sw: w, sh: h } : null;
}

export interface ShotDeps {
  /** the active tab of the window right now */
  activeTab(windowId: number): Promise<{ id?: number; url?: string } | undefined>;
  capture(windowId: number): Promise<string>;
  /** the crop of a PNG data URL, as a PNG data URL */
  crop(dataUrl: string, area: Crop): Promise<string>;
  /** the decoded size of a PNG data URL */
  size(dataUrl: string): Promise<{ width: number; height: number }>;
  isX(url: string | undefined): boolean;
  now?: () => number;
}

const TIME_LIMIT_MS = 2000;

/**
 * Captures the sender's tab and crops it. The tab must be the window's active one and on X both right
 * before and right after the capture, and the capture must finish within 2 s; otherwise it's dropped
 * unread.
 */
export async function shootQuote(tab: { id: number; windowId: number }, req: ShotRequest, deps: ShotDeps): Promise<string> {
  const now = deps.now ?? Date.now;
  const same = async () => {
    const t = await deps.activeTab(tab.windowId);
    return t?.id === tab.id && deps.isX(t.url);
  };
  if (!(await same())) throw new Error('The tab is not in front');
  const started = now();
  let full: string | null = await deps.capture(tab.windowId);
  try {
    if (now() - started > TIME_LIMIT_MS || !(await same())) throw new Error('The tab changed during the capture');
    const area = cropRect(req, await deps.size(full));
    if (!area) throw new Error("The quoted post isn't fully on screen");
    const out = await deps.crop(full, area);
    if (out.length * 0.75 > MAX_SHOT_BYTES) throw new Error('The picture is too large');
    return out;
  } finally {
    // the whole capture is never kept
    full = null;
  }
}

/**
 * One picture per composer session: claimed synchronously (two asks can't both pass) and kept in its own
 * stored list, written one at a time, so a restarted worker refuses too and no other record is rewritten.
 */
export function shotGate(store: { getValue(): Promise<string[]>; setValue(v: string[]): Promise<void> }, max = 1000) {
  const claimed = new Set<string>();
  let writes = Promise.resolve();
  return {
    async claim(id: string): Promise<boolean> {
      if (claimed.has(id)) return false;
      claimed.add(id);
      const run = writes.then(async () => {
        const ids = await store.getValue();
        if (ids.includes(id)) return false;
        await store.setValue([...ids, id].slice(-max));
        return true;
      });
      writes = run.then(() => {}, () => {});
      return run;
    },
  };
}
