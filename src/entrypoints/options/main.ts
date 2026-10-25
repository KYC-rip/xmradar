import { npubEncode } from 'nostr-tools/nip19';
import { sendToBackground } from '../../messaging';
import { DEFAULT_BLOSSOM, parseRelayList, pubkeyItem, settingsItem } from '../../settings';
import { mountBurnerPanel } from '../../ui/burner-panel';
import { initIdentity } from './identity';
import '../../ui/base.css';
import './style.css';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const relaysEl = $<HTMLTextAreaElement>('relays');
const blossomEl = $<HTMLInputElement>('blossom');
const appendEl = $<HTMLInputElement>('append-source');
const debugEl = $<HTMLInputElement>('debug');
const statusEl = $('status');
const npubEl = $('npub');

const ALL_SITES = { origins: ['<all_urls>'] };

function setStatus(text: string, error = false) {
  statusEl.textContent = text;
  statusEl.className = error ? 'error' : 'ok';
}

async function showPubkey() {
  const pk = await pubkeyItem.getValue();
  npubEl.textContent = pk ? npubEncode(pk) : '';
}

async function load() {
  const s = await settingsItem.getValue();
  relaysEl.value = s.relays.join('\n');
  blossomEl.value = s.blossomServer;
  appendEl.checked = s.appendSourceLink;
  debugEl.checked = s.debug;
  await showPubkey();
  // Firefox MV3 doesn't grant host permissions at install time
  if (!(await browser.permissions.contains(ALL_SITES))) $('perm').classList.remove('hidden');
}

$('grant').addEventListener('click', async () => {
  if (await browser.permissions.request(ALL_SITES)) $('perm').classList.add('hidden');
});

$('save').addEventListener('click', async () => {
  const blossom = blossomEl.value.trim() || DEFAULT_BLOSSOM;
  if (!/^https:\/\//.test(blossom)) return setStatus('Blossom server must be an https:// URL', true);
  const relays = parseRelayList(relaysEl.value);
  await settingsItem.setValue({ relays, blossomServer: blossom, appendSourceLink: appendEl.checked, debug: debugEl.checked });
  relaysEl.value = relays.join('\n');
  setStatus('Saved');
});

$('test-signer').addEventListener('click', async () => {
  setStatus('Opening a test page…');
  try {
    await sendToBackground({ type: 'test-signer' });
    await showPubkey();
    setStatus('Signer works');
  } catch (e) {
    setStatus((e as Error).message, true);
  }
});

$('load-nip65').addEventListener('click', async () => {
  const pubkey = await pubkeyItem.getValue();
  if (!pubkey) return setStatus('Run "Test signer" first so we know your pubkey', true);
  setStatus('Looking up your relay list…');
  try {
    const { relays } = await sendToBackground({ type: 'load-nip65', pubkey });
    if (!relays.length) return setStatus('No NIP-65 relay list found', true);
    relaysEl.value = relays.join('\n');
    setStatus(`Loaded ${relays.length} relays — click Save to keep them`);
  } catch (e) {
    setStatus((e as Error).message, true);
  }
});

void load();
const burner = mountBurnerPanel($('burner'));
// the popup links to #identity and #burner; scroll once the sections have their content
void Promise.all([initIdentity(), burner.ready]).then(() => {
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
});
