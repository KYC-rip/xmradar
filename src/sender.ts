export interface SenderLike {
  id?: string;
  url?: string;
  frameId?: number;
  tab?: { id?: number; url?: string };
}

export interface SessionLike {
  id: string;
  tabId: number;
  expires: number;
}

// the options page opens in a tab, so sender.tab is set for it too; check the origin instead
export function isExtensionPageSender(sender: SenderLike, runtimeId: string, extensionBaseUrl: string): boolean {
  return sender.id === runtimeId && (sender.url ?? '').startsWith(extensionBaseUrl);
}

/** Throws unless the message comes from our content script in the tab the session was opened for. */
export function checkSessionSender(sessions: SessionLike[], sessionId: string, sender: SenderLike, runtimeId: string, now = Date.now()): void {
  if (sender.id !== runtimeId) throw new Error('Unknown sender');
  const session = sessions.find((s) => s.id === sessionId);
  if (!session || session.expires < now) throw new Error('Composer session expired — reopen it');
  if (sender.tab?.id !== session.tabId) throw new Error('Session belongs to another tab');
}

export const isXHost = (host: string) => /^(?:www\.|mobile\.)?(?:x|twitter)\.com$/.test(host);

/** True for https pages on x.com / twitter.com (and their www/mobile hosts). */
export function isXUrl(url: string | undefined): boolean {
  try {
    const u = new URL(url ?? '');
    return u.protocol === 'https:' && isXHost(u.hostname);
  } catch {
    return false;
  }
}

/** Throws unless a share-menu copy request comes from our content script in the top frame of an X tab. */
export function checkShareMenuSender(sender: SenderLike, runtimeId: string): number {
  if (sender.id !== runtimeId) throw new Error('Unknown sender');
  const tabId = sender.tab?.id;
  if (tabId == null || sender.frameId !== 0) throw new Error('Not allowed');
  // also rules out extension pages, whose URLs aren't https://x.com
  if (!isXUrl(sender.url) || !isXUrl(sender.tab?.url)) throw new Error('Not allowed');
  return tabId;
}

/** The share-menu rate limit: the updated per-tab times, or null if this tab asked less than `gapMs` ago. */
export function shareMenuRateLimit(last: Record<number, number>, tabId: number, now: number, gapMs: number): Record<number, number> | null {
  const prev = last[tabId];
  return prev != null && now - prev < gapMs ? null : { ...last, [tabId]: now };
}

/** The per-tab times without a closed tab. */
export const withoutTab = (last: Record<number, number>, tabId: number): Record<number, number> =>
  Object.fromEntries(Object.entries(last).filter(([id]) => Number(id) !== tabId));
