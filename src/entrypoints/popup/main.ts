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
import { CHAT_ORIGIN } from '../../chat/rooms';

const $ = (id: string) => document.getElementById(id)!;

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
    // the tip badge before setup is complete opens the setup page (PLAN-XOREACH), not Options
    if (el.id === 'tip-badge' && !(await setupComplete())) {
      await browser.tabs.create({ url: browser.runtime.getURL('/setup.html') });
      return window.close();
    }
    const hash = el.dataset.open ? `#${el.dataset.open}` : '';
    await browser.tabs.create({ url: browser.runtime.getURL(`/options.html${hash}`) });
    window.close();
  });
}

/** Footer signer line and the tip badge summary, from the last stored check for this key. */
async function renderHeader() {
  const [pubkey, stored] = await Promise.all([pubkeyItem.getValue(), setupStatusLast.getValue()]);
  const npub = pubkey ? npubEncode(pubkey) : null;
  $('signed-in').textContent = npub ? `Signed in as ${npub.slice(0, 10)}…${npub.slice(-4)}` : 'No signer yet';
  $('connect-signer').classList.toggle('hidden', !!npub);
  $('tip-badge-summary').textContent = badgeSummary(statusFor(stored, pubkey)?.status ?? null);
  if (!(await setupComplete())) $('tip-badge-summary').textContent = 'Not set up yet: about a minute';
}

void renderHeader();

// the chat in the side panel (PLAN-CHATPANEL); the window is read now so the click awaits nothing first
const panelApis = browser as unknown as {
  sidePanel?: { open(o: { windowId: number }): Promise<void> };
  sidebarAction?: { open(): Promise<void> };
};
let windowId: number | undefined;
// enabled once the window is known, so Chrome's side panel isn't skipped for a tab by a quick click
($('chat-open') as HTMLButtonElement).disabled = true;
void browser.windows
  .getCurrent()
  .then((w) => (windowId = w.id))
  .finally(() => (($('chat-open') as HTMLButtonElement).disabled = false));
$('siwm-open').addEventListener('click', async () => {
  await browser.windows.create({ url: browser.runtime.getURL('/siwm.html'), type: 'popup', width: 520, height: 720 });
  window.close();
});
$('chat-open').addEventListener('click', () => {
  void openChat({
    sidePanelOpen: panelApis.sidePanel?.open.bind(panelApis.sidePanel),
    sidebarOpen: panelApis.sidebarAction?.open.bind(panelApis.sidebarAction),
    windowId,
    openTab: () => browser.tabs.create({ url: `${CHAT_ORIGIN}/` }),
    close: () => window.close(),
  });
});

// a newer XMRadar, from the daily check: its release page in a tab
mountPopupUpdate($('update') as HTMLButtonElement, async (url) => {
  await browser.tabs.create({ url });
  window.close();
});

// the active tab's xmr.club listings, asked by tab id (no URL needed)
void browser.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
  if (tab?.id == null) return;
  renderSiteCard($('this-site'), await sendToBackground({ type: 'site-tab', tabId: tab.id }).catch(() => null));
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
  window.close();
});
void xapInboxItem.getValue().then(showXaps);
xapInboxItem.watch(showXaps);
setupStatusLast.watch(() => void renderHeader());
void popupTabItem.getValue().then((tab) => mountTabs($('tabs'), tab, show));
