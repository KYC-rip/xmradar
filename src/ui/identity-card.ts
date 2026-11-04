import { npubEncode } from 'nostr-tools/nip19';
import { sendToBackground } from '../messaging';
import { pubkeyItem, signerModeItem, type SignerMode } from '../settings';

/**
 * Options → Monero identity → "Your Nostr identity" (PLAN-MANAGEDID): which key signs, and the XMRadar
 * identity's export and delete. The key itself only comes back for an explicit export, shown here once.
 */

const DELETE_CONFIRM_MS = 5_000;
const short = (pk: string) => {
  const n = npubEncode(pk);
  return `${n.slice(0, 12)}…${n.slice(-6)}`;
};

export async function mountIdentityCard(root: HTMLElement) {
  const q = <T extends HTMLElement>(id: string) => root.querySelector<T>(`[data-id="${id}"]`)!;
  const radios = [...root.querySelectorAll<HTMLInputElement>('input[name="signer-mode"]')];
  const status = q('status');
  const exportBox = q('export-box');
  const nsec = q<HTMLInputElement>('nsec');
  const hideKey = () => {
    nsec.value = '';
    exportBox.classList.add('hidden');
  };

  async function render() {
    const st = await sendToBackground({ type: 'identity-state' });
    for (const r of radios) r.checked = r.value === st.mode;
    const usingManaged = !!st.current && st.current === st.managed;
    q('now').textContent = st.current
      ? `Signing as ${short(st.current)}${usingManaged ? ', the XMRadar identity.' : ', from your signer.'}`
      : 'No key yet: connect your signer below, or XMRadar makes an identity the first time it needs one.';
    q('managed').classList.toggle('hidden', !st.managed);
  }

  for (const r of radios)
    r.addEventListener('change', async () => {
      if (!r.checked) return;
      status.textContent = 'Switching…';
      try {
        await sendToBackground({ type: 'identity-mode', mode: r.value as SignerMode });
        status.textContent = '';
      } catch (e) {
        // e.g. "only my signer" without a signer: the choice isn't taken
        status.textContent = r.value === 'signer' ? `No signer answered, so nothing changed: ${(e as Error).message}` : (e as Error).message;
      }
      await render();
    });

  q('export').addEventListener('click', async () => {
    let res: { nsec: string | null };
    try {
      res = await sendToBackground({ type: 'identity-export' });
    } catch (e) {
      status.textContent = `Couldn’t export it: ${(e as Error).message}`;
      return;
    }
    if (!res.nsec) {
      status.textContent = 'There’s no XMRadar identity to export.';
      return;
    }
    nsec.value = res.nsec;
    exportBox.classList.remove('hidden');
    nsec.select();
  });
  q('hide').addEventListener('click', hideKey);
  // the key isn't left on screen when the page goes away
  addEventListener('pagehide', hideKey);

  const del = q<HTMLButtonElement>('delete');
  let armed: ReturnType<typeof setTimeout> | null = null;
  del.addEventListener('click', async () => {
    if (!armed) {
      del.textContent = 'Confirm: delete it for good';
      armed = setTimeout(() => ((armed = null), (del.textContent = 'Delete XMRadar identity')), DELETE_CONFIRM_MS);
      return;
    }
    clearTimeout(armed);
    armed = null;
    del.textContent = 'Delete XMRadar identity';
    hideKey();
    await sendToBackground({ type: 'identity-delete' }).catch((e: Error) => (status.textContent = e.message));
    await render();
  });

  signerModeItem.watch(() => void render());
  pubkeyItem.watch(() => void render());
  await render();
}
