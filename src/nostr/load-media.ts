import { assertFetchableImageUrl } from './url-guard';
import { VIDEO_MAX } from './x-video';

/** 1 s per MB on top of the base: a 50 MB video gets 70 s to download, 80 s to upload (PLAN-XVIDEO). */
export const scaledMs = (base: number, bytes: number) => base + Math.ceil(bytes / (1024 * 1024)) * 1000;

export interface LoadDeps {
  fetch: typeof fetch;
  /** the body, refused past `max` from the stated length or while reading */
  readBody: (res: Response, max: number) => Promise<Uint8Array>;
  imageMax: number;
}

/**
 * An image or, asked for as one, a video (PLAN-XVIDEO): the cap is checked against the stated length before
 * reading and while reading, so nothing larger is ever held.
 */
export async function loadMedia(url: string, kind: 'video' | undefined, deps: LoadDeps): Promise<{ bytes: ArrayBuffer; mime: string }> {
  assertFetchableImageUrl(url);
  const video = kind === 'video';
  const max = video ? VIDEO_MAX : deps.imageMax;
  const what = video ? 'Video' : 'Image';
  const res = await deps.fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(video ? scaledMs(20_000, VIDEO_MAX) : 20_000) });
  // redirects are followed (CDNs use them), so re-check where we actually ended up
  if (res.redirected) assertFetchableImageUrl(res.url);
  if (!res.ok) throw new Error(`${what} fetch failed (${res.status})`);
  let body: Uint8Array;
  try {
    body = await deps.readBody(res, max);
  } catch (e) {
    throw new Error((e as Error).message === 'Response too large' ? `${what} is larger than ${Math.round(max / (1024 * 1024))} MB` : (e as Error).message);
  }
  const bytes = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  let mime = (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim();
  // a video asked for as one is an mp4 whatever the server calls it
  if (video && !mime.startsWith('video/')) mime = 'video/mp4';
  if (!mime.startsWith('image/') && !mime.startsWith('video/')) throw new Error(`Not an image (${mime})`);
  return { bytes, mime };
}
