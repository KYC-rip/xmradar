import '../../ui/base.css';
import './style.css';
import { npubEncode } from 'nostr-tools/nip19';
import { HANDLE_RE, normalizeHandle } from '../../identity/envelope';
import { proofTweetText } from '../../identity/proof-tweet';
import { tagDiff } from '../../identity/setup';
import { identitySteps } from '../../identity/steps';
import { listButtonText } from '../../identity/xmrbio-list';
import { sendToBackground, type PreparedSetup, type SetupRequest, type SetupStatus } from '../../messaging';
import { myHandleItem, proofCandidateItem, PROOF_CANDIDATE_MS, pubkeyItem, xmrbioListPrefItem } from '../../settings';
import { validateMoneroAddress } from '../../xmr/address';
import { wizardSteps, type WizardKey } from './steps';

/**
 * The setup page (PLAN-XOREACH): the three steps of the Monero identity on one screen, opened by the setup
 * card on X. An extension page, so it uses the same background handlers as Options; nothing on x.com signs.
 */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stepEl = (k: WizardKey) => document.querySelector<HTMLElement>(`[data-step="${k}"]`)!;
const statusOf = (k: WizardKey) => stepEl(k).querySelector<HTMLElement>('[data-status]')!;
function say(k: WizardKey, text: string, kind: 'ok' | 'error' | '' = '') {
  const el = statusOf(k);
  el.textContent = text;
  el.className = `status ${kind}`;
}

const handleEl = $<HTMLInputElement>('handle');
const addressEl = $<HTMLInputElement>('address');
const tweetUrlEl = $<HTMLInputElement>('tweet-url');

let pubkey: string | null = null;
let status: SetupStatus | null = null;
let busy = false;

async function render() {
  const mine = await myHandleItem.getValue();
  const steps = wizardSteps(identitySteps({ npub: pubkey ? npubEncode(pubkey) : null, handle: mine?.handle ?? null, status }));
  for (const s of steps) {
    const el = stepEl(s.key);
    el.dataset.state = s.state;
    el.querySelector('[data-value]')!.textContent = s.value ?? '';
    if (s.warning) say(s.key, s.warning, 'error');
  }
  const done = steps.every((s) => s.state === 'done');
  $('done').hidden = !done;
  if (done && status) $('xmrbio-status').textContent = listButtonText(status, mine?.handle ?? '');
}

async function guard(k: WizardKey, label: string, fn: () => Promise<void>) {
  if (busy) return;
  busy = true;
  say(k, label);
  try {
    await fn();
  } catch (e) {
    say(k, (e as Error).message, 'error');
  } finally {
    busy = false;
  }
}

async function refresh() {
  pubkey = await pubkeyItem.getValue();
  status = pubkey ? await sendToBackground({ type: 'setup-status' }).catch(() => null) : null;
  await render();
}

/** Sign at once when there was no list (the button was the consent); otherwise show the change first. */
async function publish(k: WizardKey, action: SetupRequest) {
  const p = await sendToBackground({ type: 'setup-prepare', action });
  if (p.before === null && !p.unreadable.length) return sign(k, p);
  const box = stepEl(k).querySelector<HTMLElement>('[data-review]')!;
  box.querySelector('[data-review-summary]')!.textContent =
    `You already have this list. The change below is published to ${p.relays.length} relays, signed by ${npubEncode(p.pubkey).slice(0, 16)}….` +
    (p.unreadable.length ? ` Couldn't read ${p.unreadable.join(', ')}: tags kept only there may be lost.` : '');
  box.querySelector('[data-review-diff]')!.textContent = tagDiff(p.before, p.after)
    .map((l) => `${l.op} ${JSON.stringify(l.tag)}`)
    .join('\n');
  box.hidden = false;
  say(k, 'Check the change, then publish it.');
  const signBtn = box.querySelector<HTMLButtonElement>('[data-review-sign]')!;
  const cancelBtn = box.querySelector<HTMLButtonElement>('[data-review-cancel]')!;
  signBtn.onclick = (e) => {
    if (!e.isTrusted) return;
    box.hidden = true;
    void guard(k, 'Publishing…', () => sign(k, p));
  };
  cancelBtn.onclick = () => {
    box.hidden = true;
    void sendToBackground({ type: 'setup-cancel' }).catch(() => {});
    say(k, 'Cancelled. Nothing was published.');
  };
}

async function sign(k: WizardKey, p: PreparedSetup) {
  say(k, 'Signing and publishing… (approve it in your signer if it asks)');
  const { results } = await sendToBackground({ type: 'setup-sign', id: p.id });
  const okCount = results.filter((r) => r.ok).length;
  if (!okCount) throw new Error('No relay accepted it. Try again.');
  say(k, `Published to ${okCount} of ${results.length} relays.`, 'ok');
  await refresh();
}

$('key-make').addEventListener('click', (e) => {
  if (!e.isTrusted) return;
  void guard('key', 'Looking for your signer…', async () => {
    await sendToBackground({ type: 'test-signer' });
    say('key', 'Done.', 'ok');
    await refresh();
  });
});

$('address-publish').addEventListener('click', (e) => {
  if (!e.isTrusted) return;
  void guard('address', 'Reading your current list from relays…', async () => {
    const handle = normalizeHandle(handleEl.value);
    if (!HANDLE_RE.test(handle)) throw new Error('Enter your X handle (letters, digits and _ only).');
    const address = addressEl.value.trim();
    const check = validateMoneroAddress(address);
    if (!check.ok) throw new Error(`That isn't a Monero mainnet address (${check.reason}).`);
    // as Options' Confirm: a different handle has to be proven again
    const prev = await myHandleItem.getValue();
    await myHandleItem.setValue({ handle, proven: prev?.handle === handle && prev.proven });
    await publish('address', { type: 'add-address', address });
  });
});

$('tweet').addEventListener('click', (e) => {
  if (!e.isTrusted || !pubkey) return;
  window.open(`https://x.com/intent/post?text=${encodeURIComponent(proofTweetText(npubEncode(pubkey)))}`, '_blank', 'noopener');
  say('link', 'Post it on X, then come back here. XMRadar fills in the link when it sees your tweet.');
});

$('link').addEventListener('click', (e) => {
  if (!e.isTrusted) return;
  void guard('link', 'Checking your tweet…', () => publish('link', { type: 'link-x', tweetUrl: tweetUrlEl.value.trim() }));
});

/** The tweet the X tab saw: for this key and handle, and recent. */
async function fillCandidate() {
  const c = await proofCandidateItem.getValue();
  const mine = await myHandleItem.getValue();
  if (!c || !pubkey || c.pubkey !== pubkey || Date.now() - c.at > PROOF_CANDIDATE_MS) return;
  if (!mine || normalizeHandle(mine.handle) !== normalizeHandle(c.handle) || tweetUrlEl.value.trim()) return;
  tweetUrlEl.value = `https://x.com/${c.handle}/status/${c.statusId}`;
  say('link', 'Found your tweet. Link it to finish.', 'ok');
}

const listOn = $<HTMLInputElement>('xmrbio-on');
void xmrbioListPrefItem.getValue().then((p) => (listOn.checked = p !== 'off'));
listOn.addEventListener('change', () => void xmrbioListPrefItem.setValue(listOn.checked ? 'on' : 'off'));

async function init() {
  let hint = '';
  try {
    hint = decodeURIComponent(location.hash.slice(1));
  } catch {
    /* a malformed fragment: no hint */
  }
  const mine = await myHandleItem.getValue();
  handleEl.value = mine?.handle ?? (HANDLE_RE.test(hint) ? hint : '');
  proofCandidateItem.watch(() => void fillCandidate());
  pubkeyItem.watch(() => void refresh());
  await refresh();
  await fillCandidate();
}
void init();
