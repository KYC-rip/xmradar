import type { DirectoryStatus } from '../identity/directory';
import { directoryStatusItem, patchXmrSettings, xmrSettingsItem, type XmrSettings } from '../settings';
import { optionalPart, part } from './dom';

/**
 * The badge switches (options page, Badges on X), saved on change. `data-xmr` names the setting each one drives;
 * settings without a switch on the page (Nostr clients until R2) are kept as they are.
 */
/** The xmr.bio directory line under the badges switch. */
export function directoryText(st: DirectoryStatus | null, badges: boolean): string {
  if (!badges || !st) return '';
  const held = st.count != null && st.generatedAt ? `${st.count.toLocaleString()} profiles, built ${new Date(st.generatedAt).toLocaleString()}` : '';
  const why = st.message ?? 'unknown error';
  switch (st.state) {
    case 'ok':
      return held ? `xmr.bio directory: ${held}${st.stale ? ' (xmr.bio says it may be out of date)' : ''}` : '';
    case 'not-live':
      return held ? `xmr.bio directory: ${held}; the last check found none published` : 'xmr.bio directory: not published yet';
    case 'trust':
      return `xmr.bio directory refused (${why}). ${held ? `Still using the earlier one: ${held}.` : 'No xmr.bio badges until a good one arrives.'}`;
    default:
      return held ? `xmr.bio directory: ${held}; the last update failed (${why})` : `xmr.bio directory: couldn't download it (${why})`;
  }
}

export async function mountXmrToggles(root: HTMLElement) {
  const badges = part<HTMLInputElement>(root, 'xmr', 'badges');
  const discovery = part<HTMLInputElement>(root, 'xmr', 'discovery');
  const receipts = part<HTMLInputElement>(root, 'xmr', 'receipts');
  // only on the options page; the popup's switches have no status line
  const dirLine = optionalPart<HTMLElement>(root, 'xmr', 'directory');
  const claims = optionalPart<HTMLInputElement>(root, 'xmr', 'claims');
  const showDirectory = async () => {
    if (dirLine) dirLine.textContent = directoryText(await directoryStatusItem.getValue(), (await xmrSettingsItem.getValue()).badgesX);
  };
  const show = (x: XmrSettings) => {
    void showDirectory();
    badges.checked = x.badgesX;
    if (claims) {
      // read only while badges are on; its own choice is kept for when they come back
      claims.checked = x.xClaims !== false;
      claims.disabled = !x.badgesX;
    }
    discovery.checked = x.nostrDiscovery;
    receipts.checked = x.tipReceipts;
  };
  // each switch saves only its own field; a failed save puts the switches back to what's stored
  const save = (patch: Partial<XmrSettings>) =>
    patchXmrSettings(patch).catch(async (e) => {
      console.error('[XMRadar] settings', e);
      show(await xmrSettingsItem.getValue());
    });
  badges.addEventListener('change', () => void save({ badgesX: badges.checked }));
  claims?.addEventListener('change', () => void save({ xClaims: claims.checked }));
  discovery.addEventListener('change', () => void save({ nostrDiscovery: discovery.checked }));
  receipts.addEventListener('change', () => void save({ tipReceipts: receipts.checked }));
  xmrSettingsItem.watch((x) => show(x));
  if (dirLine) directoryStatusItem.watch(() => void showDirectory());
  show(await xmrSettingsItem.getValue());
}
