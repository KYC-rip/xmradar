import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { npubEncode } from 'nostr-tools/nip19';
import { ownStatusId } from '../../extractors/x';
import { HANDLE_RE, normalizeHandle } from '../../identity/envelope';
import { containsNpub } from '../../identity/nostr';
import { sendToBackground } from '../../messaging';
import { myHandleItem, pubkeyItem, setupCardItem, xmrSettingsItem, xoButtonOn } from '../../settings';

/**
 * The setup card on X (PLAN-XOREACH): until the Monero identity is complete, a small card asks for the minute
 * it takes. A launcher only: its one button has the background open setup.html, an extension page, where the
 * key, address and proof tweet are done; nothing here signs. While the handle isn't proven, it also spots the
 * user's own proof tweet on the page and tells the background, for setup.html to fill in (a suggestion only:
 * linking still checks the tweet on X).
 */

export const CARD_TAG = 'xmradar-setup-card';
export const SNOOZE_MS = 7 * 86_400_000;
const SHOW_AFTER_MS = 5000;
const SPOT_EVERY_MS = 3000;
const TWEET = 'article[data-testid="tweet"]';

export type CardPref = { snoozedUntil?: number; dismissed?: boolean; nudged?: boolean };

/** Whether the card may show, before asking the background whether setup is complete. */
export const cardAllowed = (xoOn: boolean, pref: CardPref, now: number) => xoOn && !pref.dismissed && (pref.snoozedUntil ?? 0) <= now;

/** The signed-in user's handle from X's side nav (the Profile link), or null. Only a pre-fill. */
export function handleFromNav(doc: Document): string | null {
  const href = doc.querySelector<HTMLAnchorElement>('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href') ?? '';
  const h = href.split('/')[1] ?? '';
  return HANDLE_RE.test(h) ? h : null;
}

/** The status id of a post by `handle` on the page whose text carries `npub` as a whole word, or null. */
export function findProofTweet(doc: Document, handle: string, npub: string): string | null {
  const want = normalizeHandle(handle);
  for (const a of doc.querySelectorAll(TWEET)) {
    const author = a.querySelector<HTMLAnchorElement>('[data-testid="User-Name"] a[href^="/"]')?.getAttribute('href')?.split('/')[1] ?? '';
    if (normalizeHandle(author) !== want) continue;
    const text = a.querySelector('[data-testid="tweetText"]')?.textContent ?? '';
    if (!containsNpub(text, npub)) continue;
    const id = ownStatusId(a);
    if (id) return id;
  }
  return null;
}

const STYLE = `
:host { all: initial; position: fixed; right: 20px; bottom: 84px; z-index: 2147483000; }
.card { font: 14px/1.4 system-ui, -apple-system, sans-serif; width: 300px; box-sizing: border-box; padding: 14px 16px; border-radius: 16px;
  background: #fff; color: #0f1419; border: 1px solid rgba(0,0,0,.08); box-shadow: 0 8px 28px rgba(0,0,0,.18); position: relative; }
@media (prefers-color-scheme: dark) { .card { background: #16181c; color: #e7e9ea; border-color: rgba(255,255,255,.12); } }
strong { display: block; font-size: 15px; margin: 0 22px 4px 0; }
p { margin: 0 0 12px; opacity: .85; }
.row { display: flex; gap: 8px; align-items: center; }
button { font: inherit; cursor: pointer; border-radius: 999px; border: 0; padding: 7px 14px; }
.go { background: #f26822; color: #fff; font-weight: 700; }
.later { background: transparent; color: inherit; opacity: .75; }
.x { position: absolute; top: 8px; right: 8px; background: transparent; color: inherit; padding: 4px 8px; opacity: .6; }
`;

function cardEl(doc: Document, text: { title: string; body: string }, on: { go(): void; later(): void; close(): void }): HTMLElement {
  const host = doc.createElement(CARD_TAG);
  const root = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = STYLE;
  const card = doc.createElement('div');
  card.className = 'card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', text.title);
  const title = doc.createElement('strong');
  title.textContent = text.title;
  const body = doc.createElement('p');
  body.textContent = text.body;
  const row = doc.createElement('div');
  row.className = 'row';
  const mk = (cls: string, label: string, fn: () => void, aria?: string) => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    if (aria) b.setAttribute('aria-label', aria);
    // only the user's own clicks: the page can't press these for them
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.isTrusted) fn();
    });
    return b;
  };
  row.append(mk('go', 'Set up', on.go), mk('later', 'Not now', on.later));
  card.append(mk('x', '×', on.close, 'Don’t show again'), title, body, row);
  root.append(style, card);
  return host;
}

const CARD_TEXT = {
  title: 'Get xos on X',
  body: 'Set up your Monero identity, about a minute: XMRadar makes your Nostr key, you add your Monero address and post one tweet. Then Monero people can xo your posts, and your xos count.',
};
const NUDGE_TEXT = {
  title: 'Your xo is sent',
  body: 'It counts once you’ve set up your Monero identity. About a minute: a Nostr key, your Monero address and one tweet.',
};

let complete: boolean | null = null;
let showNudge: (() => void) | null = null;

/** After an xo is sent: once per browser, while setup isn't complete, the card says the xo counts after setup. */
export function noteXoSent() {
  if (complete === false) showNudge?.();
}

export function startSetupCard(ctx: ContentScriptContext) {
  let card: HTMLElement | null = null;
  const remove = () => {
    card?.remove();
    card = null;
  };
  const open = () => {
    remove();
    void sendToBackground({ type: 'open-setup', handleHint: handleFromNav(document) ?? undefined }).catch(() => {});
  };
  const later = async () => {
    remove();
    await setupCardItem.setValue({ ...(await setupCardItem.getValue()), snoozedUntil: Date.now() + SNOOZE_MS });
  };
  const close = async () => {
    remove();
    await setupCardItem.setValue({ ...(await setupCardItem.getValue()), dismissed: true });
  };
  const show = (text: typeof CARD_TEXT) => {
    if (card || !ctx.isValid) return;
    card = cardEl(document, text, { go: open, later: () => void later(), close: () => void close() });
    document.body.append(card);
  };

  async function check() {
    const [s, pref] = await Promise.all([xmrSettingsItem.getValue(), setupCardItem.getValue()]);
    // unknown on a failed ask: no card now, and the next key or handle change asks again
    const r = await sendToBackground({ type: 'setup-card-state' }).catch(() => null);
    if (!r) return;
    complete = r.complete;
    if (!complete && cardAllowed(xoButtonOn(s), pref, Date.now())) show(CARD_TEXT);
  }
  showNudge = () =>
    void setupCardItem.getValue().then(async (pref) => {
      if (pref.nudged || card) return;
      await setupCardItem.setValue({ ...pref, nudged: true });
      show(NUDGE_TEXT);
    });
  ctx.setTimeout(() => void check(), SHOW_AFTER_MS);
  // setup finished elsewhere (setup.html, Options): the card goes
  const recheck = () =>
    void sendToBackground({ type: 'setup-card-state' }).then(async (r) => {
      complete = r.complete;
      if (r.complete) return remove();
      const [s, pref] = await Promise.all([xmrSettingsItem.getValue(), setupCardItem.getValue()]);
      if (cardAllowed(xoButtonOn(s), pref, Date.now())) show(CARD_TEXT);
    }, () => {});
  myHandleItem.watch(recheck);
  pubkeyItem.watch(recheck);

  // the proof tweet spotter: only while the handle isn't proven, and only for the current key and handle
  let told = '';
  ctx.setInterval(() => {
    if (document.hidden || complete !== false) return;
    void Promise.all([pubkeyItem.getValue(), myHandleItem.getValue()]).then(([pk, mine]) => {
      if (!pk || !mine || mine.proven) return;
      const id = findProofTweet(document, mine.handle, npubEncode(pk));
      if (!id || id === told) return;
      told = id;
      void sendToBackground({ type: 'proof-tweet-seen', handle: normalizeHandle(mine.handle), statusId: id }).catch(() => {});
    });
  }, SPOT_EVERY_MS);
}
