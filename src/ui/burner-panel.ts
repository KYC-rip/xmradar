import { burnerCreatingItem, burnerInboxItem, burnerLastErrorItem, type BurnerInbox } from '../burner/service';
import { isCreating, shownError, type CreatingState, type LastError } from '../burner/tracked';
import { BURNER_CREATE_PORT, sendToBackground, type BurnerCreateEvent } from '../messaging';
import { optionalPart, part, setStatus } from './dom';

export const BURN_CONFIRM_MS = 5_000;

/**
 * The burner email panel (options page and popup). Children are found by `data-burner`;
 * the import form is optional (the popup has none). Burn is a two-step button because
 * Firefox popups have no `window.confirm`.
 */
export function mountBurnerPanel(root: HTMLElement) {
  const $ = <T extends HTMLElement>(name: string) => part<T>(root, 'burner', name);
  const emailEl = $('email');
  const copyBtn = $<HTMLButtonElement>('copy');
  const metaEl = $('meta');
  const createBtn = $<HTMLButtonElement>('create');
  const burnBtn = $<HTMLButtonElement>('burn');
  const forgetBtn = $<HTMLButtonElement>('forget');
  const statusEl = $('status');
  const importBox = optionalPart<HTMLDetailsElement>(root, 'burner', 'import-box');
  const importEmail = optionalPart<HTMLInputElement>(root, 'burner', 'import-email');
  const importToken = optionalPart<HTMLInputElement>(root, 'burner', 'import-token');
  const importBtn = optionalPart<HTMLButtonElement>(root, 'burner', 'import');
  if (importBox && !(importEmail && importToken && importBtn)) throw new Error('burner panel: incomplete import form');

  let current: BurnerInbox | null = null;
  let creating: CreatingState | null = null;
  let lastError: LastError | null = null;
  let busy = false;
  let burnArmed: ReturnType<typeof setTimeout> | null = null;

  const minutesLeft = (t: number) => Math.max(0, Math.round((t - Date.now()) / 60_000));

  function render() {
    const live = current && current.expiresAt > Date.now() ? current : null;
    const inFlight = isCreating(creating);
    emailEl.textContent = live?.email ?? 'none';
    copyBtn.classList.toggle('hidden', !live);
    burnBtn.classList.toggle('hidden', live?.source !== 'free');
    forgetBtn.classList.toggle('hidden', live?.source !== 'imported');
    createBtn.classList.toggle('hidden', !!live);
    createBtn.disabled = inFlight;
    importBox?.classList.toggle('hidden', !!live);
    if (!live) metaEl.textContent = '';
    else {
      const left = minutesLeft(live.expiresAt);
      const when = left < 120 ? `${left} min` : `${Math.round(left / 60)} h`;
      metaEl.textContent = `${live.source === 'free' ? 'Free' : `Imported, ${live.tier}`} · expires in ${when}`;
    }
    // what another page (or a closed popup) started: shown unless this page is mid-action
    if (!busy) {
      const err = shownError(lastError);
      if (inFlight) setStatus(statusEl, 'Getting an address…');
      else if (err && !live) setStatus(statusEl, `Last attempt failed: ${err}`, 'error');
    }
  }

  async function guard(label: string, fn: () => Promise<void>) {
    if (busy) return;
    busy = true;
    setStatus(statusEl, label);
    try {
      await fn();
    } catch (e) {
      setStatus(statusEl, (e as Error).message, 'error');
    } finally {
      busy = false;
    }
  }

  function create(): Promise<void> {
    return new Promise((resolve, reject) => {
      const port = browser.runtime.connect({ name: BURNER_CREATE_PORT });
      let settled = false;
      // the proof of work gives up at 45 s; past this the background has stopped answering
      const timer = setTimeout(() => finish(new Error('Getting an address timed out. Try again.')), 90_000);
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        port.disconnect();
        if (err) reject(err);
        else resolve();
      };
      port.onMessage.addListener((m: BurnerCreateEvent) => {
        if (m.type === 'progress') setStatus(statusEl, `Getting an address (proof of work, ${(m.hashes / 1e6).toFixed(1)}M hashes)…`);
        else if (m.type === 'done') {
          setStatus(statusEl, `Ready: ${m.email}`, 'ok');
          finish();
        } else finish(new Error(m.message));
      });
      port.onDisconnect.addListener(() => finish(new Error('The extension stopped while getting an address. Try again.')));
    });
  }

  function disarmBurn() {
    if (burnArmed) clearTimeout(burnArmed);
    burnArmed = null;
    burnBtn.textContent = 'Burn now';
    burnBtn.classList.remove('primary');
  }

  createBtn.addEventListener('click', () => guard('Getting an address…', create));
  copyBtn.addEventListener('click', async () => {
    if (!current) return;
    await navigator.clipboard.writeText(current.email);
    setStatus(statusEl, 'Address copied', 'ok');
  });
  burnBtn.addEventListener('click', () => {
    if (!burnArmed) {
      burnBtn.textContent = 'Confirm burn';
      burnBtn.classList.add('primary');
      setStatus(statusEl, 'Click again to delete this address and its mail on GhostMail.');
      burnArmed = setTimeout(() => {
        disarmBurn();
        setStatus(statusEl, '');
      }, BURN_CONFIRM_MS);
      return;
    }
    disarmBurn();
    void guard('Burning…', async () => {
      const { burned } = await sendToBackground({ type: 'burner-burn' });
      setStatus(statusEl, burned ? 'Burned' : 'Removed here. GhostMail keeps the inbox until it expires.', 'ok');
    });
  });
  forgetBtn.addEventListener('click', () =>
    guard('Forgetting…', async () => {
      await sendToBackground({ type: 'burner-forget' });
      setStatus(statusEl, 'Removed from XMRadar. The inbox is still on kyc.rip/mail.', 'ok');
    }),
  );
  if (importBtn && importEmail && importToken) {
    importBtn.addEventListener('click', () =>
      guard('Checking the inbox…', async () => {
        try {
          const { email } = await sendToBackground({ type: 'burner-import', email: importEmail.value, token: importToken.value });
          importEmail.value = '';
          setStatus(statusEl, `Imported ${email}`, 'ok');
        } finally {
          // the token stays in the background only
          importToken.value = '';
        }
      }),
    );
  }

  burnerInboxItem.watch((v) => {
    current = v;
    render();
  });
  burnerCreatingItem.watch((v) => {
    creating = v;
    render();
  });
  burnerLastErrorItem.watch((v) => {
    lastError = v;
    render();
  });
  // the expiry countdown, and a stale "creating" mark running out
  const tick = setInterval(render, 30_000);

  const ready = Promise.all([burnerInboxItem.getValue(), burnerCreatingItem.getValue(), burnerLastErrorItem.getValue()]).then(([inbox, c, e]) => {
    current = inbox;
    creating = c;
    lastError = e;
    render();
  });
  return { ready, stop: () => clearInterval(tick) };
}
