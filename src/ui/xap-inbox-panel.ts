import { sendToBackground } from '../messaging';
import { patchXmrSettings, pubkeyItem, xapInboxItem, xapNotifyOn, xmrSettingsItem, xoInboxItem } from '../settings';
import type { XoItem } from '../xo/inbox';
import { shortNpub, type InboxItem, type InboxState } from '../xap/inbox';
import { part } from './dom';

/** "12 minutes ago", for the last check */
export function ago(ms: number, now = Date.now()): string {
  const min = Math.round((now - ms) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} hour${h === 1 ? '' : 's'} ago` : new Date(ms).toLocaleString();
}

/** The line under the list: when it last checked, or why it can't. */
export function inboxStatus(st: InboxState | null, now = Date.now()): string {
  if (!st || st.checkedAt === null) return 'Not checked yet.';
  if (st.error === 'no-address') return 'Publish your Monero address under Monero identity first: only Xaps to it count.';
  if (st.error) return `The last check failed (${st.error}), ${ago(st.checkedAt, now)}.`;
  return `Checked ${ago(st.checkedAt, now)}.`;
}

const el = (tag: string, cls: string, text: string) => {
  const e = document.createElement(tag);
  e.className = cls;
  e.textContent = text;
  return e;
};

/** One line of the list. Built from text only: names and targets are the tipper's choice. */
export function itemLine(it: InboxItem): HTMLLIElement {
  const li = document.createElement('li');
  li.append(el('span', 'who', it.name ?? shortNpub(it.tipper)));
  if (it.name) li.append(el('span', 'npub', shortNpub(it.tipper)));
  if (it.target.kind === 'post') {
    const what = el('span', 'what', 'for an X post (named by the tipper): ');
    const a = document.createElement('a');
    // built from the checked status id only
    a.href = `https://x.com/i/status/${it.target.id}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = `x.com/i/status/${it.target.id}`;
    what.append(a);
    li.append(what);
  } else li.append(el('span', 'what', it.target.kind === 'note' ? 'for a Nostr note' : 'for your profile'));
  li.append(el('span', 'when', new Date(it.at * 1000).toLocaleString()));
  li.append(el('span', 'amount', `${it.amount} XMR`));
  li.append(el('span', `state ${it.state}`, it.state === 'verified' ? 'verified' : 'says they sent it'));
  return li;
}

/** One received xo: the sender's verified X handle and the post, built from checked values only. */
export function xoLine(it: XoItem): HTMLLIElement {
  const li = document.createElement('li');
  li.append(el('span', 'who', `@${it.handle}`), el('span', 'npub', shortNpub(it.liker)));
  const what = el('span', 'what', 'sent an xo to ');
  const a = document.createElement('a');
  a.href = `https://x.com/i/status/${it.statusId}`;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = `x.com/i/status/${it.statusId}`;
  what.append(a);
  li.append(what, el('span', 'when', new Date(it.at * 1000).toLocaleString()));
  return li;
}

/** Options → Badges on X: the "Tell me when I get a Xap" switch and the Xaps received list (PLAN-XAPINBOX). */
export async function mountXapInbox(root: HTMLElement) {
  const sw = part<HTMLInputElement>(root, 'inbox', 'switch');
  const why = part<HTMLElement>(root, 'inbox', 'why');
  const body = part<HTMLElement>(root, 'inbox', 'body');
  const list = part<HTMLUListElement>(root, 'inbox', 'list');
  const xoList = part<HTMLUListElement>(root, 'inbox', 'xo-list');
  const status = part<HTMLElement>(root, 'inbox', 'status');
  const check = part<HTMLButtonElement>(root, 'inbox', 'check');
  const relaysSummary = part<HTMLElement>(root, 'inbox', 'relays-summary');
  const relays = part<HTMLElement>(root, 'inbox', 'relays');
  const section = root.closest<HTMLElement>('[data-section]');
  let unreadXos = (await xoInboxItem.getValue())?.unread ?? 0;

  // seen while its section is open: no unread, no notification
  const markRead = (st: InboxState | null) => {
    if ((st?.unread || unreadXos) && !section?.hidden && document.visibilityState === 'visible') void sendToBackground({ type: 'xap-inbox-read' }).catch(() => {});
  };

  async function render() {
    const [settings, pubkey, st, xos] = await Promise.all([xmrSettingsItem.getValue(), pubkeyItem.getValue(), xapInboxItem.getValue(), xoInboxItem.getValue()]);
    const on = xapNotifyOn(settings);
    sw.checked = on;
    // it's turned off without a key too, so the switch stays usable to turn it off
    sw.disabled = !pubkey && !on;
    why.textContent = pubkey ? '' : 'Connect your signer under Monero identity first.';
    body.classList.toggle('hidden', !on || !pubkey);
    if (!on || !pubkey) return;
    list.replaceChildren(...(st?.items ?? []).map(itemLine));
    xoList.replaceChildren(...(xos?.pubkey === pubkey ? xos.items : []).map(xoLine));
    status.textContent = inboxStatus(st);
    const asked = st?.relays ?? [];
    relaysSummary.textContent = asked.length ? `Asking ${asked.length} relays` : '';
    relays.textContent = asked.join(', ');
    markRead(st);
  }

  sw.addEventListener('change', () => {
    void patchXmrSettings({ xapNotify: sw.checked }).catch(async (e) => {
      console.error('[XMRadar] settings', e);
      await render();
    });
  });
  check.addEventListener('click', async () => {
    check.disabled = true;
    status.textContent = 'Checking…';
    await sendToBackground({ type: 'xap-inbox-check' }).catch(() => {});
    check.disabled = false;
    await render();
  });
  xmrSettingsItem.watch(() => void render());
  pubkeyItem.watch(() => void render());
  xapInboxItem.watch(() => void render());
  xoInboxItem.watch((x) => {
    unreadXos = x?.unread ?? 0;
    void render();
  });
  addEventListener('hashchange', () => void xapInboxItem.getValue().then(markRead));
  document.addEventListener('visibilitychange', () => void xapInboxItem.getValue().then(markRead));
  await render();
  // opened from a Xap notification or the menu's line: straight to the list
  if (new URLSearchParams(location.search).has('xaps')) root.scrollIntoView({ block: 'start' });
}
