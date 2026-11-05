/**
 * XMRadar on X inside Ripley Terminal's X app (ripley-os plans/x-app-xmradar.md, phases 2–3): tip badges with the
 * tip popup (its wallet link opens Ripley's wallet), xap totals, synced marks, clean copied links, "Copy to
 * Nostr" (into Ripley's Nostr composer) and the xo button (Ripley signs an xo only after its own confirm).
 * Not here: receipts, publishing, XMRadar's composer, AI tags, site info, Sign in with Monero.
 *
 * Injected by Ripley at document start in X's top frame. It does nothing until the page has a body AND
 * Ripley's IPC is present (5 s at most; then it stays inert and says so once in the console — with no IPC there
 * is no channel to Ripley, so the X app infers "didn't start" from a page that loaded without a `status`).
 */
import { browser, findInvoke, VERSION } from './browser';
import { applyState } from './storage';
import { ContentScriptContext } from 'wxt/utils/content-script-context';
import { isXHost } from '../sender';
import { cleanXLinksOn, settingsItem } from '../settings';
import { startBadges } from '../entrypoints/content/x-badges';
import { startCopyLinks } from '../entrypoints/content/x-copy-links';
import { startSyncedMarks } from '../entrypoints/content/x-synced';
import { startShare } from './share';

const WAIT_MS = 5000;
type Status = 'started' | 'inert';

const report = (state: Status) => void browser.runtime.sendMessage({ type: 'status', state, version: VERSION }).catch(() => {});

function start() {
  const ctx = new ContentScriptContext('xmradar-ripley');
  startBadges(ctx);
  startSyncedMarks(ctx);
  // "Copy to Nostr" in X's share menu → Ripley's Nostr composer (phase 3)
  startShare(ctx);
  // X's share tracking taken out of copied X links; switched live
  let stopCopyLinks: (() => void) | null = null;
  const setCopyLinks = (on: boolean) => {
    if (on && !stopCopyLinks && ctx.isValid) stopCopyLinks = startCopyLinks(document);
    else if (!on && stopCopyLinks) {
      stopCopyLinks();
      stopCopyLinks = null;
    }
  };
  void settingsItem.getValue().then((s) => setCopyLinks(cleanXLinksOn(s)));
  const unwatch = settingsItem.watch((s) => setCopyLinks(cleanXLinksOn(s)));
  ctx.onInvalidated(() => {
    unwatch();
    setCopyLinks(false);
  });
  addEventListener('pagehide', () => ctx.abort('page hidden'), { once: true });
  report('started');
}

export function boot(now: () => number = Date.now) {
  const w = window as unknown as { __xmradarRipley?: boolean; __xmradarRipleyState?: unknown };
  if (window.top !== window || !isXHost(location.hostname) || w.__xmradarRipley) return;
  w.__xmradarRipley = true;
  applyState(w.__xmradarRipleyState);
  delete w.__xmradarRipleyState;
  addEventListener('xmradar:state', (e) => applyState((e as CustomEvent).detail));

  const began = now();
  const tick = () => {
    if (document.body && findInvoke()) return start();
    if (now() - began >= WAIT_MS) {
      console.warn('[XMRadar] Ripley isn’t reachable from this page; XMRadar stays off here');
      return report('inert');
    }
    setTimeout(tick, 50);
  };
  tick();
}

boot();
