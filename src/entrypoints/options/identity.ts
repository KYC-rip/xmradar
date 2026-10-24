import { npubEncode } from 'nostr-tools/nip19';
import { HANDLE_RE, normalizeHandle } from '../../identity/envelope';
import { tagDiff } from '../../identity/setup';
import { sendToBackground, type PreparedSetup, type RelayResult, type SetupRequest } from '../../messaging';
import { myHandleItem, pubkeyItem } from '../../settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const npubEl = $('id-npub');
const stateAddress = $('id-state-address');
const stateHandle = $('id-state-handle');
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
const resultsEl = $('id-results');
const retryBtn = $<HTMLButtonElement>('id-retry');
const statusEl = $('id-status');

const KIND_NAMES: Record<number, string> = { 10133: 'payment addresses (kind 10133)', 10011: 'external identities (kind 10011)' };

let prepared: PreparedSetup | null = null;
let busy = false;

function setStatus(text: string, kind: 'ok' | 'error' | '' = '') {
  statusEl.textContent = text;
  statusEl.className = kind;
}

const shortAddr = (a: string) => `${a.slice(0, 10)}…${a.slice(-8)}`;

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

async function showKey() {
  const pk = await pubkeyItem.getValue();
  npubEl.textContent = pk ? npubEncode(pk) : 'not connected (use "Test signer" above)';
}

async function refresh() {
  await guard('Reading your current Nostr lists…', async () => {
    const s = await sendToBackground({ type: 'setup-status' });
    stateAddress.textContent = !s.address ? 'no' : s.address.check.ok ? `yes, ${shortAddr(s.address.address)}` : `invalid address published (${s.address.check.reason})`;
    stateAddress.className = s.address?.check.ok ? 'ok' : '';
    const mine = await myHandleItem.getValue();
    if (!mine) stateHandle.textContent = 'confirm your handle first';
    else if (!s.link) stateHandle.textContent = `@${mine.handle} is not linked yet`;
    else if (s.link.proof.status === 'verified') stateHandle.textContent = `yes, @${s.link.handle}`;
    else if (s.link.proof.status === 'error') stateHandle.textContent = `linked, but X couldn't be reached to check the tweet (${s.link.proof.reason})`;
    else stateHandle.textContent = `linked, but the proof tweet fails: ${s.link.proof.reason}`;
    stateHandle.className = s.link?.proof.status === 'verified' ? 'ok' : '';
    setStatus(s.unreadable.length ? `Read ${s.relays.length} relays; couldn't read ${s.unreadable.join(', ')}.` : `Read ${s.relays.length} relays.`, 'ok');
  });
}

function showDiff(p: PreparedSetup) {
  prepared = p;
  summaryEl.replaceChildren();
  summaryEl.append(`New ${KIND_NAMES[p.kind] ?? `kind ${p.kind}`} list, published to ${p.relays.length} relays: ${p.relays.join(', ')}.`);
  if (p.unreadable.length) {
    const warn = document.createElement('div');
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
  resultsEl.replaceChildren();
  retryBtn.classList.add('hidden');
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
  retryBtn.classList.toggle('hidden', failed === 0);
  return failed;
}

const prepare = (action: SetupRequest) =>
  guard('Reading your current list from relays…', async () => {
    showDiff(await sendToBackground({ type: 'setup-prepare', action }));
    setStatus('Check the change, then sign it.');
  });

$('id-refresh').addEventListener('click', () => {
  if (!confirmBox.classList.contains('hidden')) hideDiff();
  void refresh();
});

$('id-handle-save').addEventListener('click', async () => {
  const handle = normalizeHandle(handleEl.value);
  if (!HANDLE_RE.test(handle)) return setStatus('Enter your X handle (letters, digits and _ only).', 'error');
  hideDiff();
  const prev = await myHandleItem.getValue();
  // a different handle has to be proven again
  await myHandleItem.setValue({ handle, proven: prev?.handle === handle && prev.proven });
  handleEl.value = handle;
  setStatus(`Saved @${handle}. Next: publish your address and link your X account.`, 'ok');
});

$('id-address-publish').addEventListener('click', () => void prepare({ type: 'add-address', address: addressEl.value }));
$('id-address-remove').addEventListener('click', () => void prepare({ type: 'remove-address' }));
$('id-link').addEventListener('click', () => void prepare({ type: 'link-x', tweetUrl: tweetUrlEl.value }));
$('id-unlink').addEventListener('click', () => void prepare({ type: 'unlink-x' }));

$('id-tweet').addEventListener('click', async () => {
  const pk = await pubkeyItem.getValue();
  if (!pk) return setStatus('Connect your signer first ("Test signer" above).', 'error');
  const text = `Verifying that I control the following Nostr public key: ${npubEncode(pk)}`;
  window.open(`https://x.com/intent/post?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
});

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
      setStatus(!ok ? 'No relay accepted the event.' : `${failed ? 'Published, but some relays failed.' : 'Published.'} "Check status" shows the result.`, ok ? 'ok' : 'error');
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
  });
});

export async function initIdentity() {
  await showKey();
  const mine = await myHandleItem.getValue();
  if (mine) handleEl.value = mine.handle;
  pubkeyItem.watch(() => void showKey());
}
