import { npubEncode } from 'nostr-tools/nip19';
import { currentBuild } from '../../build-info';
import { mountUpdatePanel } from '../../ui/update-notice';
import { sendToBackground } from '../../messaging';
import { cleanXLinksOn, syncedMarkOn, siwmHelperOn, useNip65On, patchSettings, pubkeyItem, settingsItem, shareMenuOn, type Settings } from '../../settings';
import { mountBadgeLook } from '../../ui/badge-look-controls';
import { mountBurnerPanel } from '../../ui/burner-panel';
import { mountReceiptsPanel } from '../../ui/receipts-panel';
import { setStatus } from '../../ui/dom';
import { mountBlossomField, mountRelayEditor, mountRelaysInUse } from '../../ui/posting-fields';
import { mountAiTagsPanel, mountTagsField } from '../../ui/ai-tags-panel';
import { mountSections } from '../../ui/sections';
import { mountXmrToggles } from '../../ui/xmr-toggles';
import { mountXapInbox } from '../../ui/xap-inbox-panel';
import { mountIdentityCard } from '../../ui/identity-card';
import { initIdentity, testSigner } from './identity';
import '../../ui/base.css';
import './style.css';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const appendEl = $<HTMLInputElement>('append-source');
const debugEl = $<HTMLInputElement>('debug');
const shareMenuEl = $<HTMLInputElement>('share-menu-x');
const cleanLinksEl = $<HTMLInputElement>('clean-x-links');
const syncedMarkEl = $<HTMLInputElement>('synced-mark');
const useNip65El = $<HTMLInputElement>('use-nip65');
const siwmEl = $<HTMLInputElement>('siwm-helper');
const signerStatus = $('signer-status');

const ALL_SITES = { origins: ['<all_urls>'] };

async function showPubkey() {
  const pk = await pubkeyItem.getValue();
  $('npub').textContent = pk ? npubEncode(pk) : 'Not connected';
  $('signer-dot').classList.toggle('on', !!pk);
  $('test-signer').textContent = pk ? 'Test again' : 'Test signer';
}

// Firefox MV3 doesn't grant host permissions at install time
void browser.permissions.contains(ALL_SITES).then((ok) => $('perm').classList.toggle('hidden', ok));
$('grant').addEventListener('click', async () => {
  if (await browser.permissions.request(ALL_SITES)) $('perm').classList.add('hidden');
});

// Sign in with Monero (PLAN-SIWM): the link helper's switch, and a window to paste a link into
siwmEl.disabled = true;
void settingsItem.getValue().then((s) => {
  siwmEl.checked = siwmHelperOn(s);
  siwmEl.disabled = false;
});
siwmEl.addEventListener('change', async () => {
  await patchSettings({ siwmHelper: siwmEl.checked });
  setStatus($('siwm-saved'), 'Saved', 'ok');
  setTimeout(() => setStatus($('siwm-saved'), ''), 1500);
});
$('siwm-paste').addEventListener('click', () => void browser.windows.create({ url: browser.runtime.getURL('/siwm.html'), type: 'popup', width: 520, height: 720 }));

// Behaviour: saved on change, each box its own field; disabled until the saved values load
const boxes: [HTMLInputElement, (on: boolean) => Partial<Settings>][] = [
  [appendEl, (on) => ({ appendSourceLink: on })],
  [debugEl, (on) => ({ debug: on })],
  [shareMenuEl, (on) => ({ shareMenuX: on })],
  [cleanLinksEl, (on) => ({ cleanXLinks: on })],
  [syncedMarkEl, (on) => ({ syncedMark: on })],
];
for (const [el] of boxes) el.disabled = true;
void settingsItem.getValue().then((s) => {
  appendEl.checked = s.appendSourceLink;
  debugEl.checked = s.debug;
  shareMenuEl.checked = shareMenuOn(s);
  cleanLinksEl.checked = cleanXLinksOn(s);
  syncedMarkEl.checked = syncedMarkOn(s);
  for (const [el] of boxes) el.disabled = false;
});
// the relay switch saves like the boxes, but says so next to the relays (PLAN-NIP65SWITCH)
useNip65El.disabled = true;
void settingsItem.getValue().then((s) => {
  useNip65El.checked = useNip65On(s);
  useNip65El.disabled = false;
});
useNip65El.addEventListener('change', async () => {
  await patchSettings({ useNip65: useNip65El.checked });
  const saved = document.querySelector<HTMLElement>('[data-relays="saved"]');
  if (saved) {
    saved.textContent = 'Saved';
    setTimeout(() => (saved.textContent = ''), 1500);
  }
});
for (const [el, patch] of boxes) {
  el.addEventListener('change', async () => {
    await patchSettings(patch(el.checked));
    setStatus($('behaviour-saved'), 'Saved', 'ok');
    setTimeout(() => setStatus($('behaviour-saved'), ''), 1500);
  });
}

const relays = mountRelayEditor($('relay-editor'));
mountRelaysInUse($('relay-editor'));
void mountBlossomField($('blossom-field'));
void mountTagsField(document);
void mountAiTagsPanel(document);
void mountUpdatePanel(document);

$('test-signer').addEventListener('click', () => void testSigner(signerStatus));

$('load-nip65').addEventListener('click', async () => {
  const pubkey = await pubkeyItem.getValue();
  if (!pubkey) return setStatus($('relay-error'), 'Connect your signer first ("Test signer" above), so XMRadar knows your key.', 'error');
  setStatus($('relay-error'), 'Looking up your relay list…');
  try {
    const { relays: found } = await sendToBackground({ type: 'load-nip65', pubkey });
    if (!found.length) return setStatus($('relay-error'), 'No NIP-65 relay list found.', 'error');
    await relays.replace(found);
    setStatus($('relay-error'), `Loaded ${found.length} relays from your NIP-65 list.`, 'ok');
  } catch (e) {
    setStatus($('relay-error'), (e as Error).message, 'error');
  }
});

const build = currentBuild();
$('build-info').textContent = build.label;
if (build.url) $<HTMLAnchorElement>('build-info').href = build.url;

void showPubkey();
pubkeyItem.watch(() => void showPubkey());
void mountXmrToggles($('badge-switches'));
void mountXapInbox($('xap-inbox'));
void mountIdentityCard($('nostr-identity'));
void mountBadgeLook($('badge-look'));
mountBurnerPanel($('burner'));
void mountReceiptsPanel($('receipts'));
mountSections(document, () => scrollTo(0, 0));
void initIdentity();
