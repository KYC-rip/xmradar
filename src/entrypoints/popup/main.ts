import '../../ui/base.css';
import './style.css';
import { mountTabs, popupTabItem } from '../../ui/tabs';

const $ = (id: string) => document.getElementById(id)!;

// each panel's code loads the first time its tab is shown
const loaders: Record<string, () => Promise<unknown>> = {
  monero: async () => {
    const [{ mountXmrToggles }, { mountIdentityStatus }] = await Promise.all([import('../../ui/xmr-toggles'), import('../../ui/identity-status')]);
    await mountXmrToggles($('xmr-toggles'));
    mountIdentityStatus($('identity-status'));
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

void popupTabItem.getValue().then((tab) => mountTabs($('tabs'), tab, show));
