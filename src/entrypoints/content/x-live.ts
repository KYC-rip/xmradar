/**
 * The live inbox's heartbeat (PLAN-LIVEINBOX): while this X tab is visible and xo/Xap notifications are on, tell
 * the background every 25 s (and at once on becoming visible or switched on). The background keeps one live
 * relay subscription open while any X tab beats, and closes it 70 s after the last beat.
 */

export const BEAT_MS = 25_000;

export interface LiveDeps {
  initial: Promise<boolean>;
  watch: (cb: (on: boolean) => void) => () => void;
  send: () => Promise<unknown>;
  doc?: Document;
}

export function liveHeartbeat(ctx: { onInvalidated(cb: () => void): void }, deps: LiveDeps) {
  const doc = deps.doc ?? document;
  let on = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const beat = () => {
    if (on && doc.visibilityState === 'visible') void deps.send().catch(() => {});
  };
  const set = (next: boolean) => {
    if (next === on) return;
    on = next;
    clearInterval(timer);
    timer = undefined;
    if (on) {
      beat();
      timer = setInterval(beat, BEAT_MS);
    }
  };
  const onVisibility = () => beat();
  doc.addEventListener('visibilitychange', onVisibility);
  void deps.initial.then(set, () => {});
  const unwatch = deps.watch(set);
  ctx.onInvalidated(() => {
    clearInterval(timer);
    doc.removeEventListener('visibilitychange', onVisibility);
    unwatch();
  });
}
