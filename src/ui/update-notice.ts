import { releaseUrl, updateFor } from '../update/check';
import { patchSettings, settingsItem, updateCheckOn, updateStateItem } from '../settings';

/** The newer version the daily check found, while the check is on; null otherwise (PLAN-UPDATECHECK). */
export async function heldUpdate(current = browser.runtime.getManifest().version): Promise<string | null> {
  const [s, state] = await Promise.all([settingsItem.getValue(), updateStateItem.getValue()]);
  return updateCheckOn(s) ? updateFor(state, current) : null;
}

/** Calls `show` with the newer version (or null) now and whenever the check's answer or switch changes. */
export function watchUpdate(show: (version: string | null) => void) {
  const render = () => void heldUpdate().then(show);
  render();
  updateStateItem.watch(render);
  settingsItem.watch(render);
}

/**
 * The popup's line: "XMRadar 0.6.1 is out" opening the release page in a tab (a link would navigate
 * the popup itself). The address comes from the checked version only.
 */
export function mountPopupUpdate(button: HTMLButtonElement, open: (url: string) => unknown) {
  let url: string | null = null;
  button.addEventListener('click', () => url && open(url));
  watchUpdate((version) => {
    url = releaseUrl(version);
    button.classList.toggle('hidden', !url);
    button.querySelector('.row-title')!.textContent = `XMRadar ${version} is out`;
  });
}

/** Options → Updates: the switch, and the newer version as a link in the section and the sidebar. */
export function mountUpdatePanel(root: ParentNode) {
  const sw = root.querySelector<HTMLInputElement>('#update-check')!;
  const links = [...root.querySelectorAll<HTMLAnchorElement>('[data-update-link]')];
  const marker = root.querySelector<HTMLElement>('#nav-update');
  sw.disabled = true;
  sw.addEventListener('change', () => void patchSettings({ updateCheck: sw.checked }));
  watchUpdate((version) => {
    const url = releaseUrl(version);
    for (const a of links) {
      a.classList.toggle('hidden', !url);
      a.textContent = `XMRadar ${version} is out: see what's new and download`;
      if (url) a.href = url;
      else a.removeAttribute('href');
    }
    if (marker) marker.textContent = url ? 'new' : '';
  });
  return settingsItem.getValue().then((s) => {
    sw.checked = updateCheckOn(s);
    sw.disabled = false;
    settingsItem.watch((v) => (sw.checked = updateCheckOn(v)));
  });
}
