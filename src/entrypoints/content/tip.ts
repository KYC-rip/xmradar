import { decode as nip19Decode, npubEncode } from 'nostr-tools/nip19';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root';
import { HANDLE_RE, normalizeHandle, toTimestamp, type ResolvedIdentity } from '../../identity/envelope';
import { xapEntry, type Badge, type BadgeEntry } from '../../identity/resolve';
import { sendToBackground, type XapTotals } from '../../messaging';
import { xmrSettingsItem } from '../../settings';
import { isValidAmount, moneroUri, type AddressCheck } from '../../xmr/address';
import { h, trapFocus } from './dom';
import { fiatChips } from './fiat-chips';
import { qrSvg } from './qr-svg';
import { renderXap } from './xap-popup';

let open = false;

const fmtDate = (s: string) => {
  const t = toTimestamp(s);
  return Number.isNaN(t) ? s : new Date(t).toLocaleString();
};

const keyFingerprint = (key: string) => `${key.slice(0, 8)}…${key.slice(-8)}`;

/** Only allowlisted link templates, each value validated before it goes into the URL. */
const links = {
  xmrbio: (handle: string) => (HANDLE_RE.test(handle) ? `https://xmr.bio/${handle}` : null),
  tweet: (handle: string, id: string | undefined) => (HANDLE_RE.test(handle) && id && /^\d{1,20}$/.test(id) ? `https://x.com/${handle}/status/${id}` : null),
  njump: (npub: string) => {
    try {
      return nip19Decode(npub).type === 'npub' ? `https://njump.me/${npub}` : null;
    } catch {
      return null;
    }
  },
};

const PROOF_LABELS = new Map([['nostr', 'Nostr'], ['x-post', 'X post'], ['agent-key', 'Agent key']]);

export interface TipOptions {
  /** opened from the action bar's Xap button */
  xap?: boolean;
  /** the action bar's cached totals, shown until fresh ones arrive (verified only) */
  totals?: XapTotals;
}

/** From a badge, `badge` is shown right away and xmr.bio is only asked on click. */
export async function openTip(ctx: ContentScriptContext, handle: string | null, badge?: Badge, opts: TipOptions = {}) {
  if (open) return;
  open = true;
  try {
    await mountTip(ctx, handle, badge, opts);
  } catch (e) {
    open = false;
    window.alert(`XMRadar: ${(e as Error).message}`);
  }
}

async function mountTip(ctx: ContentScriptContext, detected: string | null, badge?: Badge, opts: TipOptions = {}) {
  const previousFocus = document.activeElement as HTMLElement | null;
  let closed = false;
  const receipts = opts.xap ? (await xmrSettingsItem.getValue()).tipReceipts : false;

  const ui = await createShadowRootUi(ctx, {
    name: 'xmradar-tip',
    position: 'modal',
    zIndex: 2147483647,
    isolateEvents: true,
    onMount(container) {
      const close = () => {
        if (closed) return;
        closed = true;
        ui.remove();
      };

      const status = h('div', { class: 'status', attrs: { role: 'status', 'aria-live': 'polite' } });
      const setStatus = (text: string, kind: 'info' | 'error' | 'ok' = 'info') => {
        status.className = `status ${kind}`;
        status.textContent = text;
      };

      const handleInput = h('input', { type: 'text', value: detected ?? '', placeholder: 'X handle', attrs: { 'aria-label': 'X handle', spellcheck: 'false' } });
      const lookupBtn = h('button', { textContent: 'Look up on xmr.bio' });
      const result = h('div', { class: 'tip-result' });
      const title = h('h2', { textContent: 'Tip with Monero' });
      const closeBtn = h('button', { textContent: 'Close' });

      const dialog = h(
        'div',
        { class: 'dialog', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Tip with Monero' } },
        h('header', {}, title, h('span', { class: 'site', textContent: 'XMRadar' })),
        h('div', { class: 'row' }, handleInput, lookupBtn),
        status,
        result,
        h('footer', {}, closeBtn),
      );
      container.append(h('div', { class: 'backdrop' }, dialog));

      closeBtn.addEventListener('click', close);
      dialog.parentElement!.addEventListener('click', (e) => e.target === e.currentTarget && close());
      trapFocus(dialog, close);

      let busy = false;
      const lookup = async () => {
        const handle = normalizeHandle(handleInput.value);
        if (!HANDLE_RE.test(handle)) return setStatus('Enter a valid X handle.', 'error');
        if (busy) return;
        busy = true;
        lookupBtn.disabled = true;
        // a badge's sources stay on screen unless xmr.bio actually answers with a profile
        if (!badge?.primary) result.replaceChildren();
        setStatus(`Asking xmr.bio about @${handle}…`);
        try {
          const res = await sendToBackground({ type: 'xmrbio-resolve', handle });
          if (closed) return;
          if (!res.found) {
            setStatus(`@${handle} has no xmr.bio profile.`);
            return;
          }
          setStatus('');
          title.textContent = `Tip @${res.identity.handle}`;
          // xmr.bio is primary; Nostr claims from the badge stay listed below it
          const others = badge && normalizeHandle(badge.handle) === handle ? badge : undefined;
          const differs = others?.entries.some((e) => e.verified && e.check.ok && e.address !== res.identity.address);
          result.replaceChildren(
            differs ? h('div', { class: 'warn' }, 'Addresses differ between xmr.bio and Nostr. Check the sources below before sending.') : '',
            renderIdentity(res.identity, res.check),
            others ? badgePanel(others) : '',
          );
        } catch (e) {
          setStatus(`Could not check xmr.bio: ${(e as Error).message}`, 'error');
        } finally {
          busy = false;
          lookupBtn.disabled = false;
        }
      };
      lookupBtn.addEventListener('click', () => void lookup());
      handleInput.addEventListener('keydown', (e) => e.key === 'Enter' && void lookup());

      const xap = opts.xap && badge ? xapEntry(badge) : null;
      if (opts.xap && badge?.primary) {
        const who = detected ?? badge.handle;
        title.textContent = `Xap @${who}`;
        dialog.setAttribute('aria-label', `Xap @${who}`);
        if (xap?.pubkey) {
          const x = renderXap({ handle: who, entry: xap as BadgeEntry & { pubkey: string }, cached: opts.totals, receipts, isClosed: () => closed });
          x.append(badgePanel(badge));
          if (badge.differ) x.prepend(h('div', { class: 'warn' }, 'This account has published more than one address. Xaps go to its Nostr address; check the sources below before sending.'));
          result.replaceChildren(x);
        } else {
          // xmr.bio only: a plain tip, with nothing to record it against
          const plain = renderBadge(badge);
          plain.prepend(h('div', { class: 'small' }, "This account has no Nostr key, so Xaps can't be recorded. You can still tip."));
          result.replaceChildren(plain);
        }
      } else if (badge?.primary) {
        title.textContent = `Tip @${detected ?? badge.handle}`;
        result.replaceChildren(renderBadge(badge));
      } else if (detected) {
        // the menu item itself says "look up on xmr.bio", so a detected handle is checked right away
        void lookup();
      }
      setTimeout(() => (detected ? closeBtn : handleInput).focus(), 0);
    },
    onRemove() {
      open = false;
      closed = true;
      previousFocus?.focus?.();
    },
  });
  try {
    ui.mount();
  } catch (e) {
    ui.remove();
    throw e;
  }
}

export function renderIdentity(id: ResolvedIdentity, check: AddressCheck): HTMLElement {
  return renderPayment(id.address, check, 'xmr.bio', sourcePanel(id));
}

export function renderBadge(badge: Badge): HTMLElement {
  const p = badge.primary!;
  const el = renderPayment(p.address, p.check, p.source === 'xmrbio' ? 'xmr.bio' : 'Nostr', badgePanel(badge));
  if (badge.differ) el.prepend(h('div', { class: 'warn' }, 'This account has published more than one address. Check the sources below before sending.'));
  return el;
}

function renderPayment(address: string, check: AddressCheck, sourceLabel: string, panel: HTMLElement): HTMLElement {
  const wrap = h('div', { class: 'tip' });
  const addrBox = h('code', { class: 'addr', textContent: address });

  if (!check.ok) {
    wrap.append(h('div', { class: 'warn' }, `${sourceLabel} lists an invalid address for this account (${check.reason}). Don't send to it.`), addrBox);
  } else {
    const copyBtn = h('button', { textContent: 'Copy address' });
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(address).then(
        () => (copyBtn.textContent = 'Copied'),
        () => {
          // clipboard can be blocked; select the address so it can be copied by hand
          getSelection()?.selectAllChildren(addrBox);
          copyBtn.textContent = 'Press Ctrl/⌘+C';
        },
      );
    });
    const amount = h('input', { type: 'text', placeholder: 'Amount (XMR, optional)', attrs: { inputmode: 'decimal', 'aria-label': 'Amount in XMR' } });
    const amountErr = h('div', { class: 'status error' });
    const qrBox = h('div', { class: 'qr-box' });
    const walletLink = h('a', { class: 'button primary', textContent: 'Open in wallet' });

    const update = () => {
      const value = amount.value.trim();
      if (value && !isValidAmount(value)) {
        amountErr.textContent = 'Amount must be a number like 0.05 (up to 12 decimals).';
        qrBox.replaceChildren();
        walletLink.removeAttribute('href');
        walletLink.setAttribute('aria-disabled', 'true');
        return;
      }
      amountErr.textContent = '';
      const uri = moneroUri(address, { amount: value || undefined });
      qrBox.replaceChildren(qrSvg(uri));
      walletLink.href = uri;
      walletLink.removeAttribute('aria-disabled');
    };
    amount.addEventListener('input', update);
    update();

    wrap.append(
      qrBox,
      addrBox,
      check.type === 'integrated' && check.paymentId ? h('div', { class: 'small' }, `Integrated address, payment ID ${check.paymentId}`) : '',
      h('div', { class: 'row' }, copyBtn, amount),
      fiatChips(amount),
      amountErr,
      h('div', { class: 'row' }, walletLink),
    );
  }

  wrap.append(panel);
  return wrap;
}

const shortAddr = (a: string) => `${a.slice(0, 8)}…${a.slice(-8)}`;

function entryLine(handle: string, e: BadgeEntry, primary: boolean): HTMLElement {
  const li = h('li', {});
  if (e.source === 'nostr' && e.pubkey) {
    let npub = '';
    try {
      npub = npubEncode(e.pubkey);
    } catch {
      // not a valid pubkey: shown without a link
    }
    const url = npub ? links.njump(npub) : null;
    li.append('Nostr ', url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', textContent: `${npub.slice(0, 12)}…${npub.slice(-6)}` }) : h('span', { textContent: e.pubkey }));
  } else {
    li.append(e.source === 'xmrbio' ? 'xmr.bio' : e.source);
  }
  li.append(`: ${shortAddr(e.address)}`);
  if (primary) li.append(h('strong', { textContent: ' (shown above)' }));
  const tweet = links.tweet(handle, e.tweetId);
  const status = !e.check.ok ? `invalid address (${e.check.reason})` : e.verified ? `linked to @${handle} by a proof tweet, checked by XMRadar (${e.method})` : `unverified: ${e.note ?? 'no proof'}`;
  li.append(h('div', { class: 'small' }, status, tweet ? ' · ' : '', tweet ? h('a', { href: tweet, target: '_blank', rel: 'noopener noreferrer', textContent: 'proof tweet' }) : ''));
  if (e.createdAt) li.append(h('div', { class: 'small' }, `claim published ${new Date(e.createdAt * 1000).toLocaleString()}`));
  return li;
}

export function badgePanel(badge: Badge): HTMLElement {
  // badges arrive through messaging as copies, so compare by content rather than identity
  const p = badge.primary;
  const isPrimary = (e: BadgeEntry) => !!p && e.source === p.source && e.pubkey === p.pubkey && e.address === p.address && e.tweetId === p.tweetId;
  const list = h('ul', { class: 'sources' }, ...badge.entries.map((e) => entryLine(badge.handle, e, isPrimary(e))));
  return h(
    'details',
    { class: 'source-panel', open: badge.differ },
    h('summary', { textContent: `Sources (${badge.entries.length})` }),
    list,
    h('div', { class: 'small' }, 'This shows addresses the account published. XMRadar never sends or holds funds.'),
  );
}

function sourcePanel(id: ResolvedIdentity): HTMLElement {
  const list = h('ul', { class: 'sources' });
  // xmr.bio doesn't say how the X account was proven or expose the proof tweet yet (K2), so it can't be re-checked
  list.append(h('li', {}, `X account @${id.handle} proven to xmr.bio on ${fmtDate(id.verifiedAt)} (method not disclosed, not re-checkable).`));
  for (const p of id.proofs) {
    const label = PROOF_LABELS.get(p.type) ?? p.type;
    const url = p.type === 'nostr' ? links.njump(p.identifier) : null;
    const ident = url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', textContent: p.identifier }) : h('span', { textContent: p.identifier });
    list.append(h('li', {}, `${label}: `, ident, ` (linked ${fmtDate(p.verifiedAt)})`));
  }
  const profile = links.xmrbio(id.handle);
  return h(
    'details',
    { class: 'source-panel' },
    h('summary', { textContent: 'Source: xmr.bio (signed)' }),
    list,
    h('div', { class: 'small' }, `Signed by xmr.bio key ${keyFingerprint(id.signedBy)}, resolved ${fmtDate(id.resolvedAt)}.`),
    h('div', { class: 'small' }, 'This shows the address the account published. XMRadar never sends or holds funds.'),
    profile ? h('a', { href: profile, target: '_blank', rel: 'noopener noreferrer', textContent: 'View on xmr.bio' }) : '',
  );
}
