import { patchXmrSettings, xmrSettingsItem, type XmrSettings } from '../settings';
import { part } from './dom';

/**
 * The badge switches (options page, Badges on X), saved on change. `data-xmr` names the setting each one drives;
 * settings without a switch on the page (Nostr clients and tip receipts until R2/R3) are kept as they are.
 */
export async function mountXmrToggles(root: HTMLElement) {
  const badges = part<HTMLInputElement>(root, 'xmr', 'badges');
  const discovery = part<HTMLInputElement>(root, 'xmr', 'discovery');
  const show = (x: XmrSettings) => {
    badges.checked = x.badgesX;
    discovery.checked = x.nostrDiscovery;
  };
  // each switch saves only its own field; a failed save puts the switches back to what's stored
  const save = (patch: Partial<XmrSettings>) =>
    patchXmrSettings(patch).catch(async (e) => {
      console.error('[XMRadar] settings', e);
      show(await xmrSettingsItem.getValue());
    });
  badges.addEventListener('change', () => void save({ badgesX: badges.checked }));
  discovery.addEventListener('change', () => void save({ nostrDiscovery: discovery.checked }));
  xmrSettingsItem.watch((x) => show(x));
  show(await xmrSettingsItem.getValue());
}
