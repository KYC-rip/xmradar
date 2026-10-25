import { burnerInboxItem, type BurnerInbox } from '../../burner/service';
import { BURNER_CREATE_PORT, sendToBackground, type BurnerCreateEvent } from '../../messaging';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const emailEl = $('burner-email');
const copyBtn = $<HTMLButtonElement>('burner-copy');
const metaEl = $('burner-meta');
const createBtn = $<HTMLButtonElement>('burner-create');
const burnBtn = $<HTMLButtonElement>('burner-burn');
const forgetBtn = $<HTMLButtonElement>('burner-forget');
const importBox = $<HTMLDetailsElement>('burner-import-box');
const importEmail = $<HTMLInputElement>('burner-import-email');
const importToken = $<HTMLInputElement>('burner-import-token');
const importBtn = $<HTMLButtonElement>('burner-import');
const statusEl = $('burner-status');

let current: BurnerInbox | null = null;
let busy = false;

function setStatus(text: string, kind: 'ok' | 'error' | '' = '') {
  statusEl.textContent = text;
  statusEl.className = kind;
}

const minutesLeft = (t: number) => Math.max(0, Math.round((t - Date.now()) / 60_000));

function render() {
  const live = current && current.expiresAt > Date.now() ? current : null;
  emailEl.textContent = live?.email ?? 'none';
  copyBtn.classList.toggle('hidden', !live);
  burnBtn.classList.toggle('hidden', live?.source !== 'free');
  forgetBtn.classList.toggle('hidden', live?.source !== 'imported');
  createBtn.classList.toggle('hidden', !!live);
  importBox.classList.toggle('hidden', !!live);
  if (!live) metaEl.textContent = '';
  else {
    const left = minutesLeft(live.expiresAt);
    const when = left < 120 ? `${left} min` : `${Math.round(left / 60)} h`;
    metaEl.textContent = `${live.source === 'free' ? 'Free' : `Imported, ${live.tier}`} · expires in ${when}`;
  }
}

async function guard(label: string, fn: () => Promise<void>) {
  if (busy) return;
  busy = true;
  setStatus(label);
  try {
    await fn();
  } catch (e) {
    setStatus((e as Error).message, 'error');
  } finally {
    busy = false;
  }
}

function create(): Promise<void> {
  return new Promise((resolve, reject) => {
    const port = browser.runtime.connect({ name: BURNER_CREATE_PORT });
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      port.disconnect();
      if (err) reject(err);
      else resolve();
    };
    port.onMessage.addListener((m: BurnerCreateEvent) => {
      if (m.type === 'progress') setStatus(`Getting an address (proof of work, ${(m.hashes / 1e6).toFixed(1)}M hashes)…`);
      else if (m.type === 'done') {
        setStatus(`Ready: ${m.email}`, 'ok');
        finish();
      } else finish(new Error(m.message));
    });
    port.onDisconnect.addListener(() => finish(new Error('The extension stopped while getting an address. Try again.')));
  });
}

export async function initBurner() {
  current = await burnerInboxItem.getValue();
  render();
  burnerInboxItem.watch((v) => {
    current = v;
    render();
  });
  // the expiry countdown
  setInterval(render, 30_000);

  createBtn.addEventListener('click', () => guard('Getting an address…', create));
  copyBtn.addEventListener('click', async () => {
    if (!current) return;
    await navigator.clipboard.writeText(current.email);
    setStatus('Address copied', 'ok');
  });
  burnBtn.addEventListener('click', () =>
    guard('Burning…', async () => {
      if (!confirm('Burn this address? Its mail is deleted on GhostMail and it stops working.')) return setStatus('');
      await sendToBackground({ type: 'burner-burn' });
      setStatus('Burned', 'ok');
    }),
  );
  forgetBtn.addEventListener('click', () =>
    guard('Forgetting…', async () => {
      await sendToBackground({ type: 'burner-forget' });
      setStatus('Removed from XMRadar. The inbox is still on kyc.rip/mail.', 'ok');
    }),
  );
  importBtn.addEventListener('click', () =>
    guard('Checking the inbox…', async () => {
      try {
        const { email } = await sendToBackground({ type: 'burner-import', email: importEmail.value, token: importToken.value });
        importEmail.value = '';
        setStatus(`Imported ${email}`, 'ok');
      } finally {
        // the token stays in the background only
        importToken.value = '';
      }
    }),
  );
}
