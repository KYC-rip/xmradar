/**
 * The mp4 behind an X video (PLAN-XVIDEO). The page only has a `blob:` stream, so the file is found through
 * X's public embed endpoint (the one embedded tweets use; no login, no cookies sent): it lists each video's
 * mp4 variants. The highest bitrate under VIDEO_MAX is chosen by HEAD. Only video.twimg.com mp4s are accepted.
 */

export const VIDEO_MAX = 50 * 1024 * 1024;
const JSON_MAX = 1024 * 1024;
const TIMEOUT_MS = 10_000;
const DIGITS = /^\d{1,20}$/;

/** The `token` X's embed code sends with a tweet id. */
export function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

export const isXVideoUrl = (raw: unknown): raw is string => {
  if (typeof raw !== 'string') return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname === 'video.twimg.com' && u.pathname.endsWith('.mp4');
  } catch {
    return false;
  }
};

export type VideoFound = { ok: true; url: string; size?: number; dim?: string; duration?: number } | { ok: false; why: string };

interface Variant {
  content_type?: unknown;
  bitrate?: unknown;
  url?: unknown;
}
interface MediaDetail {
  media_url_https?: unknown;
  original_info?: { width?: unknown; height?: unknown };
  video_info?: { duration_millis?: unknown; variants?: Variant[] };
}

async function readJson(res: Response): Promise<unknown> {
  const stated = Number(res.headers.get('content-length'));
  if (stated > JSON_MAX) throw new Error('too big');
  const text = await res.text();
  if (text.length > JSON_MAX) throw new Error('too big');
  return JSON.parse(text);
}

/** The size HEAD states for an mp4, or null (failed, no length, or moved off video.twimg.com). */
async function headSize(url: string, fetchFn: typeof fetch): Promise<number | null> {
  try {
    const res = await fetchFn(url, { method: 'HEAD', credentials: 'omit', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok || (res.url && !isXVideoUrl(res.url))) return null;
    const n = Number(res.headers.get('content-length'));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** The whole lookup, the JSON and every HEAD together: past it, the smallest variant is taken, size unknown. */
export const RESOLVE_BUDGET_MS = 20_000;

export async function resolveXVideo(statusId: string, mediaId: string, fetchFn: typeof fetch = fetch, now: () => number = Date.now): Promise<VideoFound> {
  const deadline = now() + RESOLVE_BUDGET_MS;
  if (!DIGITS.test(statusId) || !DIGITS.test(mediaId)) return { ok: false, why: 'bad id' };
  let data: { mediaDetails?: MediaDetail[] };
  try {
    const res = await fetchFn(`https://cdn.syndication.twimg.com/tweet-result?id=${statusId}&token=${syndicationToken(statusId)}&lang=en`, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, why: `X didn't answer (${res.status})` };
    data = (await readJson(res)) as typeof data;
  } catch {
    return { ok: false, why: "X didn't answer" };
  }
  const media = (Array.isArray(data?.mediaDetails) ? data.mediaDetails : []).find(
    (m) => typeof m?.media_url_https === 'string' && new RegExp(`/${mediaId}(?:[/.?#]|$)`).test(m.media_url_https),
  );
  if (!media) return { ok: false, why: 'not found' };
  const variants = (Array.isArray(media.video_info?.variants) ? media.video_info!.variants : [])
    .filter((v) => v?.content_type === 'video/mp4' && isXVideoUrl(v.url))
    .map((v) => ({ url: v.url as string, bitrate: typeof v.bitrate === 'number' ? v.bitrate : 0 }))
    .sort((a, b) => b.bitrate - a.bitrate);
  if (!variants.length) return { ok: false, why: 'not found' };
  const w = media.original_info?.width;
  const h = media.original_info?.height;
  const dim = Number.isInteger(w) && Number.isInteger(h) ? `${w}x${h}` : undefined;
  const ms = media.video_info?.duration_millis;
  const duration = typeof ms === 'number' && ms > 0 ? Math.round(ms / 1000) : undefined;
  const extra = { ...(dim ? { dim } : {}), ...(duration ? { duration } : {}) };
  let anySize = false;
  let outOfTime = false;
  for (const v of variants) {
    if (now() >= deadline) {
      outOfTime = true;
      break;
    }
    const size = await headSize(v.url, fetchFn);
    if (size !== null) anySize = true;
    if (size !== null && size <= VIDEO_MAX) return { ok: true, url: v.url, size, ...extra };
  }
  // every HEAD failed, or no time left to ask: the smallest, size unknown (the background's streamed cap decides)
  if (!anySize || outOfTime) return { ok: true, url: variants[variants.length - 1]!.url, ...extra };
  return { ok: false, why: 'too large' };
}
