import { npubEncode } from 'nostr-tools/nip19';
import { HANDLE_RE, normalizeHandle } from '../../identity/envelope';
import { tagDiff } from '../../identity/setup';
import { setupStatusLast, statusFor } from '../../identity/status';
import { doneCount, identitySteps, type StepKey } from '../../identity/steps';
import { sendToBackground, type PreparedSetup, type RelayResult, type SetupRequest } from '../../messaging';
import { myHandleItem, pubkeyItem } from '../../settings';
import { setStatus as setStatusOf } from '../../ui/dom';
import { mountIdentityStatus } from '../../ui/identity-status';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const handleEl = $<HTMLInputElement>('id-handle');
const addressEl = $<HTMLInputElement>('id-address');
const tweetUrlEl = $<HTMLInputElement>('id-tweet-url');
const confirmBox = $('id-confirm');
const summaryEl = $('id-summary');
const diffEl = $('id-diff');
const isMeEl = $<HTMLInputElement>('id-is-me');
const confirmNpubEl = $('id-confirm-npub');
const partialRow = $('id-partial-row');
const partialEl = $<HTMLInputElement>('id-partial');
const signBtn = $<HTMLButtonElement>('id-sign');
const outcomeEl = $('id-outcome');
const resultsSummaryEl = $('id-results-summary');
const resultsEl = $('id-results');
const retryBtn = $<HTMLButtonElement>('id-retry');
const statusEl = $('id-status');
const countEl = $('nav-identity-count');

const KIND_NAMES: Record<number, string> = { 10133: 'payment address list', 10011: 'linked accounts list' };
const stepEl = (key: StepKey) => document.querySelector<HTMLElement>(`[data-step="${key}"]`)!;
const STATE_NAMES = { done: 'done', current: 'next', todo: 'to do' } as const;

let prepared: PreparedSetup | null = null;
const status = mountIdentityStatus($('identity-status'));
let busy = false;
/** done steps the user reopened with Change/Replace */
const editing = new Set<StepKey>();

function setStatus(text: string, kind: 'ok' | 'error' | '' = '') {
  setStatusOf(statusEl, text, kind);
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

/** Asks the signer for the pubkey in a temporary tab; used by the Posting section too. */
export async function testSigner(out: HTMLElement) {
  setStatusOf(out, 'Opening a temporary tab for your signer…');
  try {
    await sendToBackground({ type: 'test-signer' });
    setStatusOf(out, 'Signer connected.', 'ok');
  } catch (e) {
    setStatusOf(out, (e as Error).message, 'error');
  }
}

/** The stepper from the signer key, the confirmed handle and the last status check for this key. */
async function renderSteps() {
  const [pubkey, mine, stored] = await Promise.all([pubkeyItem.getValue(), myHandleItem.getValue(), setupStatusLast.getValue()]);
  const steps = identitySteps({ npub: pubkey ? npubEncode(pubkey) : null, handle: mine?.handle ?? null, status: statusFor(stored, pubkey)?.status ?? null });
  for (const [n, s] of steps.entries()) {
    const el = stepEl(s.key);
    // the ✓ is drawn by CSS, so the state is spelled out for screen readers
    const marker = el.querySelector('.marker')!;
    marker.setAttribute('role', 'img');
    marker.setAttribute('aria-label', `Step ${n + 1}, ${STATE_NAMES[s.state]}`);
    if (s.state === 'current') el.setAttribute('aria-current', 'step');
    else el.removeAttribute('aria-current');
    if (s.state !== 'done') editing.delete(s.key);
    el.dataset.state = s.state;
    el.toggleAttribute('data-open', s.state === 'current' || editing.has(s.key));
    el.toggleAttribute('data-unchecked', !!s.unchecked);
    const value = el.querySelector('[data-value]');
    if (value) value.textContent = s.value ?? '';
    const warn = el.querySelector('[data-warn]');
    if (warn) warn.textContent = s.warning ?? '';
  }
  const done = doneCount(steps);
  countEl.textContent = `${done}/4`;
  countEl.classList.toggle('all', done === 4);
}

/** The review box opens inside the step that asked for it. */
function showDiff(p: PreparedSetup, step: StepKey) {
  prepared = p;
  summaryEl.replaceChildren();
  summaryEl.append(`New ${KIND_NAMES[p.kind] ?? `kind ${p.kind}`} (kind ${p.kind}), published to ${p.relays.length} relays.`);
  if (p.unreadable.length) {
    const warn = document.createElement('p');
    warn.className = 'warn';
    warn.textContent = `Couldn't read ${p.unreadable.join(', ')}. If your list there has tags the others don't, this change won't include them, and they may be lost once relays sync. Cancel and try again, or confirm below.`;
    summaryEl.append(warn);
  }
  if (!p.before) summaryEl.append(' You have no list of this kind yet.');
  diffEl.replaceChildren(
    ...tagDiff(p.before, p.after).map((l) => {
      const line = document.createElement('div');
      line.className = l.op === '+' ? 'add' : l.op === '-' ? 'del' : '';
      line.textContent = `${l.op} ${JSON.stringify(l.tag)}`;
      return line;
    }),
  );
  if (!p.after.length) diffEl.append('(the list will be empty)');
  confirmNpubEl.textContent = npubEncode(p.pubkey);
  isMeEl.checked = false;
  partialEl.checked = false;
  partialRow.classList.toggle('hidden', !p.unreadable.length);
  updateSign();
  outcomeEl.classList.add('hidden');
  stepEl(step).querySelector('.step-main')!.append(confirmBox, outcomeEl, statusEl);
  confirmBox.classList.remove('hidden');
  confirmBox.scrollIntoView({ block: 'nearest' });
}

function updateSign() {
  signBtn.disabled = !prepared || !isMeEl.checked || (prepared.unreadable.length > 0 && !partialEl.checked);
}

/** Drop the reviewed change here and in the background, so it can't be signed later by mistake. */
function hideDiff() {
  if (prepared) void sendToBackground({ type: 'setup-cancel' }).catch(() => {});
  prepared = null;
  confirmBox.classList.add('hidden');
}

function showResults(results: RelayResult[]) {
  resultsEl.replaceChildren(
    ...results.map((r) => {
      const li = document.createElement('li');
      li.className = r.ok ? 'ok' : 'error';
      li.textContent = `${r.relay}: ${r.ok ? 'ok' : r.message}`;
      return li;
    }),
  );
  const failed = results.filter((r) => !r.ok).length;
  resultsSummaryEl.textContent = `Published to ${results.length - failed} of ${results.length} relays.`;
  outcomeEl.classList.remove('hidden');
  retryBtn.classList.toggle('hidden', failed === 0);
  return failed;
}

const prepare = (action: SetupRequest, step: StepKey) =>
  guard('Reading your current list from relays…', async () => {
    showDiff(await sendToBackground({ type: 'setup-prepare', action }), step);
    setStatus('Check the change, then sign it.');
  });

$('id-handle-save').addEventListener('click', async () => {
  const handle = normalizeHandle(handleEl.value);
  if (!HANDLE_RE.test(handle)) return setStatus('Enter your X handle (letters, digits and _ only).', 'error');
  hideDiff();
  const prev = await myHandleItem.getValue();
  // a different handle has to be proven again
  await myHandleItem.setValue({ handle, proven: prev?.handle === handle && prev.proven });
  editing.delete('handle');
  handleEl.value = handle;
  setStatus(`Saved @${handle}.`, 'ok');
  await renderSteps();
});

$('id-address-publish').addEventListener('click', () => void prepare({ type: 'add-address', address: addressEl.value }, 'address'));
$('id-address-remove').addEventListener('click', () => void prepare({ type: 'remove-address' }, 'address'));
$('id-link').addEventListener('click', () => void prepare({ type: 'link-x', tweetUrl: tweetUrlEl.value }, 'link'));
$('id-unlink').addEventListener('click', () => void prepare({ type: 'unlink-x' }, 'link'));

$('id-tweet').addEventListener('click', async () => {
  const pk = await pubkeyItem.getValue();
  if (!pk) return setStatus('Connect your signer first (step 1).', 'error');
  const text = `Verifying that I control the following Nostr public key: ${npubEncode(pk)}`;
  window.open(`https://x.com/intent/post?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
});

for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-act]')) {
  const step = btn.closest<HTMLElement>('[data-step]')!.dataset.step as StepKey;
  btn.addEventListener('click', () => {
    if (btn.dataset.act === 'test-signer') void testSigner(statusEl);
    else if (btn.dataset.act === 'check') void status.refresh();
    else {
      editing.add(step);
      // the Change button hides once the step opens, so focus moves into the step
      void renderSteps().then(() => stepEl(step).querySelector<HTMLElement>('.step-body input, .step-body button')?.focus());
    }
  });
}

isMeEl.addEventListener('change', updateSign);
partialEl.addEventListener('change', updateSign);
$('id-cancel').addEventListener('click', () => {
  hideDiff();
  setStatus('Cancelled. Nothing was published.');
});

signBtn.addEventListener('click', () => {
  const p = prepared;
  if (!p || signBtn.disabled) return;
  void guard('Waiting for your signer (approve it in the tab that opened)…', async () => {
    signBtn.disabled = true;
    try {
      const { results } = await sendToBackground({ type: 'setup-sign', id: p.id });
      confirmBox.classList.add('hidden');
      const failed = showResults(results);
      const ok = failed < results.length;
      setStatus(!ok ? 'No relay accepted the event.' : failed ? 'Published, but some relays failed.' : 'Published.', ok ? 'ok' : 'error');
      if (ok) {
        editing.clear();
        void status.refresh();
      }
    } finally {
      updateSign();
    }
  });
});

retryBtn.addEventListener('click', () => {
  const p = prepared;
  if (!p) return;
  void guard('Retrying failed relays…', async () => {
    const { results } = await sendToBackground({ type: 'setup-retry', id: p.id });
    const failed = showResults(results);
    setStatus(failed ? 'Some relays still failed.' : 'Published.', failed ? 'error' : 'ok');
    if (failed < results.length) {
      editing.clear();
      void status.refresh();
    }
  });
});

export async function initIdentity() {
  const mine = await myHandleItem.getValue();
  if (mine) handleEl.value = mine.handle;
  pubkeyItem.watch(() => void renderSteps());
  myHandleItem.watch(() => void renderSteps());
  setupStatusLast.watch(() => void renderSteps());
  await renderSteps();
}
