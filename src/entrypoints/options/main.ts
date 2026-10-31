import { npubEncode } from 'nostr-tools/nip19';
import { currentBuild } from '../../build-info';
import { sendToBackground } from '../../messaging';
import { cleanXLinksOn, patchSettings, pubkeyItem, settingsItem, shareMenuOn, type Settings } from '../../settings';
import { mountBadgeLook } from '../../ui/badge-look-controls';
import { mountBurnerPanel } from '../../ui/burner-panel';
import { mountReceiptsPanel } from '../../ui/receipts-panel';
import { setStatus } from '../../ui/dom';
import { mountBlossomField, mountRelayEditor } from '../../ui/posting-fields';
import { mountSections } from '../../ui/sections';
import { mountXmrToggles } from '../../ui/xmr-toggles';
import { initIdentity, testSigner } from './identity';
import '../../ui/base.css';
import './style.css';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const appendEl = $<HTMLInputElement>('append-source');
const debugEl = $<HTMLInputElement>('debug');
const shareMenuEl = $<HTMLInputElement>('share-menu-x');
const cleanLinksEl = $<HTMLInputElement>('clean-x-links');
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

// Behaviour: saved on change, each box its own field; disabled until the saved values load
const boxes: [HTMLInputElement, (on: boolean) => Partial<Settings>][] = [
  [appendEl, (on) => ({ appendSourceLink: on })],
  [debugEl, (on) => ({ debug: on })],
  [shareMenuEl, (on) => ({ shareMenuX: on })],
  [cleanLinksEl, (on) => ({ cleanXLinks: on })],
];
for (const [el] of boxes) el.disabled = true;
void settingsItem.getValue().then((s) => {
  appendEl.checked = s.appendSourceLink;
  debugEl.checked = s.debug;
  shareMenuEl.checked = shareMenuOn(s);
  cleanLinksEl.checked = cleanXLinksOn(s);
  for (const [el] of boxes) el.disabled = false;
});
for (const [el, patch] of boxes) {
  el.addEventListener('change', async () => {
    await patchSettings(patch(el.checked));
    setStatus($('behaviour-saved'), 'Saved', 'ok');
    setTimeout(() => setStatus($('behaviour-saved'), ''), 1500);
  });
}

const relays = mountRelayEditor($('relay-editor'));
void mountBlossomField($('blossom-field'));

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
void mountBadgeLook($('badge-look'));
mountBurnerPanel($('burner'));
void mountReceiptsPanel($('receipts'));
mountSections(document, () => scrollTo(0, 0));
void initIdentity();
