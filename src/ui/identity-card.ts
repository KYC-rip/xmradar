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
  const importBox = q('import-box');
  const importInput = q<HTMLInputElement>('import-nsec');
  const importConfirmBox = q('import-confirm-box');
  const importConfirmText = q('import-confirm-text');
  let pendingImportSecret = '';

  const hideKey = () => {
    nsec.value = '';
    exportBox.classList.add('hidden');
  };
  const clearImport = (closeBox = false) => {
    importInput.value = '';
    pendingImportSecret = '';
    importConfirmText.textContent = '';
    importConfirmBox.classList.add('hidden');
    if (closeBox) importBox.classList.add('hidden');
  };
  const clearSecrets = () => {
    hideKey();
    clearImport(true);
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
  // clear secrets whenever the page hides, blurs, or backgrounds (Android GeckoView tabs may not fire pagehide)
  addEventListener('pagehide', clearSecrets);
  addEventListener('beforeunload', clearSecrets);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearSecrets();
  });

  q('import-open').addEventListener('click', () => {
    const opening = importBox.classList.contains('hidden');
    clearImport(!opening);
    if (opening) {
      importBox.classList.remove('hidden');
      importInput.focus();
    }
  });
  q('import-cancel').addEventListener('click', () => clearImport(true));
  q('import-confirm-cancel').addEventListener('click', () => clearImport(true));

  const submitImport = async (secret: string, confirmOverwrite: boolean) => {
    status.textContent = 'Importing…';
    try {
      const res = await sendToBackground({ type: 'identity-import', nsec: secret, confirmOverwrite });
      if ('needsConfirm' in res) {
        pendingImportSecret = secret;
        importInput.value = '';
        importConfirmText.textContent = `This will replace your current stored key (${short(res.existingPubkey)}). Export it above first if you want to keep it.`;
        importConfirmBox.classList.remove('hidden');
        status.textContent = '';
        return;
      }
      clearImport(true);
      status.textContent = res.unchanged
        ? `Already using ${short(res.pubkey)}.`
        : `Now signing as ${short(res.pubkey)}.`;
      await render();
    } catch (e) {
      clearImport(false);
      status.textContent = (e as Error).message;
    }
  };

  q('import-save').addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    const raw = importInput.value;
    importInput.value = '';
    void submitImport(raw, false);
  });
  q('import-confirm').addEventListener('click', (e) => {
    if (!e.isTrusted || !pendingImportSecret) return;
    const raw = pendingImportSecret;
    pendingImportSecret = '';
    void submitImport(raw, true);
  });

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
