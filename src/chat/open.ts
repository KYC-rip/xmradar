/**
 * Opening the chat panel from the popup (PLAN-CHATPANEL). Both browsers want the call inside the click,
 * so nothing is awaited before it; anything that fails opens the chat in a tab instead.
 */
export interface OpenApis {
  /** Chrome's `sidePanel.open` */
  sidePanelOpen?: (o: { windowId: number }) => Promise<void>;
  /** Firefox's `sidebarAction.open` */
  sidebarOpen?: () => Promise<void>;
  /** the popup's window, read when it loaded */
  windowId?: number;
  openTab(): Promise<unknown>;
  close(): void;
}

export function openChat(a: OpenApis): Promise<void> {
  const inTab = () => a.openTab().then(a.close, a.close);
  let opened: Promise<void> | undefined;
  try {
    if (a.sidePanelOpen && a.windowId != null) opened = a.sidePanelOpen({ windowId: a.windowId });
    else if (a.sidebarOpen) opened = a.sidebarOpen();
  } catch {
    opened = undefined;
  }
  return opened ? opened.then(a.close, inTab) : inTab();
}
