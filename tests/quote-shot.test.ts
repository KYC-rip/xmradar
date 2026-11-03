import { describe, expect, it, vi } from 'vitest';
import { cropRect, shootQuote, shotGate, validRequest, type ShotDeps } from '../src/capture/quote-shot';
import { hideForShot, quoteAlt, quoteBox } from '../src/extractors/x-quote';
import { makeDoc } from './helpers';

const author = (name: string, handle: string, time = true) =>
  `<div data-testid="User-Name"><div><span>${name}</span></div><div><span>@${handle}</span><span aria-hidden="true">·</span>` +
  (time ? `<a href="/${handle}/status/1"><time datetime="2026-11-03T02:00:00Z">3h</time></a>` : '') +
  `</div></div>`;
const quote = (inner = '') =>
  `<div role="link" id="q"><div data-testid="Tweet-User-Avatar"><img src="https://pbs.twimg.com/profile_images/a.jpg"></div>${author('Alice', 'alice')}` +
  `<div data-testid="tweetText" id="qt">Quoted <a href="https://t.co/x">example.com/page</a> words</div>` +
  `<button data-testid="tweet-text-show-more-link">Show more</button><div><span>Translate post</span></div><div id="poll"><span>1,234 votes</span><span> · </span><span>2 days left</span></div>` +
  `<div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/q.jpg"></div>${inner}</div>`;
const tweet = (q: string) =>
  `<article data-testid="tweet" id="t">${author('Me', 'me')}<div data-testid="tweetText">my comment</div>${q}<div role="group"><button>Reply</button></div></article>`;
const doc = (q = quote()) => makeDoc('https://x.com/me/status/2', tweet(q));

describe('quoteBox', () => {
  it("finds the quoted post's box, and none in a plain tweet or for a link card", () => {
    const d = doc();
    expect(quoteBox(d.getElementById('t')!)!.id).toBe('q');
    expect(quoteBox(makeDoc('https://x.com/', tweet('')).getElementById('t')!)).toBeNull();
    const card = makeDoc('https://x.com/', tweet('<div role="link"><span>example.com</span><span>A card</span></div>'));
    expect(quoteBox(card.getElementById('t')!)).toBeNull();
  });
  it('takes the outer quote, not one nested inside it', () => {
    const d = doc(quote(`<div role="link" id="inner">${author('Bob', 'bob')}<div data-testid="tweetText">deeper</div></div>`));
    expect(quoteBox(d.getElementById('t')!)!.id).toBe('q');
  });
});

describe('quoteAlt', () => {
  it('names the author and the words, with no time, separator, labels, URL or nested quote', () => {
    const d = doc(quote(`<div role="link">${author('Bob', 'bob')}<div data-testid="tweetText">deeper</div></div>`));
    const alt = quoteAlt(d.getElementById('q')!);
    expect(alt).toBe('Quoted post by Alice @alice: Quoted example.com/page words');
    expect(alt).not.toMatch(/3h|·|Show more|Translate|votes|days left|https?:|deeper|Bob/);
  });
  it('cuts at 400 characters without splitting an emoji', () => {
    const family = '👨‍👩‍👧‍👦';
    const d = makeDoc('https://x.com/', tweet(`<div role="link" id="q">${author('A', 'a')}<div data-testid="tweetText">${family.repeat(500)}</div></div>`));
    const alt = quoteAlt(d.getElementById('q')!);
    expect(alt.endsWith(`${family}…`)).toBe(true);
    expect([...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(alt)]).toHaveLength(401);
  });
});

describe('hideForShot', () => {
  const visible = (el: Element) => (el as HTMLElement).style.visibility !== 'hidden' && !el.closest('[style*="hidden"]');
  it('hides the time, separator, buttons, labels and a nested quote; keeps name, handle, text and pictures', () => {
    const d = doc(quote(`<div role="link" id="inner">${author('Bob', 'bob')}<div data-testid="tweetText">deeper</div></div>`));
    const box = d.getElementById('q')!;
    const restore = hideForShot(box);
    expect(visible(box.querySelector('time')!)).toBe(false);
    expect(visible(box.querySelector('[aria-hidden="true"]')!)).toBe(false);
    expect(visible(box.querySelector('button')!)).toBe(false);
    for (const label of ['Translate post', '1,234 votes', '2 days left']) {
      const el = [...box.querySelectorAll('span')].find((s) => s.textContent === label)!;
      expect(visible(el)).toBe(false);
    }
    expect(visible(d.getElementById('inner')!)).toBe(false);
    expect(visible([...box.querySelectorAll('span')].find((s) => s.textContent === 'Alice')!)).toBe(true);
    expect(visible([...box.querySelectorAll('span')].find((s) => s.textContent === '@alice')!)).toBe(true);
    expect(visible(d.getElementById('qt')!)).toBe(true);
    expect(visible(box.querySelector('[data-testid="tweetPhoto"] img')!)).toBe(true);
    restore();
  });
  it('wraps a label that shares an element with the text, so the text stays', () => {
    const d = makeDoc('https://x.com/', tweet(`<div role="link" id="q">${author('A', 'a')}<div id="n"><div data-testid="tweetText">t</div> Translated from Japanese</div></div>`));
    const box = d.getElementById('q')!;
    const before = box.innerHTML;
    const restore = hideForShot(box);
    const n = d.getElementById('n')!;
    expect(n.style.visibility).toBe('');
    expect([...n.querySelectorAll('span')].find((s) => s.textContent === ' Translated from Japanese')!.style.visibility).toBe('hidden');
    restore();
    expect(box.innerHTML).toBe(before);
  });
  it('keeps only the name and @handle from the author line, and hides Show more as a link too', () => {
    const d = makeDoc(
      'https://x.com/',
      tweet(
        `<div role="link" id="q"><div data-testid="User-Name"><div><span>Alice</span></div><div><span>@alice</span><span id="fy">Follows you</span></div></div>` +
          `<div data-testid="tweetText">t<a data-testid="tweet-text-show-more-link" id="more" href="/alice/status/1">Show more</a></div></div>`,
      ),
    );
    const box = d.getElementById('q')!;
    expect(quoteAlt(box)).toBe('Quoted post by Alice @alice: t');
    const restore = hideForShot(box);
    expect(d.getElementById('fy')!.style.visibility).toBe('hidden');
    expect(d.getElementById('more')!.style.visibility).toBe('hidden');
    restore();
  });
  it('puts back inline styles exactly, once', () => {
    const d = doc();
    const box = d.getElementById('q')!;
    box.querySelector('button')!.setAttribute('style', 'color: red; visibility: visible');
    const before = box.innerHTML;
    const restore = hideForShot(box);
    expect(box.innerHTML).not.toBe(before);
    restore();
    restore();
    expect(box.innerHTML).toBe(before);
  });
});

describe('cropRect', () => {
  const req = (x: number, y: number, w: number, h: number, vw = 1000, vh = 800) => ({ rect: { x, y, width: w, height: h }, view: { width: vw, height: vh } });
  it('scales by the capture at DPR 1, 1.5 and 2', () => {
    expect(cropRect(req(100, 50, 400, 300), { width: 1000, height: 800 })).toEqual({ sx: 100, sy: 50, sw: 400, sh: 300 });
    expect(cropRect(req(100, 50, 400, 300), { width: 1500, height: 1200 })).toEqual({ sx: 150, sy: 75, sw: 600, sh: 450 });
    expect(cropRect(req(100, 50, 400, 300), { width: 2000, height: 1600 })).toEqual({ sx: 200, sy: 100, sw: 800, sh: 600 });
  });
  it('uses the viewport without scrollbars when that is what was captured, and refuses a different aspect', () => {
    // a 15 px scrollbar: the capture is 985 wide, the page's innerWidth 1000
    expect(cropRect(req(0, 0, 400, 300), { width: 985, height: 800 })).toBeNull();
    const withClient = { ...req(100, 0, 400, 300), client: { width: 985, height: 800 } };
    expect(cropRect(withClient, { width: 1970, height: 1600 })).toEqual({ sx: 200, sy: 0, sw: 800, sh: 600 });
    expect(cropRect(req(0, 0, 400, 300), { width: 1000, height: 700 })).toBeNull();
  });
  it('refuses a box off screen, empty, wider than the window or taller than 90% of it', () => {
    const bmp = { width: 1000, height: 800 };
    expect(cropRect(req(-1, 0, 100, 100), bmp)).toBeNull();
    expect(cropRect(req(0, 750, 100, 100), bmp)).toBeNull();
    expect(cropRect(req(0, 0, 0, 100), bmp)).toBeNull();
    expect(cropRect(req(0, 0, 1001, 100), bmp)).toBeNull();
    expect(cropRect(req(0, 0, 500, 721), bmp)).toBeNull();
    expect(cropRect(req(0, 0, 500, 720), bmp)).not.toBeNull();
  });
  it('checks the request shape', () => {
    expect(validRequest(req(1, 2, 3, 4))).toBe(true);
    expect(validRequest({ rect: { x: 1, y: 2, width: 3, height: Number.NaN }, view: { width: 1, height: 1 } })).toBe(false);
    expect(validRequest({ rect: { x: 1, y: 2, width: 3, height: 4 }, view: { width: 0, height: 1 } })).toBe(false);
    expect(validRequest(null)).toBe(false);
    expect(validRequest({ ...req(1, 2, 3, 4), client: { width: 0, height: 1 } })).toBe(false);
  });
});

describe('shootQuote', () => {
  const req = { rect: { x: 10, y: 10, width: 100, height: 100 }, view: { width: 1000, height: 800 } };
  const tab = { id: 7, windowId: 1 };
  const deps = (over: Partial<ShotDeps> = {}): ShotDeps => ({
    activeTab: vi.fn(async () => ({ id: 7, url: 'https://x.com/me/status/2' })),
    capture: vi.fn(async () => 'data:image/png;base64,FULL'),
    size: vi.fn(async () => ({ width: 2000, height: 1600 })),
    crop: vi.fn(async () => 'data:image/png;base64,CROP'),
    isX: (u) => !!u?.startsWith('https://x.com/'),
    ...over,
  });
  it('returns only the crop', async () => {
    const d = deps();
    expect(await shootQuote(tab, req, d)).toBe('data:image/png;base64,CROP');
    expect(d.crop).toHaveBeenCalledWith('data:image/png;base64,FULL', { sx: 20, sy: 20, sw: 200, sh: 200 });
  });
  it('refuses when another tab is in front, before or after the capture, or on another site', async () => {
    const away = deps({ activeTab: vi.fn(async () => ({ id: 8, url: 'https://x.com/' })) });
    await expect(shootQuote(tab, req, away)).rejects.toThrow('not in front');
    expect(away.capture).not.toHaveBeenCalled();
    const switched = deps({ activeTab: vi.fn().mockResolvedValueOnce({ id: 7, url: 'https://x.com/' }).mockResolvedValueOnce({ id: 8, url: 'https://x.com/' }) });
    await expect(shootQuote(tab, req, switched)).rejects.toThrow('changed');
    expect(switched.crop).not.toHaveBeenCalled();
    await expect(shootQuote(tab, req, deps({ activeTab: vi.fn(async () => ({ id: 7, url: 'https://evil.example/' })) }))).rejects.toThrow('not in front');
  });
  it('drops a capture that took longer than 2 s', async () => {
    let t = 0;
    const slow = deps({ now: () => t, capture: vi.fn(async () => ((t += 2500), 'data:image/png;base64,FULL')) });
    await expect(shootQuote(tab, req, slow)).rejects.toThrow('changed');
    expect(slow.crop).not.toHaveBeenCalled();
  });
});

describe('shotGate', () => {
  const store = () => {
    let ids: string[] = [];
    return { getValue: vi.fn(async () => ids), setValue: vi.fn(async (v: string[]) => void (ids = v)) };
  };
  it('lets one of two concurrent asks for a session through, and others sessions too', async () => {
    const st = store();
    const gate = shotGate(st);
    const [a, b, c] = await Promise.all([gate.claim('s1'), gate.claim('s1'), gate.claim('s2')]);
    expect([a, b, c]).toEqual([true, false, true]);
    expect(await st.getValue()).toEqual(['s1', 's2']);
  });
  it('a restarted worker refuses a session that already had its picture', async () => {
    const st = store();
    await shotGate(st).claim('s1');
    expect(await shotGate(st).claim('s1')).toBe(false);
  });
});
