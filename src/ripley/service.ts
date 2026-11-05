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
