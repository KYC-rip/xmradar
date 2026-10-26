import { npubEncode } from 'nostr-tools/nip19';
import { sendToBackground } from '../../messaging';
import { patchSettings, pubkeyItem, settingsItem } from '../../settings';
import { mountBurnerPanel } from '../../ui/burner-panel';
import { setStatus } from '../../ui/dom';
import { mountBlossomField, mountRelayEditor } from '../../ui/posting-fields';
import { mountSections } from '../../ui/sections';
import { initIdentity, testSigner } from './identity';
import '../../ui/base.css';
import './style.css';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const appendEl = $<HTMLInputElement>('append-source');
const debugEl = $<HTMLInputElement>('debug');
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
for (const el of [appendEl, debugEl]) el.disabled = true;
void settingsItem.getValue().then((s) => {
  appendEl.checked = s.appendSourceLink;
  debugEl.checked = s.debug;
  for (const el of [appendEl, debugEl]) el.disabled = false;
});
for (const el of [appendEl, debugEl]) {
  el.addEventListener('change', async () => {
    await patchSettings(el === appendEl ? { appendSourceLink: el.checked } : { debug: el.checked });
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

void showPubkey();
pubkeyItem.watch(() => void showPubkey());
mountBurnerPanel($('burner'));
mountSections(document, () => scrollTo(0, 0));
void initIdentity();
