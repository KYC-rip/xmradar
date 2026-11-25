/**
 * Cross-platform browser API compatibility layer (PLAN-ANDROID).
 * Desktop Chrome & Firefox expose windows, contextMenus, commands, notifications, alarms,
 * permissions, and action; Firefox for Android and GeckoView omit or partially implement
 * several of these. Every helper here is pure and dependency-injected so unit tests can
 * omit any namespace one at a time.
 */

export interface OpenPageApis {
  windows?: { create?(opts: { url: string; type: 'popup'; width: number; height: number }): Promise<{ id?: number } | undefined> };
  tabs?: { create?(opts: { url: string }): Promise<{ id?: number } | undefined> };
}

export type OpenedPage = { kind: 'window' | 'tab'; id: number } | undefined;

/** Opens an extension page in a popup window on desktop, or a tab on Android / GeckoView. */
export async function openExtensionPage(url: string, apis: OpenPageApis): Promise<OpenedPage> {
  if (apis.windows?.create) {
    try {
      const win = await apis.windows.create({ url, type: 'popup', width: 520, height: 720 });
      if (win?.id != null) return { kind: 'window', id: win.id };
      return undefined;
    } catch {
      // Android / GeckoView may expose windows stub that rejects popup creation; fall back to tab
    }
  }
  const tab = await apis.tabs?.create?.({ url });
  return tab?.id != null ? { kind: 'tab', id: tab.id } : undefined;
}

export interface ClosePageApis {
  tabs?: {
    getCurrent?(): Promise<{ id?: number } | undefined>;
    remove?(tabId: number): Promise<void>;
  };
  closeWindow(): void;
}

/** Closes the current extension popup/window or tab (window.close() is a no-op in a GeckoView tab). */
export async function closeCurrentPage(apis: ClosePageApis): Promise<void> {
  try {
    const tab = await apis.tabs?.getCurrent?.();
    if (tab?.id != null && apis.tabs?.remove) {
      await apis.tabs.remove(tab.id);
      return;
    }
  } catch {
    // not in a tab or tabs.remove unavailable; fall back to window.close()
  }
  apis.closeWindow();
}

export interface NotificationsLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  create?: (...args: any[]) => unknown;
  clear?: (id: string) => unknown;
  onClicked?: { addListener(fn: (id: string) => void): void };
}

export async function safeNotify(notifications: NotificationsLike | null | undefined, idOrOpts: unknown, opts?: unknown): Promise<void> {
  if (!notifications?.create) return;
  try {
    await (opts !== undefined ? notifications.create(idOrOpts, opts) : notifications.create(idOrOpts));
  } catch {
    // notifications may be denied or unsupported on Android/GeckoView
  }
}

export async function safeClearNotice(notifications: NotificationsLike | null | undefined, id: string): Promise<void> {
  if (!notifications?.clear) return;
  try {
    await notifications.clear(id);
  } catch {}
}

export function safeOnNotificationClicked(notifications: NotificationsLike | null | undefined, fn: (id: string) => void): void {
  notifications?.onClicked?.addListener(fn);
}

export interface AlarmsLike {
  create(name: string, alarmInfo: { delayInMinutes?: number; periodInMinutes?: number; when?: number }): unknown;
  clear(name?: string): Promise<boolean>;
  get(name?: string): Promise<unknown>;
  onAlarm?: { addListener(fn: (alarm: { name: string }) => void): void };
}

/** Returns a safe no-op alarms facade when browser.alarms is missing. */
export function safeAlarms<T extends AlarmsLike>(alarms: T | null | undefined): T {
  if (alarms) return alarms;
  return {
    create: () => {},
    clear: async () => false,
    get: async () => undefined,
    onAlarm: { addListener: () => {} },
  } as unknown as T;
}

export interface PermissionsLike {
  contains?(perms: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
  request?(perms: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
}

export async function safePermissionsContains(permissions: PermissionsLike | null | undefined, perms: { origins?: string[]; permissions?: string[] }): Promise<boolean> {
  if (!permissions?.contains) return false;
  try {
    return await permissions.contains(perms);
  } catch {
    return false;
  }
}

export async function safePermissionsRequest(permissions: PermissionsLike | null | undefined, perms: { origins?: string[]; permissions?: string[] }): Promise<boolean> {
  if (!permissions?.request) return false;
  try {
    return await permissions.request(perms);
  } catch {
    return false;
  }
}

export interface TabsQueryLike {
  query?(queryInfo: { active?: boolean; currentWindow?: boolean }): Promise<Array<{ id?: number; url?: string; active?: boolean }>>;
}

/**
 * Finds the site tab whose xmr.club card the popup should show:
 * 1. Explicit `?tabId=<int>` if provided;
 * 2. Active tab in the current window if it is not an extension page;
 * 3. Otherwise (e.g. popup running as a tab in the Android shell), matches an open https:// tab
 *    preferring the `?siteUrl=` hint from the shell, then any active/open https:// tab.
 */
export async function resolveActiveSiteTabId(tabs: TabsQueryLike | null | undefined, search: string, extOrigin: string): Promise<number | null> {
  const params = new URLSearchParams(search);
  const param = params.get('tabId');
  if (param && /^\d+$/.test(param)) return Number(param);
  if (!tabs?.query) return null;
  try {
    const active = await tabs.query({ active: true, currentWindow: true });
    const first = active[0];
    if (first?.id != null && (!first.url || !first.url.startsWith(extOrigin))) return first.id;
    const all = await tabs.query({});
    const httpsTabs = all.filter((t) => t.id != null && t.url && /^https:\/\//.test(t.url));
    const siteHint = params.get('siteUrl');
    if (siteHint && /^https:\/\//.test(siteHint)) {
      const exact = httpsTabs.find((t) => t.url === siteHint);
      if (exact?.id != null) return exact.id;
      try {
        const hintOrigin = new URL(siteHint).origin;
        const sameOrigin = httpsTabs.find((t) => {
          try {
            return new URL(t.url!).origin === hintOrigin;
          } catch {
            return false;
          }
        });
        if (sameOrigin?.id != null) return sameOrigin.id;
      } catch {}
    }
    const candidate = httpsTabs.find((t) => t.active) ?? httpsTabs[0];
    return candidate?.id ?? null;
  } catch {
    return null;
  }
}
