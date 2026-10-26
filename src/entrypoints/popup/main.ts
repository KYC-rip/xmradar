import '../../ui/base.css';
import './style.css';
import { npubEncode } from 'nostr-tools/nip19';
import { badgeSummary, setupStatusLast, statusFor } from '../../identity/status';
import { pubkeyItem } from '../../settings';
import { mountTabs, popupTabItem } from '../../ui/tabs';

const $ = (id: string) => document.getElementById(id)!;

// each panel's code loads the first time its tab is shown
const loaders: Record<string, () => Promise<unknown>> = {
  monero: async () => {
    const { mountXmrToggles } = await import('../../ui/xmr-toggles');
    await mountXmrToggles($('xmr-toggles'));
  },
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

// a link in a popup would navigate the popup itself, so the options page opens in a tab
for (const el of document.querySelectorAll<HTMLElement>('[data-open]')) {
  el.addEventListener('click', async () => {
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
}

void renderHeader();
pubkeyItem.watch(() => void renderHeader());
setupStatusLast.watch(() => void renderHeader());
void popupTabItem.getValue().then((tab) => mountTabs($('tabs'), tab, show));
