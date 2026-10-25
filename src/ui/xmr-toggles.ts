import { xmrSettingsItem } from '../settings';
import { part } from './dom';

/** The two Monero-on-X switches, saved on change. The popup is their only home. */
export async function mountXmrToggles(root: HTMLElement) {
  const badges = part<HTMLInputElement>(root, 'xmr', 'badges');
  const discovery = part<HTMLInputElement>(root, 'xmr', 'discovery');
  const show = (x: { badges: boolean; nostrDiscovery: boolean }) => {
    badges.checked = x.badges;
    discovery.checked = x.nostrDiscovery;
  };
  const save = () => xmrSettingsItem.setValue({ badges: badges.checked, nostrDiscovery: discovery.checked });
  badges.addEventListener('change', () => void save());
  discovery.addEventListener('change', () => void save());
  xmrSettingsItem.watch((x) => show(x));
  show(await xmrSettingsItem.getValue());
}
