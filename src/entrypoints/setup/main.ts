import '../../ui/base.css';
import './style.css';
import { npubEncode } from 'nostr-tools/nip19';
import { HANDLE_RE, normalizeHandle } from '../../identity/envelope';
import { proofTweetText } from '../../identity/proof-tweet';
import { tagDiff } from '../../identity/setup';
import { identitySteps } from '../../identity/steps';
import { setupStatusLast, statusFor } from '../../identity/status';
import { listButtonText } from '../../identity/xmrbio-list';
import { sendToBackground, type PreparedSetup, type SetupRequest, type SetupStatus } from '../../messaging';
import { closeCurrentPage } from '../../platform/compat';
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
const keyChangeBtn = $<HTMLButtonElement>('key-change');
const keyImportBox = $('key-import-box');
const keyNsecEl = $<HTMLInputElement>('key-nsec');
const keyImportConfirmBox = $('key-import-confirm-box');
const keyImportConfirmText = $('key-import-confirm-text');

let pubkey: string | null = null;
let status: SetupStatus | null = null;
let busy = false;
let pendingImportSecret = '';

const shortNpub = (pk: string) => {
  const n = npubEncode(pk);
  return `${n.slice(0, 12)}…${n.slice(-6)}`;
};

function clearImport(closeBox = false) {
  keyNsecEl.value = '';
  pendingImportSecret = '';
  keyImportConfirmText.textContent = '';
  keyImportConfirmBox.hidden = true;
  if (closeBox) keyImportBox.hidden = true;
}

async function render() {
  const mine = await myHandleItem.getValue();
  const steps = wizardSteps(identitySteps({ npub: pubkey ? npubEncode(pubkey) : null, handle: mine?.handle ?? null, status }));
  for (const s of steps) {
    const el = stepEl(s.key);
    el.dataset.state = s.state;
    el.querySelector('[data-value]')!.textContent = s.value ?? '';
    if (s.warning) say(s.key, s.warning, 'error');
  }
  keyChangeBtn.hidden = !pubkey;
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

let refreshInFlight: Promise<void> | null = null;
async function refresh() {
  if (refreshInFlight) return refreshInFlight;
  const run = (async () => {
    const nextPubkey = await pubkeyItem.getValue();
    if (nextPubkey !== pubkey) status = null;
    pubkey = nextPubkey;
    if (pubkey) {
      // Seed immediately from cached status for this key so reopening setup.html shows Done (0 ms)
      // instead of flashing empty Step 2 inputs while relays re-verify in the background.
      if (!status) {
        const cached = statusFor(await setupStatusLast.getValue().catch(() => null), pubkey);
        if (cached) status = cached.status;
      }
      await render();
      if (!status) say('address', 'Checking relays for your existing address and X proof…');
      const fresh = await sendToBackground({ type: 'setup-status' }).catch(() => null);
      if (fresh) status = fresh;
      say('address', '');
    } else {
      status = null;
    }
    const mine = await myHandleItem.getValue();
    if (mine?.handle && !handleEl.value.trim()) handleEl.value = mine.handle;
    if (!addressEl.value.trim()) {
      const knownAddr =
        (status?.address?.check.ok ? status.address.address : null) ??
        (status?.xmrbio?.found === true && status.xmrbio.linked && status.xmrbio.check.ok ? status.xmrbio.address : null);
      if (knownAddr) addressEl.value = knownAddr;
    }
    await render();
  })().finally(() => {
    refreshInFlight = null;
  });
  refreshInFlight = run;
  return run;
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
    clearImport(true);
    say('key', 'Done.', 'ok');
    await refresh();
  });
});

const toggleImportBox = () => {
  const opening = keyImportBox.hidden;
  clearImport(!opening);
  if (opening) {
    keyImportBox.hidden = false;
    keyNsecEl.focus();
  }
};
$('key-import-open').addEventListener('click', toggleImportBox);
keyChangeBtn.addEventListener('click', toggleImportBox);
$('key-import-cancel').addEventListener('click', () => clearImport(true));
$('key-import-confirm-cancel').addEventListener('click', () => clearImport(true));

async function submitImport(secret: string, confirmOverwrite: boolean) {
  await guard('key', 'Importing key…', async () => {
    try {
      const res = await sendToBackground({ type: 'identity-import', nsec: secret, confirmOverwrite });
      if ('needsConfirm' in res) {
        pendingImportSecret = secret;
        keyNsecEl.value = '';
        keyImportConfirmText.textContent = `This will replace your current stored key (${shortNpub(res.existingPubkey)}). Export it first in Options if you want to keep it.`;
        keyImportConfirmBox.hidden = false;
        say('key', 'Confirm before replacing your stored key.');
        return;
      }
      clearImport(true);
      say('key', res.unchanged ? 'Already using this key.' : 'Key imported.', 'ok');
      await refresh();
    } catch (e) {
      clearImport(false);
      throw e;
    }
  });
}

$('key-import-save').addEventListener('click', (e) => {
  if (!e.isTrusted) return;
  const raw = keyNsecEl.value;
  keyNsecEl.value = '';
  void submitImport(raw, false);
});
$('key-import-confirm').addEventListener('click', (e) => {
  if (!e.isTrusted || !pendingImportSecret) return;
  const raw = pendingImportSecret;
  pendingImportSecret = '';
  void submitImport(raw, true);
});

addEventListener('pagehide', () => clearImport(true));
addEventListener('beforeunload', () => clearImport(true));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearImport(true);
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
$('done-back-x').addEventListener('click', () => {
  void closeCurrentPage({ tabs: browser.tabs, closeWindow: () => window.close() });
});

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
