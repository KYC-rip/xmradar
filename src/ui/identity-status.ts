import { ago, setupStatusLast, statusLines } from '../identity/status';
import { sendToBackground } from '../messaging';
import { myHandleItem, pubkeyItem } from '../settings';
import { part, setStatus } from './dom';

/**
 * The read-only identity status (options page and popup). Renders the last stored check at
 * once; "Check status" asks the background, which stores the result for every page.
 * Returns `refresh`, which the options page calls after a publish.
 */
export function mountIdentityStatus(root: HTMLElement): { refresh: () => Promise<void> } {
  const linesEl = part(root, 'status', 'lines');
  const whenEl = part(root, 'status', 'when');
  const checkBtn = part<HTMLButtonElement>(root, 'status', 'check');
  const msgEl = part(root, 'status', 'message');
  let busy = false;

  async function render() {
    const [stored, mine, pubkey] = await Promise.all([setupStatusLast.getValue(), myHandleItem.getValue(), pubkeyItem.getValue()]);
    // a check made with another signer key doesn't describe this one
    const last = stored?.status.pubkey === pubkey ? stored : null;
    if (!last) {
      linesEl.replaceChildren(Object.assign(document.createElement('li'), { textContent: 'Not checked yet.' }));
      whenEl.textContent = '';
      return;
    }
    linesEl.replaceChildren(
      ...statusLines(last.status, mine?.handle ?? null).map((l) => Object.assign(document.createElement('li'), { textContent: l.text, className: l.kind })),
    );
    whenEl.textContent = `Checked ${ago(last.at)}.`;
  }

  async function refresh() {
    if (busy) return;
    busy = true;
    checkBtn.disabled = true;
    setStatus(msgEl, 'Checking Nostr relays and xmr.bio (up to 15 s)…');
    try {
      await sendToBackground({ type: 'setup-status' });
      setStatus(msgEl, '');
    } catch (e) {
      setStatus(msgEl, (e as Error).message, 'error');
    } finally {
      busy = false;
      checkBtn.disabled = false;
      await render();
    }
  }

  checkBtn.addEventListener('click', () => void refresh());
  setupStatusLast.watch(() => void render());
  myHandleItem.watch(() => void render());
  pubkeyItem.watch(() => void render());
  void render();
  return { refresh };
}
