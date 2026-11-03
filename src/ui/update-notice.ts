import { sendToBackground } from '../messaging';
import { isNewer, releaseUrl, updateFor } from '../update/check';
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

/** The line under "Check now": what the answer means for this copy. */
export function checkedText(r: { latest: string | null; error?: string }, current: string): string {
  if (r.error || !r.latest) return "Couldn't reach xmradar.app. Try again later.";
  return isNewer(r.latest, current) ? `XMRadar ${r.latest} is out.` : `You have the latest version (${current}).`;
}

/** Options → Updates: the switch, Check now, and the newer version as a link in the section and the sidebar. */
export function mountUpdatePanel(root: ParentNode) {
  const sw = root.querySelector<HTMLInputElement>('#update-check')!;
  const links = [...root.querySelectorAll<HTMLAnchorElement>('[data-update-link]')];
  const marker = root.querySelector<HTMLElement>('#nav-update');
  sw.disabled = true;
  sw.addEventListener('change', () => void patchSettings({ updateCheck: sw.checked }));
  const now = root.querySelector<HTMLButtonElement>('#update-now');
  const status = root.querySelector<HTMLElement>('#update-status');
  now?.addEventListener('click', async () => {
    now.disabled = true;
    if (status) status.textContent = 'Checking…';
    const r = await sendToBackground({ type: 'update-check-now' }).catch((e: Error) => ({ latest: null, error: e.message }));
    now.disabled = false;
    const current = browser.runtime.getManifest().version;
    if (status) status.textContent = checkedText(r, current);
    // with the daily check off, nothing is kept, so the release link is shown (or taken away) from this answer
    if (!sw.checked) {
      const url = isNewer(r.latest, current) ? releaseUrl(r.latest) : null;
      for (const a of links) show(a, r.latest, url);
      if (marker) marker.textContent = url ? 'new' : '';
    }
  });
  watchUpdate((version) => {
    const url = releaseUrl(version);
    for (const a of links) show(a, version, url);
    if (marker) marker.textContent = url ? 'new' : '';
  });
  return settingsItem.getValue().then((s) => {
    sw.checked = updateCheckOn(s);
    sw.disabled = false;
    settingsItem.watch((v) => (sw.checked = updateCheckOn(v)));
  });
}

function show(a: HTMLAnchorElement, version: string | null, url: string | null) {
  a.classList.toggle('hidden', !url);
  a.textContent = `XMRadar ${version} is out: see what's new and download`;
  if (url) a.href = url;
  else a.removeAttribute('href');
}
