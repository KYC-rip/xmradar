import { ago, setupStatusLast, statusFor, statusLines } from '../identity/status';
import { sendToBackground } from '../messaging';
import { myHandleItem, pubkeyItem } from '../settings';
import { part, setStatus } from './dom';

/** "xmr.bio: @x verified…" → ["xmr.bio", "@x verified…"]; the relay line goes under "Relays", other lines under "Note". */
export function splitLine(text: string): [string, string] {
  const m = /^([^:]{1,20}): (.*)$/s.exec(text);
  if (m) return [m[1]!, m[2]!];
  return [text.startsWith('Read ') ? 'Relays' : 'Note', text];
}

/** A label/value pair for the status list (a `<dl>`). */
function row(label: string, value: string, kind: string): HTMLElement[] {
  const dt = Object.assign(document.createElement('dt'), { textContent: label });
  const dd = Object.assign(document.createElement('dd'), { textContent: value, className: kind });
  return [dt, dd];
}

/**
 * The read-only identity status ("Where your badge comes from" on the options page). Renders the last stored check at
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
    const last = statusFor(stored, pubkey);
    if (!last) {
      linesEl.replaceChildren(...row('Status', 'Not checked yet.', ''));
      whenEl.textContent = '';
      return;
    }
    linesEl.replaceChildren(...statusLines(last.status, mine?.handle ?? null).flatMap((l) => row(...splitLine(l.text), l.kind)));
    whenEl.textContent = `Checked ${ago(last.at)}`;
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
