import { badgeLook, mountBadge, type BadgeIcon } from '../identity/badge-look';
import { patchXmrSettings, xmrSettingsItem, type XmrSettings } from '../settings';
import { part } from './dom';

/** The options page's "Badge look" card (Badges on X): icon radios with live previews and the XMR label switch. */
export async function mountBadgeLook(root: HTMLElement) {
  const radios = [...root.querySelectorAll<HTMLInputElement>('input[name="badge-icon"]')];
  const label = part<HTMLInputElement>(root, 'look', 'label');
  const show = (x: XmrSettings) => {
    const look = badgeLook(x);
    for (const r of radios) r.checked = r.value === look.icon;
    label.checked = look.label;
    label.disabled = look.icon === 'none';
    // a shadow root can't be re-attached, so each redraw gets a fresh host
    for (const slot of root.querySelectorAll<HTMLElement>('[data-preview]')) {
      const host = document.createElement('span');
      mountBadge(host, badgeLook({ badgeIcon: slot.dataset.preview, badgeLabel: look.label }), null);
      slot.replaceChildren(host);
    }
  };
  const save = (patch: Partial<XmrSettings>) =>
    patchXmrSettings(patch).catch(async (e) => {
      console.error('[XMRadar] settings', e);
      show(await xmrSettingsItem.getValue());
    });
  for (const r of radios) r.addEventListener('change', () => r.checked && void save({ badgeIcon: r.value as BadgeIcon }));
  label.addEventListener('change', () => void save({ badgeLabel: label.checked }));
  xmrSettingsItem.watch((x) => show(x));
  show(await xmrSettingsItem.getValue());
}
