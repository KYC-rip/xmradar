import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.hoisted(() => vi.fn());
vi.mock('../src/messaging', async (orig) => ({ ...(await orig<typeof import('../src/messaging')>()), sendToBackground: send }));

import { IDLE_CLOSE_MS, MASTER_GAIN, playXoSound, primeXoSound, resetXoSound } from '../src/xo/sound';
import { insertXo, XO_SELECTOR } from '../src/entrypoints/content/x-xo';
import { xoSoundOn } from '../src/settings';

// PLAN-XOSOUND: a fake Web Audio that records what's played
interface Rec {
  made: number;
  closed: number;
  notes: { type: string; freqs: number[] }[];
  masters: number[];
  ramps: number[];
}
let rec: Rec;
let startState: AudioContextState;
let resumeFails = false;
class FakeParam {
  constructor(private onSet: (v: number) => void = () => {}) {}
  setValueAtTime(v: number) {
    this.onSet(v);
  }
  exponentialRampToValueAtTime(v: number) {
    rec.ramps.push(v);
    this.onSet(v);
  }
}
class FakeCtx {
  state: AudioContextState = startState;
  currentTime = 1;
  destination = {};
  constructor() {
    rec.made++;
  }
  resume() {
    if (resumeFails) return Promise.reject(new Error('no'));
    this.state = 'running';
    return Promise.resolve();
  }
  close() {
    rec.closed++;
    this.state = 'closed';
    return Promise.resolve();
  }
  createGain() {
    let first = true;
    const node = {
      connect: (to: unknown) => {
        if (to === this.destination) rec.masters.push(node.value);
      },
      value: 0,
      gain: new FakeParam((v) => {
        if (first) node.value = v;
        first = false;
      }),
    };
    return node;
  }
  createOscillator() {
    const n = { type: 'sine', freqs: [] as number[] };
    rec.notes.push(n);
    return { set type(t: string) { n.type = t; }, frequency: new FakeParam((v) => n.freqs.push(v)), connect() {}, start() {}, stop() {} };
  }
}

beforeEach(() => {
  rec = { made: 0, closed: 0, notes: [], masters: [], ramps: [] };
  startState = 'running';
  resumeFails = false;
  resetXoSound();
  (globalThis as { AudioContext?: unknown }).AudioContext = FakeCtx;
  send.mockReset();
});
afterEach(() => {
  delete (globalThis as { AudioContext?: unknown }).AudioContext;
  vi.useRealTimers();
});

describe('the sound', () => {
  it('a pop and two notes; a hold adds a third, through one quiet master', () => {
    primeXoSound();
    playXoSound();
    expect(rec.notes.map((n) => [n.type, n.freqs[0]])).toEqual([['triangle', 660], ['sine', 1320]]);
    expect(rec.notes[0]!.freqs).toEqual([660, 990]);
    playXoSound(true);
    expect(rec.notes.slice(2).map((n) => n.freqs[0])).toEqual([660, 1320, 1760]);
    expect(rec.masters).toEqual([MASTER_GAIN, MASTER_GAIN]);
    expect(Math.min(...rec.ramps)).toBeGreaterThan(0);
    expect(rec.made).toBe(1);
  });
  it('silent without a prime (no gesture), without Web Audio, or when waking fails; never throws', async () => {
    playXoSound();
    expect(rec.notes.length).toBe(0);
    delete (globalThis as { AudioContext?: unknown }).AudioContext;
    expect(() => {
      primeXoSound();
      playXoSound();
    }).not.toThrow();
    (globalThis as { AudioContext?: unknown }).AudioContext = FakeCtx;
    startState = 'suspended';
    resumeFails = true;
    primeXoSound();
    playXoSound();
    await Promise.resolve();
    expect(rec.notes.length).toBe(0);
  });
  it('a context still waking plays once it runs', async () => {
    startState = 'suspended';
    primeXoSound();
    playXoSound();
    await vi.waitFor(() => expect(rec.notes.length).toBe(2));
  });
  it('closes 30 s after the last use, a prime alone included, and is made again next time', () => {
    vi.useFakeTimers();
    primeXoSound();
    vi.advanceTimersByTime(IDLE_CLOSE_MS - 1);
    playXoSound();
    vi.advanceTimersByTime(IDLE_CLOSE_MS - 1);
    expect(rec.closed).toBe(0);
    vi.advanceTimersByTime(1);
    expect(rec.closed).toBe(1);
    primeXoSound();
    expect(rec.made).toBe(2);
  });
  it('the switch is on unless turned off', () => {
    expect(xoSoundOn({})).toBe(true);
    expect(xoSoundOn({ xoSound: false })).toBe(false);
  });
});

function tweet() {
  document.body.innerHTML = `<article data-testid="tweet"><a href="/bob/status/123"><time>1h</time></a><div role="group">
    <div><button data-testid="reply"><div><svg></svg><span>3</span></div></button></div>
    <div><button data-testid="like"><svg></svg></button></div>
    <div data-xmradar="xap"><button type="button"><div><div></div><svg data-xmradar="xap-icon"></svg><span data-xmradar="xap-count"></span></div></button></div>
    <div><button aria-haspopup="menu"><svg></svg></button></div>
  </div></article>`;
  return document.querySelector('article')!;
}
const trusted = <T extends Event>(e: T) => (Object.defineProperty(e, 'isTrusted', { value: true }), e);
const opts = { post: '123', author: 'a'.repeat(64), handle: 'bob', own: false, sent: false };

describe('the button’s sound', () => {
  it('a click sends with a sound; taking it back is silent', async () => {
    send.mockResolvedValue({ ok: true, id: 'x' });
    const a = tweet();
    insertXo(a, opts);
    const btn = a.querySelector<HTMLElement>(`${XO_SELECTOR} button`)!;
    btn.dispatchEvent(trusted(new MouseEvent('click', { bubbles: true, cancelable: true })));
    expect(rec.notes.length).toBe(2);
    await vi.waitFor(() => expect(a.querySelector<HTMLElement>(XO_SELECTOR)!.dataset.busy).toBeUndefined());
    btn.dispatchEvent(trusted(new MouseEvent('click', { bubbles: true, cancelable: true })));
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'xo-undo', post: '123' }));
    expect(rec.notes.length).toBe(2);
  });
  it('switched off: no sound, and no audio made', () => {
    send.mockResolvedValue({ ok: true, id: 'x' });
    const a = tweet();
    insertXo(a, { ...opts, sound: false });
    a.querySelector<HTMLElement>(`${XO_SELECTOR} button`)!.dispatchEvent(trusted(new MouseEvent('click', { bubbles: true, cancelable: true })));
    expect(rec.made).toBe(0);
    expect(rec.notes.length).toBe(0);
  });
  it('a hold: primed on the pointerdown, the bigger sound from the timer; a right button primes nothing', () => {
    vi.useFakeTimers();
    send.mockResolvedValue({ ok: true, id: 'x' });
    const a = tweet();
    insertXo(a, opts);
    const btn = a.querySelector<HTMLElement>(`${XO_SELECTOR} button`)!;
    btn.dispatchEvent(trusted(new PointerEvent('pointerdown', { bubbles: true, button: 2 })));
    expect(rec.made).toBe(0);
    btn.dispatchEvent(trusted(new PointerEvent('pointerdown', { bubbles: true, button: 0 })));
    expect(rec.made).toBe(1);
    expect(rec.notes.length).toBe(0);
    vi.advanceTimersByTime(500);
    expect(rec.notes.map((n) => n.freqs[0])).toEqual([660, 1320, 1760]);
  });
});
