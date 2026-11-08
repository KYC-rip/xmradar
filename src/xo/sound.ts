/**
 * The xo's sound (PLAN-XOSOUND): a short, quiet pop rising into two notes when the user sends an xo, a third
 * for a hold (xo + like on X). Made with Web Audio, nothing downloaded. `primeXoSound` runs in the gesture
 * handler (click, Shift+Enter, the pointerdown of a hold), since the hold's xo fires from a timer and browsers
 * only start audio on a user gesture; `playXoSound` then schedules notes on the running context. Never throws.
 */

export const MASTER_GAIN = 0.08;
const NOTE_PEAK = 0.6;
const FLOOR = 0.0001;
export const IDLE_CLOSE_MS = 30_000;

type Ctx = AudioContext;
let ctx: Ctx | null = null;
let idle: ReturnType<typeof setTimeout> | undefined;

function closeLater() {
  clearTimeout(idle);
  idle = setTimeout(() => {
    const c = ctx;
    ctx = null;
    idle = undefined;
    void c?.close().catch(() => {});
  }, IDLE_CLOSE_MS);
}

/** Makes (or wakes) the audio context; call it in the user's gesture. */
export function primeXoSound(): void {
  try {
    const AC = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!AC) return;
    if (!ctx || ctx.state === 'closed') ctx = new AC();
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    closeLater();
  } catch {
    ctx = null;
  }
}

/** One note into `out`: a 5 ms attack to NOTE_PEAK, an exponential fall to near silence, then stopped. */
function note(c: Ctx, out: AudioNode, type: OscillatorType, at: number, from: number, to: number, glide: number, len: number) {
  const osc = c.createOscillator();
  const env = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, at);
  if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, at + glide);
  env.gain.setValueAtTime(FLOOR, at);
  env.gain.exponentialRampToValueAtTime(NOTE_PEAK, at + 0.005);
  env.gain.exponentialRampToValueAtTime(FLOOR, at + len);
  osc.connect(env);
  env.connect(out);
  osc.start(at);
  osc.stop(at + len + 0.02);
}

/** The pop: 660→990 Hz, then 1320 Hz; `big` adds 1760 Hz. Silent unless primed (in a gesture). */
export function playXoSound(big = false): void {
  try {
    const c = ctx;
    if (!c || c.state === 'closed') return;
    // primed in this gesture but still waking: play once it runs
    if (c.state !== 'running') return void c.resume().then(() => ctx === c && c.state === 'running' && schedule(c, big), () => {});
    schedule(c, big);
  } catch {
    /* silent */
  }
}

function schedule(c: Ctx, big: boolean) {
  try {
    const t = c.currentTime + 0.005;
    const master = c.createGain();
    master.gain.setValueAtTime(MASTER_GAIN, t);
    master.connect(c.destination);
    note(c, master, 'triangle', t, 660, 990, 0.05, 0.09);
    note(c, master, 'sine', t + 0.06, 1320, 1320, 0, 0.12);
    if (big) note(c, master, 'sine', t + 0.12, 1760, 1760, 0, 0.14);
    // out of the graph once the last note has ended
    setTimeout(() => {
      try {
        master.disconnect();
      } catch {
        /* gone with its context */
      }
    }, 600);
    closeLater();
  } catch {
    /* silent */
  }
}

/** Tests only. */
export const resetXoSound = () => {
  clearTimeout(idle);
  idle = undefined;
  ctx = null;
};
