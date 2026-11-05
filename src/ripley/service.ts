/**
 * XMRadar's lookups for RipleyOS (ripley-os plans/x-app-xmradar.md, R13–R17): the same code the extension's
 * background runs for X badges, tip popups and xap totals, built as one ES module that RipleyOS imports. RipleyOS
 * supplies every connection (its routed fetch, its relay reads), the storage, and the settings.
 */
import { directoryKeeper, DIRECTORY_ALARM, DIRECTORY_RETRY_ALARM, type KeeperDeps } from '../identity/directory';
import { boundedBody } from '../service/bounded-body';

declare const __XMRADAR_VERSION__: string;
export const version = typeof __XMRADAR_VERSION__ === 'string' ? __XMRADAR_VERSION__ : 'dev';
export { xLookups, REQUEST_TYPES, type XLookups, type XLookupsDeps, type Kv, type RateKey } from '../service/x-lookups';
export { directoryKeeper, boundedBody, type KeeperDeps };
// phase 3: xo (Ripley signs, after its own confirm) and the synced marks (Ripley records copies to Nostr)
export { KIND_XO, XO_CONTENT, xoTemplate, undoTemplate, xoOf, readRelaysFrom, xoRelayOrder } from '../xo/event';
export { rememberSent, MAX_SENT, type SentXo } from '../xo/sent';
export { xoKeeper, freshXoInbox, xoCounts, XO_ALARM, XO_MINUTES, type XoInbox, type XoDeps, type XoItem } from '../xo/inbox';
export { verifyLiker, knownLiker, rememberLiker, type Liker, type LikerCache } from '../xo/verify';
// the key an X account's xo goes to, from a badge the service answered (Ripley checks a page's xo against it)
export { xoKey } from '../identity/resolve';
// phase 4: tip receipts, published by RipleyOS after its wallet's send and the user's yes
export { publishXap, withSent, type PublishDeps, type PublishRequest } from '../xap/service';
export { recordSynced, syncedLink, MAX_SYNCED, type SyncedPost, type SyncedPosts } from '../nostr/synced';

/**
 * `browser.alarms` for the directory keeper, on timers: the hourly refresh and the retry run while RipleyOS
 * keeps this alive (the X window is open); `stop()` clears them all.
 */
export function timerAlarms() {
  const timers = new Map<string, { id: ReturnType<typeof setTimeout>; periodInMinutes?: number }>();
  let onAlarm: (name: string) => unknown = () => {};
  const clear = async (name: string) => {
    const t = timers.get(name);
    if (t) clearTimeout(t.id);
    return timers.delete(name);
  };
  const alarms: KeeperDeps['alarms'] = {
    async create(name, info) {
      await clear(name);
      const period = info.periodInMinutes;
      const first = (info.delayInMinutes ?? period ?? 0) * 60_000;
      const fire = () => {
        if (period) timers.set(name, { id: setTimeout(fire, period * 60_000), periodInMinutes: period });
        else timers.delete(name);
        void onAlarm(name);
      };
      timers.set(name, { id: setTimeout(fire, first), periodInMinutes: period });
    },
    clear,
    get: async (name) => (timers.has(name) ? { periodInMinutes: timers.get(name)!.periodInMinutes } : undefined),
  };
  return {
    alarms,
    /** the keeper's onAlarm */
    listen(fn: (name: string) => unknown) {
      onAlarm = fn;
    },
    stop() {
      for (const t of timers.values()) clearTimeout(t.id);
      timers.clear();
    },
    names: [DIRECTORY_ALARM, DIRECTORY_RETRY_ALARM],
  };
}
