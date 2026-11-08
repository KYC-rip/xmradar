import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.hoisted(() => vi.fn());
vi.mock('../src/messaging', async (orig) => ({ ...(await orig<typeof import('../src/messaging')>()), sendToBackground: send }));

import { insertXo, setXoState, XO_SELECTOR, xoManager } from '../src/entrypoints/content/x-xo';

// PLAN-MONEROLIKE: an action bar with X's reply and share buttons and our Xap button between them
const AUTHOR = 'a'.repeat(64);
function tweet() {
  document.body.innerHTML = `<article data-testid="tweet"><a href="/alice/status/123"><time>1h</time></a><div role="group">
    <div><button data-testid="reply"><div><svg></svg><span>3</span></div></button></div>
    <div><button data-testid="like"><svg></svg></button></div>
    <div data-xmradar="xap"><button type="button"><div><div></div><svg data-xmradar="xap-icon"></svg><span data-xmradar="xap-count"></span></div></button></div>
    <div><button aria-haspopup="menu"><svg></svg></button></div>
  </div></article>`;
  return document.querySelector('article')!;
}
const click = (el: Element) => {
  const e = new MouseEvent('click', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'isTrusted', { value: true });
  el.dispatchEvent(e);
};
const opts = { post: '123', author: AUTHOR, handle: 'alice', own: false, sent: false };

describe('the xo button', () => {
  beforeEach(() => send.mockReset());

  it('sits right after the Xap button, once per bar', () => {
    const a = tweet();
    insertXo(a, opts);
    insertXo(a, opts);
    const kids = [...a.querySelector('[role="group"]')!.children];
    expect(kids.map((k) => k.getAttribute('data-xmradar'))).toEqual([null, null, 'xap', 'xo', null]);
    expect(a.querySelectorAll(XO_SELECTOR).length).toBe(1);
    const btn = a.querySelector(`${XO_SELECTOR} button`)!;
    expect(btn.getAttribute('aria-label')).toBe('Send @alice an xo (a Monero like, over Nostr). Click: xo · Hold: xo + like on X');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('a click sends it and shows it sent at once; another takes it back', async () => {
    send.mockResolvedValue({ ok: true, id: 'x' });
    const a = tweet();
    insertXo(a, opts);
    const wrap = a.querySelector<HTMLElement>(XO_SELECTOR)!;
    click(wrap.querySelector('button')!);
    expect(wrap.dataset.sent).toBe('true');
    await vi.waitFor(() => expect(wrap.dataset.busy).toBeUndefined());
    expect(send).toHaveBeenCalledWith({ type: 'xo-send', post: '123', author: AUTHOR, handle: 'alice' });
    expect(wrap.querySelector('svg path')!.getAttribute('fill')).toBe('#f26822');
    click(wrap.querySelector('button')!);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'xo-undo', post: '123' }));
    await vi.waitFor(() => expect(wrap.dataset.sent).toBe('false'));
  });

  it('a refusal puts it back and says why', async () => {
    send.mockResolvedValue({ ok: false, error: 'No relay took it' });
    const a = tweet();
    insertXo(a, opts);
    const wrap = a.querySelector<HTMLElement>(XO_SELECTOR)!;
    click(wrap.querySelector('button')!);
    await vi.waitFor(() => expect(wrap.dataset.sent).toBe('false'));
    expect(wrap.querySelector('button')!.title).toBe('Not sent: No relay took it');
  });

  it('a click made by the page sends nothing', () => {
    const a = tweet();
    insertXo(a, opts);
    a.querySelector<HTMLElement>(`${XO_SELECTOR} button`)!.click();
    expect(send).not.toHaveBeenCalled();
  });

  it('the user’s own post: an xo of their own counts as one, as on X', async () => {
    send.mockResolvedValue({ ok: true, id: 'x' });
    const a = tweet();
    insertXo(a, { ...opts, own: true, count: 4 });
    const wrap = a.querySelector<HTMLElement>(XO_SELECTOR)!;
    const count = () => wrap.querySelector('[data-xmradar="xo-count"]')!.textContent;
    expect(count()).toBe('4');
    expect(wrap.querySelector('button')!.title).toBe('xo: 4 from Monero people. Click: xo · Hold: xo + like on X');
    click(wrap.querySelector('button')!);
    expect(count()).toBe('5');
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'xo-send', post: '123', author: AUTHOR, handle: 'alice' }));
    expect(wrap.querySelector('button')!.title).toBe('xo: 5, yours included. Click to take yours back.');
  });

  it('counts show only on the user’s own posts', () => {
    const a = tweet();
    insertXo(a, { ...opts, count: 9 });
    const wrap = a.querySelector<HTMLElement>(XO_SELECTOR)!;
    expect(wrap.querySelector('[data-xmradar="xo-count"]')!.textContent).toBe('');
    setXoState(wrap, { ...opts, own: true }, 9);
    expect(wrap.querySelector('[data-xmradar="xo-count"]')!.textContent).toBe('9');
  });
});

describe('xoManager', () => {
  it('own posts only with a proven handle; a new xo celebrates once and is remembered', () => {
    const save = vi.fn();
    const a = tweet();
    const m = xoManager({ on: true, me: { handle: 'Alice', proven: false }, sent: {}, counts: { '123': 2 }, seen: {} }, save);
    m.place(a, '123', AUTHOR, 'alice');
    const count = () => a.querySelector('[data-xmradar="xo-count"]')!.textContent;
    expect(count()).toBe('');
    m.update({ me: { handle: 'Alice', proven: true } });
    expect(count()).toBe('2');
    // on screen (happy-dom lays nothing out, so give it a box)
    const wrap = a.querySelector<HTMLElement>(XO_SELECTOR)!;
    wrap.getBoundingClientRect = () => ({ top: 10, bottom: 40, left: 0, right: 40, width: 40, height: 30, x: 0, y: 10, toJSON() {} }) as DOMRect;
    m.update({ counts: { '123': 3 } });
    expect(save).toHaveBeenLastCalledWith({ '123': 3 });
    save.mockClear();
    m.update({ counts: { '123': 3 } });
    expect(save).not.toHaveBeenCalled();
  });
  it('switched off: the buttons go', () => {
    const a = tweet();
    const m = xoManager({ on: true, me: null, sent: {}, counts: {}, seen: {} }, () => {});
    m.place(a, '123', AUTHOR, 'alice');
    expect(a.querySelector(XO_SELECTOR)).not.toBeNull();
    m.update({ on: false });
    expect(a.querySelector(XO_SELECTOR)).toBeNull();
    m.place(a, '123', AUTHOR, 'alice');
    expect(a.querySelector(XO_SELECTOR)).toBeNull();
  });
});

describe('hold to also like on X (PLAN-XOLIKE)', () => {
  const ptr = (type: string, init: PointerEventInit = {}) => {
    const e = new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 10, ...init });
    Object.defineProperty(e, 'isTrusted', { value: true });
    return e;
  };
  // X's like turns into "unlike" when pressed, as on x.com
  const wireLike = (a: Element) => {
    const like = a.querySelector<HTMLElement>('[data-testid="like"]')!;
    const pressed = vi.fn(() => like.setAttribute('data-testid', 'unlike'));
    like.addEventListener('click', pressed);
    return pressed;
  };
  beforeEach(() => {
    send.mockReset().mockResolvedValue({ ok: true, id: 'x' });
  });

  it('a hold of half a second sends the xo and likes the post; the click that ends it isn’t sent again', async () => {
    vi.useFakeTimers();
    const a = tweet();
    const pressed = wireLike(a);
    insertXo(a, opts);
    const btn = a.querySelector<HTMLElement>(`${XO_SELECTOR} button`)!;
    btn.dispatchEvent(ptr('pointerdown'));
    await vi.advanceTimersByTimeAsync(520);
    btn.dispatchEvent(ptr('pointerup'));
    click(btn);
    vi.useRealTimers();
    await vi.waitFor(() => expect(pressed).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a short press is a plain xo; moving while holding cancels the hold', async () => {
    vi.useFakeTimers();
    const a = tweet();
    const pressed = wireLike(a);
    insertXo(a, opts);
    const btn = a.querySelector<HTMLElement>(`${XO_SELECTOR} button`)!;
    btn.dispatchEvent(ptr('pointerdown'));
    btn.dispatchEvent(ptr('pointermove', { clientX: 30, clientY: 10 }));
    await vi.advanceTimersByTimeAsync(600);
    expect(send).not.toHaveBeenCalled();
    btn.dispatchEvent(ptr('pointerdown'));
    await vi.advanceTimersByTimeAsync(200);
    btn.dispatchEvent(ptr('pointerup'));
    click(btn);
    vi.useRealTimers();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(pressed).not.toHaveBeenCalled();
  });

  it('the like goes at once, before the xo is out; a post already liked isn’t pressed again', async () => {
    send.mockImplementation(() => new Promise(() => {}));
    let a = tweet();
    let pressed = wireLike(a);
    insertXo(a, { ...opts, alsoLike: true });
    click(a.querySelector(`${XO_SELECTOR} button`)!);
    expect(pressed).toHaveBeenCalledTimes(1);
    send.mockReset().mockResolvedValue({ ok: true, id: 'x' });
    a = tweet();
    a.querySelector('[data-testid="like"]')!.setAttribute('data-testid', 'unlike');
    pressed = vi.fn();
    a.querySelector('[data-testid="unlike"]')!.addEventListener('click', pressed);
    insertXo(a, { ...opts, alsoLike: true });
    click(a.querySelector(`${XO_SELECTOR} button`)!);
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(pressed).not.toHaveBeenCalled();
  });

  it('Shift+Enter is the keyboard’s hold; with the setting on, a plain click likes too', async () => {
    let a = tweet();
    let pressed = wireLike(a);
    insertXo(a, opts);
    const key = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
    Object.defineProperty(key, 'isTrusted', { value: true });
    a.querySelector(`${XO_SELECTOR} button`)!.dispatchEvent(key);
    await vi.waitFor(() => expect(pressed).toHaveBeenCalledTimes(1));
    a = tweet();
    pressed = wireLike(a);
    insertXo(a, { ...opts, alsoLike: true });
    click(a.querySelector(`${XO_SELECTOR} button`)!);
    await vi.waitFor(() => expect(pressed).toHaveBeenCalledTimes(1));
  });

  it('the like goes to the post by its id; a post X no longer shows says so', async () => {
    const a = tweet();
    insertXo(a, { ...opts, alsoLike: true });
    // X reused this article for another post before the click
    a.querySelector('a[href*="/status/"]')!.setAttribute('href', '/bob/status/999');
    const other = wireLike(a);
    click(a.querySelector(`${XO_SELECTOR} button`)!);
    await vi.waitFor(() => expect(a.querySelector<HTMLElement>(XO_SELECTOR)!.dataset.busy).toBeUndefined(), { timeout: 3000 });
    expect(other).not.toHaveBeenCalled();
    expect(a.querySelector(`${XO_SELECTOR} button`)!.getAttribute('title')).toContain('couldn’t be pressed');
  });
});

describe('no key known: the xo goes to the handle (PLAN-XOREACH)', () => {
  beforeEach(() => send.mockReset().mockResolvedValue({ ok: true, id: 'x' }));
  it('not faded; a click sends an xo to the handle, and says it waits for them', async () => {
    const a = tweet();
    insertXo(a, { ...opts, author: null });
    const wrap = a.querySelector<HTMLElement>(XO_SELECTOR)!;
    const btn = wrap.querySelector<HTMLElement>('button')!;
    expect(wrap.style.opacity).toBe('');
    expect(btn.title).toBe('@alice hasn’t set up XMRadar yet. Your xo waits for them, and counts once they do. Click: xo · Hold: xo + like on X');
    click(btn);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'xo-send', post: '123', author: null, handle: 'alice' }));
    await vi.waitFor(() => expect(wrap.dataset.busy).toBeUndefined());
    expect(wrap.dataset.sent).toBe('true');
    expect(btn.title).toBe('You sent an xo. It waits for @alice to set up XMRadar. Click to take it back.');
  });
  it('a key learned later redraws it with the key', () => {
    const a = tweet();
    insertXo(a, { ...opts, author: null });
    insertXo(a, opts);
    const wrap = a.querySelector<HTMLElement>(XO_SELECTOR)!;
    expect(a.querySelectorAll(XO_SELECTOR).length).toBe(1);
    expect(wrap.dataset.author).toBe(AUTHOR);
  });
});

describe('review fixes (PLAN-XOKEYS)', () => {
  const ptr = (type: string) => {
    const e = new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5 });
    Object.defineProperty(e, 'isTrusted', { value: true });
    return e;
  };
  beforeEach(() => send.mockReset().mockResolvedValue({ ok: true, id: 'x' }));

  it('a two-second hold sends one xo and likes once; the release’s click doesn’t take it back', async () => {
    vi.useFakeTimers();
    const a = tweet();
    const like = a.querySelector<HTMLElement>('[data-testid="like"]')!;
    const pressed = vi.fn(() => like.setAttribute('data-testid', 'unlike'));
    like.addEventListener('click', pressed);
    insertXo(a, opts);
    const btn = a.querySelector<HTMLElement>(`${XO_SELECTOR} button`)!;
    btn.dispatchEvent(ptr('pointerdown'));
    await vi.advanceTimersByTimeAsync(2000);
    btn.dispatchEvent(ptr('pointerup'));
    click(btn);
    await vi.advanceTimersByTimeAsync(10);
    vi.useRealTimers();
    await vi.waitFor(() => expect(a.querySelector<HTMLElement>(XO_SELECTOR)!.dataset.busy).toBeUndefined());
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: 'xo-send', post: '123', author: AUTHOR, handle: 'alice' });
    expect(pressed).toHaveBeenCalledTimes(1);
    expect(a.querySelector<HTMLElement>(XO_SELECTOR)!.dataset.sent).toBe('true');
  });

  it('a refused xo after a hold leaves the X like (the user asked for it) and says the xo didn’t go', async () => {
    send.mockResolvedValue({ ok: false, error: 'No relay took it' });
    const a = tweet();
    const like = a.querySelector<HTMLElement>('[data-testid="like"]')!;
    const pressed = vi.fn(() => like.setAttribute('data-testid', 'unlike'));
    like.addEventListener('click', pressed);
    insertXo(a, { ...opts, alsoLike: true });
    click(a.querySelector(`${XO_SELECTOR} button`)!);
    await vi.waitFor(() => expect(a.querySelector<HTMLElement>(XO_SELECTOR)!.dataset.sent).toBe('false'));
    expect(pressed).toHaveBeenCalledTimes(1);
    expect(a.querySelector(`${XO_SELECTOR} button`)!.getAttribute('title')).toBe('Not sent: No relay took it');
  });
});
