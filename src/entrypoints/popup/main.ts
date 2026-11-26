import type { InboxState } from '../../xap/inbox';
import '../../ui/base.css';
import './style.css';
import { npubEncode } from 'nostr-tools/nip19';
import { currentBuild } from '../../build-info';
import { badgeSummary, setupStatusLast, statusFor } from '../../identity/status';
import { pubkeyItem, setupDoneItem, xapInboxItem } from '../../settings';

/** Done for this key, by the saved flag or, before one was saved (0.6.12), by the last status check. */
async function setupComplete() {
  const [pk, done, stored] = await Promise.all([pubkeyItem.getValue(), setupDoneItem.getValue(), setupStatusLast.getValue()]);
  if (!pk) return false;
  if (done?.pubkey === pk) return done.done;
  const st = statusFor(stored, pk)?.status;
  return !!st?.address?.check.ok && st.link?.proof.status === 'verified';
}
import { mountTabs, popupTabItem } from '../../ui/tabs';
import { renderSiteCard } from '../../ui/site-card';
import { sendToBackground } from '../../messaging';
import { mountPopupUpdate } from '../../ui/update-notice';
import { openChat } from '../../chat/open';
import { chatUrl } from '../../chat/rooms';
import { closeCurrentPage, openExtensionPage, resolveActiveSiteTabId } from '../../platform/compat';
import { ensureBrowserStorage } from '../../platform/storage-compat';

ensureBrowserStorage(browser as unknown as { storage?: Parameters<typeof ensureBrowserStorage>[0] extends { storage?: infer S } ? S : never });
// Standalone Android / mobile tab mode: expand popup to full viewport even when GeckoView reports pointer:fine.
if (new URLSearchParams(location.search).has('siteUrl') || /Android|Mobile/i.test(navigator.userAgent)) {
  document.documentElement.classList.add('full-tab');
}

const $ = (id: string) => document.getElementById(id)!;
const closePopup = () => void closeCurrentPage({ tabs: browser.tabs, closeWindow: () => window.close() });

// each panel's code loads the first time its tab is shown
const loaders: Record<string, () => Promise<unknown>> = {
  burner: async () => {
    const { mountBurnerPanel } = await import('../../ui/burner-panel');
    mountBurnerPanel($('burner'));
  },
};
const loaded = new Map<string, Promise<unknown>>();

function show(name: string) {
  void popupTabItem.setValue(name);
  if (!loaded.has(name)) loaded.set(name, loaders[name]?.().catch((e) => console.error('[XMRadar] popup', name, e)) ?? Promise.resolve());
}

// the build shows on hover; the options page shows it as a line
$('all-settings').title = currentBuild().label;

// a link in a popup would navigate the popup itself, so the options page opens in a tab
for (const el of document.querySelectorAll<HTMLElement>('[data-open]')) {
  el.addEventListener('click', async () => {
    // Open the friendly optional setup choices when the user explicitly clicks tip-badge or footer setup without a full identity yet.
    if (el.id === 'tip-badge' && !(await setupComplete())) {
      await browser.tabs.create({ url: browser.runtime.getURL('/setup.html') });
      return closePopup();
    }
    if (el.id === 'connect-signer' && !(await pubkeyItem.getValue())) {
      await browser.tabs.create({ url: browser.runtime.getURL('/setup.html#private') });
      return closePopup();
    }
    const hash = el.dataset.open ? `#${el.dataset.open}` : '';
    await browser.tabs.create({ url: browser.runtime.getURL(`/options.html${hash}`) });
    closePopup();
  });
}

/** Footer signer line and the tip badge summary, from the last stored check for this key. */
async function renderHeader() {
  const [pubkey, stored] = await Promise.all([pubkeyItem.getValue(), setupStatusLast.getValue()]);
  const npub = pubkey ? npubEncode(pubkey) : null;
  $('signed-in').textContent = npub ? `Signed in as ${npub.slice(0, 10)}…${npub.slice(-4)}` : 'Browsing anonymously';
  $('connect-signer').textContent = npub ? 'Change' : 'Set up';
  $('tip-badge-summary').textContent = badgeSummary(statusFor(stored, pubkey)?.status ?? null);
  if (!(await setupComplete())) {
    $('tip-badge-summary').textContent = npub ? 'Key ready (private) · add badge anytime' : 'Optional · viewing badges works without setup';
  }
}

void renderHeader();

// the chat in the side panel (PLAN-CHATPANEL); the window is read now so the click awaits nothing first
const panelApis = browser as unknown as {
  sidePanel?: { open(o: { windowId: number }): Promise<void> };
  sidebarAction?: { open(): Promise<void> };
};
let windowId: number | undefined;
const chatBtn = $('chat-open') as HTMLButtonElement;
if (browser.windows?.getCurrent) {
  // enabled once the window is known, so Chrome's side panel isn't skipped for a tab by a quick click
  chatBtn.disabled = true;
  void browser.windows
    .getCurrent()
    .then((w) => (windowId = w.id))
    .catch(() => {})
    .finally(() => (chatBtn.disabled = false));
}
$('siwm-open').addEventListener('click', async () => {
  await openExtensionPage(browser.runtime.getURL('/siwm.html'), { windows: browser.windows, tabs: browser.tabs });
  closePopup();
});
$('chat-open').addEventListener('click', () => {
  void openChat({
    sidePanelOpen: panelApis.sidePanel?.open.bind(panelApis.sidePanel),
    sidebarOpen: panelApis.sidebarAction?.open.bind(panelApis.sidebarAction),
    windowId,
    openTab: () => browser.tabs.create({ url: chatUrl('x', true) }),
    close: closePopup,
  });
});

// a newer XMRadar, from the daily check: its release page in a tab
mountPopupUpdate($('update') as HTMLButtonElement, async (url) => {
  await browser.tabs.create({ url });
  closePopup();
});

// the active tab's xmr.club listings, asked by tab id (no URL needed)
void resolveActiveSiteTabId(browser.tabs, location.search, browser.runtime.getURL('/')).then(async (tabId) => {
  if (tabId == null) return;
  renderSiteCard($('this-site'), await sendToBackground({ type: 'site-tab', tabId }).catch(() => null));
});
pubkeyItem.watch(() => void renderHeader());

// unread Xaps (PLAN-XAPINBOX): a line opening the list in Options
const showXaps = (st: InboxState | null) => {
  const n = st?.unread ?? 0;
  $('xap-new').classList.toggle('hidden', !n);
  $('xap-new').querySelector('.row-title')!.textContent = n === 1 ? '1 new Xap' : `${n} new Xaps`;
};
$('xap-new').addEventListener('click', async () => {
  await browser.tabs.create({ url: browser.runtime.getURL('/options.html?xaps#badges') });
  closePopup();
});
void xapInboxItem.getValue().then(showXaps);
xapInboxItem.watch(showXaps);
setupStatusLast.watch(() => void renderHeader());
void popupTabItem.getValue().then((tab) => mountTabs($('tabs'), tab, show));
