import { describe, expect, it } from 'vitest';
import { directMp4, fullSizeTwimg, tileMedia, videoMediaId, xExtractor } from '../src/extractors/x';
import { isXVideoUrl, resolveXVideo, syndicationToken, VIDEO_MAX } from '../src/nostr/x-video';
import { loadMedia, scaledMs } from '../src/nostr/load-media';
import { buildNote, imetaTag } from '../src/nostr/event';

// PLAN-XVIDEO
const POSTER = 'https://pbs.twimg.com/amplify_video_thumb/2118600833713557504/img/5lKaF_90imFfC-Hc.jpg';
const MP4 = (w: number, h: number, f: string) => `https://video.twimg.com/amplify_video/2118600833713557504/vid/avc1/${w}x${h}/${f}.mp4`;
const GIF_MP4 = 'https://video.twimg.com/tweet_video/GxYzAbC123.mp4';

describe('posters and ids', () => {
  it('a video poster at its original size, its format named', () => {
    expect(fullSizeTwimg(POSTER)).toBe(`${POSTER}?format=jpg&name=orig`);
    expect(fullSizeTwimg('https://pbs.twimg.com/ext_tw_video_thumb/123/pu/img/x.jpg?name=small')).toBe('https://pbs.twimg.com/ext_tw_video_thumb/123/pu/img/x.jpg?name=orig&format=jpg');
    expect(fullSizeTwimg('https://pbs.twimg.com/media/abc?format=jpg&name=small')).toBe('https://pbs.twimg.com/media/abc?format=jpg&name=orig');
  });
  it('the media id from each kind of poster, without the extension', () => {
    expect(videoMediaId(POSTER)).toBe('2118600833713557504');
    expect(videoMediaId('https://pbs.twimg.com/ext_tw_video_thumb/123/pu/img/x.jpg')).toBe('123');
    expect(videoMediaId('https://pbs.twimg.com/tweet_video_thumb/456.jpg')).toBe('456');
    expect(videoMediaId('https://pbs.twimg.com/media/abc.jpg')).toBeUndefined();
    expect(videoMediaId('https://evil.example/amplify_video_thumb/1/img/x.jpg')).toBeUndefined();
  });
  it('a direct mp4 only on video.twimg.com', () => {
    expect(directMp4(GIF_MP4)).toBe(GIF_MP4);
    expect(directMp4('blob:https://x.com/abc')).toBeUndefined();
    expect(directMp4('https://evil.example/tweet_video/a.mp4')).toBeUndefined();
    expect(directMp4('http://video.twimg.com/tweet_video/a.mp4')).toBeUndefined();
    expect(isXVideoUrl('https://video.twimg.com.evil.example/a.mp4')).toBe(false);
  });
});

const tile = (html: string) => {
  document.body.innerHTML = `<div data-testid="tweetPhoto">${html}</div>`;
  return document.querySelector('[data-testid="tweetPhoto"]')!;
};

describe('a media tile', () => {
  it('a video, even with its poster also shown as an <img>', () => {
    expect(tileMedia(tile(`<img src="${POSTER}"><div data-testid="videoComponent"><video src="blob:https://x.com/1" poster="${POSTER}"></video></div>`), '99')).toEqual({
      url: `${POSTER}?format=jpg&name=orig`,
      kind: 'video',
      mediaId: '2118600833713557504',
      statusId: '99',
    });
  });
  it('a GIF keeps its mp4; one with no poster still comes', () => {
    expect(tileMedia(tile(`<video src="${GIF_MP4}" poster="https://pbs.twimg.com/tweet_video_thumb/GxYzAbC123.jpg"></video>`), '99')).toMatchObject({ kind: 'gif', mp4: GIF_MP4 });
    expect(tileMedia(tile(`<video src="${GIF_MP4}"></video>`), '99')).toEqual({ url: '', kind: 'gif', mp4: GIF_MP4, statusId: '99' });
  });
  it('an off-host src is ignored (looked up instead); nothing to fetch → a video with its poster only (it goes out as poster + link), or nothing', () => {
    expect(tileMedia(tile(`<video src="https://evil.example/a.mp4" poster="${POSTER}"></video>`), '99')).toMatchObject({ kind: 'video', mediaId: '2118600833713557504' });
    expect(tileMedia(tile(`<video src="blob:x" poster="https://pbs.twimg.com/media/p.jpg"></video>`), '99')).toEqual({ url: 'https://pbs.twimg.com/media/p.jpg?name=orig', kind: 'video', statusId: '99' });
    expect(tileMedia(tile(`<video src="blob:x"></video>`), '99')).toBeNull();
  });
  it('a photo as before', () => {
    expect(tileMedia(tile(`<img src="https://pbs.twimg.com/media/p?format=jpg&name=small" alt="a cat">`), '99')).toEqual({ url: 'https://pbs.twimg.com/media/p?format=jpg&name=orig', alt: 'a cat' });
  });
});

describe('a post with photo, video and GIF', () => {
  it('all three in order; the quoted post’s media left out', () => {
    document.body.innerHTML = `<article data-testid="tweet"><a href="/alice/status/77"><time>1h</time></a>
      <div data-testid="tweetText">look</div>
      <div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/a?format=jpg&name=small" alt="Image"></div>
      <div data-testid="tweetPhoto"><div data-testid="videoComponent"><video src="blob:x" poster="${POSTER}"></video></div></div>
      <div data-testid="tweetPhoto"><video src="${GIF_MP4}"></video></div>
      <div role="link"><div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/q?name=small"></div></div>
    </article>`;
    const post = xExtractor.extract(document.querySelector('article')!, document)!;
    expect(post.images.map((i) => i.kind ?? 'photo')).toEqual(['photo', 'video', 'gif']);
    expect(post.images[1]).toMatchObject({ statusId: '77', mediaId: '2118600833713557504' });
  });
});

/** A fake fetch: the embed JSON, then HEADs by URL. */
function fakeFetch(json: unknown, sizes: Record<string, number | null>, opts: { status?: number; redirect?: Record<string, string> } = {}) {
  const calls: string[] = [];
  const f = (async (input: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${input}`);
    if (input.startsWith('https://cdn.syndication.twimg.com/')) return new Response(JSON.stringify(json), { status: opts.status ?? 200 });
    const size = sizes[input];
    if (size === undefined) throw new TypeError('network');
    const r = new Response(null, { status: 200, headers: size === null ? {} : { 'content-length': String(size) } });
    if (opts.redirect?.[input]) Object.defineProperty(r, 'url', { value: opts.redirect[input] });
    return r;
  }) as unknown as typeof fetch;
  return { f, calls };
}
const detail = (variants: object[], id = '2118600833713557504') => ({
  mediaDetails: [
    { media_url_https: 'https://pbs.twimg.com/media/other.jpg' },
    { media_url_https: `https://pbs.twimg.com/amplify_video_thumb/${id}/img/a.jpg`, original_info: { width: 1080, height: 1920 }, video_info: { duration_millis: 59500, variants } },
  ],
});
const V = [
  { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/x.m3u8' },
  { content_type: 'video/mp4', bitrate: 632000, url: MP4(320, 568, 'a') },
  { content_type: 'video/mp4', bitrate: 10368000, url: MP4(1080, 1920, 'd') },
  { content_type: 'video/mp4', bitrate: 2176000, url: MP4(720, 1280, 'c') },
  { content_type: 'video/mp4', bitrate: 99999999, url: 'https://evil.example/big.mp4' },
];

describe('finding the mp4', () => {
  it('X’s embed token for an id (as react-tweet computes it)', () => {
    expect(syndicationToken('2118600948725547051')).toMatch(/^[0-9a-z]+$/);
    expect(syndicationToken('20')).toBe(((20 / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, ''));
  });
  it('the highest bitrate under 50 MB, matched by media id; size, dim and duration', async () => {
    const { f, calls } = fakeFetch(detail(V), { [MP4(1080, 1920, 'd')]: 60 * 1024 * 1024, [MP4(720, 1280, 'c')]: 3_608_658, [MP4(320, 568, 'a')]: 1_000_000 });
    expect(await resolveXVideo('2118600948725547051', '2118600833713557504', f)).toEqual({ ok: true, url: MP4(720, 1280, 'c'), size: 3_608_658, dim: '1080x1920', duration: 60 });
    expect(calls[0]).toContain(`token=${syndicationToken('2118600948725547051')}`);
    expect(calls.some((c) => c.includes('evil'))).toBe(false);
  });
  it('a failing or length-less HEAD goes on to the next; all failing → the smallest, size unknown', async () => {
    const { f } = fakeFetch(detail(V), { [MP4(720, 1280, 'c')]: null, [MP4(320, 568, 'a')]: 900 });
    expect(await resolveXVideo('1', '2118600833713557504', f)).toMatchObject({ ok: true, url: MP4(320, 568, 'a'), size: 900 });
    const none = fakeFetch(detail(V), {});
    const r = await resolveXVideo('1', '2118600833713557504', none.f);
    expect(r).toMatchObject({ ok: true, url: MP4(320, 568, 'a') });
    expect(r).not.toHaveProperty('size');
  });
  it('a HEAD redirected off video.twimg.com doesn’t count', async () => {
    const { f } = fakeFetch(detail(V), { [MP4(1080, 1920, 'd')]: 10, [MP4(720, 1280, 'c')]: 20 }, { redirect: { [MP4(1080, 1920, 'd')]: 'https://evil.example/x.mp4' } });
    expect(await resolveXVideo('1', '2118600833713557504', f)).toMatchObject({ url: MP4(720, 1280, 'c') });
  });
  it('the media id matched before a query too; past the 20 s budget, the smallest, size unknown', async () => {
    const q = { mediaDetails: [{ media_url_https: 'https://pbs.twimg.com/media/2118600833713557504?format=jpg', video_info: { variants: V } }] };
    expect((await resolveXVideo('1', '2118600833713557504', fakeFetch(q, { [MP4(1080, 1920, 'd')]: 5 }).f)).ok).toBe(true);
    let t = 0;
    const clock = () => (t += 15_000);
    const r = await resolveXVideo('1', '2118600833713557504', fakeFetch(detail(V), { [MP4(1080, 1920, 'd')]: VIDEO_MAX + 1, [MP4(720, 1280, 'c')]: 5 }).f, clock);
    expect(r).toMatchObject({ ok: true, url: MP4(320, 568, 'a') });
  });
  it('reasons: too large, not found, X down, bad ids', async () => {
    const big = fakeFetch(detail(V), { [MP4(1080, 1920, 'd')]: VIDEO_MAX + 1, [MP4(720, 1280, 'c')]: VIDEO_MAX + 1, [MP4(320, 568, 'a')]: VIDEO_MAX + 1 });
    expect(await resolveXVideo('1', '2118600833713557504', big.f)).toEqual({ ok: false, why: 'too large' });
    expect(await resolveXVideo('1', '555', fakeFetch(detail(V), {}).f)).toEqual({ ok: false, why: 'not found' });
    expect((await resolveXVideo('1', '2118600833713557504', fakeFetch(detail(V), {}, { status: 404 }).f)).ok).toBe(false);
    expect(await resolveXVideo('1', '2118600833713557504', (async () => new Response('{nope')) as unknown as typeof fetch)).toEqual({ ok: false, why: "X didn't answer" });
    expect(await resolveXVideo('1 OR 1', '2', fakeFetch({}, {}).f)).toEqual({ ok: false, why: 'bad id' });
  });
});

/** The background's streamed reader, as it is there. */
async function readBody(res: Response, max: number): Promise<Uint8Array> {
  if (Number(res.headers.get('content-length')) > max) throw new Error('Response too large');
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > max) throw new Error('Response too large');
  return buf;
}
const respond = (bytes: number, headers: Record<string, string>) => (async () => new Response(new Uint8Array(bytes), { headers })) as unknown as typeof fetch;

describe('loading media', () => {
  const deps = (f: typeof fetch) => ({ fetch: f, readBody, imageMax: 20 * 1024 * 1024 });
  it('a video asked for as one: up to 50 MB, an mp4 whatever the server calls it', async () => {
    expect(await loadMedia(MP4(1, 1, 'a'), 'video', deps(respond(1000, { 'content-type': 'application/octet-stream' })))).toMatchObject({ mime: 'video/mp4' });
    await expect(loadMedia(MP4(1, 1, 'a'), 'video', deps(respond(10, { 'content-type': 'video/mp4', 'content-length': String(60 * 1024 * 1024) })))).rejects.toThrow('Video is larger than 50 MB');
  });
  it('an image is still capped at 20 MB, and a video file isn’t an image', async () => {
    await expect(loadMedia('https://pbs.twimg.com/media/a', undefined, deps(respond(10, { 'content-type': 'image/jpeg', 'content-length': String(21 * 1024 * 1024) })))).rejects.toThrow('Image is larger than 20 MB');
    await expect(loadMedia('https://example.com/a', undefined, deps(respond(10, { 'content-type': 'text/html' })))).rejects.toThrow('Not an image');
  });
  it('timeouts grow with the size', () => {
    expect(scaledMs(30_000, 50 * 1024 * 1024)).toBe(80_000);
    expect(scaledMs(20_000, VIDEO_MAX)).toBe(70_000);
  });
});

describe('the note', () => {
  it('a video’s imeta: type, size, dim and its poster; its URL in the text', () => {
    const v = { url: 'https://blossom.primal.net/abc.mp4', mime: 'video/mp4', sha256: 'ab'.repeat(32), dim: '1080x1920', size: 3_608_658, image: `${POSTER}?format=jpg&name=orig` };
    expect(imetaTag(v)).toEqual(['imeta', `url ${v.url}`, 'm video/mp4', `x ${v.sha256}`, 'dim 1080x1920', 'size 3608658', `image ${v.image}`]);
    expect(buildNote({ text: 'look', images: [v] }).content).toBe(`look\n\n${v.url}`);
  });
});
