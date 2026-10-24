import { decode as nip19Decode } from 'nostr-tools/nip19';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root';
import { HANDLE_RE, normalizeHandle, toTimestamp, type ResolvedIdentity } from '../../identity/envelope';
import { sendToBackground } from '../../messaging';
import { isValidAmount, moneroUri, type AddressCheck } from '../../xmr/address';
import { qrPath } from '../../xmr/qr';
import { h, trapFocus } from './dom';

const SVG_NS = 'http://www.w3.org/2000/svg';

let open = false;

const fmtDate = (s: string) => {
  const t = toTimestamp(s);
  return Number.isNaN(t) ? s : new Date(t).toLocaleString();
};

const keyFingerprint = (key: string) => `${key.slice(0, 8)}…${key.slice(-8)}`;

/** Only allowlisted link templates, each value validated before it goes into the URL. */
const links = {
  xmrbio: (handle: string) => (HANDLE_RE.test(handle) ? `https://xmr.bio/${handle}` : null),
  njump: (npub: string) => {
    try {
      return nip19Decode(npub).type === 'npub' ? `https://njump.me/${npub}` : null;
    } catch {
      return null;
    }
  },
};

const PROOF_LABELS = new Map([['nostr', 'Nostr'], ['x-post', 'X post'], ['agent-key', 'Agent key']]);

function qrSvg(text: string): SVGSVGElement {
  const { size, d } = qrPath(text);
  const pad = 4;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `${-pad} ${-pad} ${size + pad * 2} ${size + pad * 2}`);
  svg.setAttribute('class', 'qr');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'QR code of the Monero payment link');
  svg.setAttribute('shape-rendering', 'crispEdges');
  const bg = document.createElementNS(SVG_NS, 'rect');
  for (const [k, v] of Object.entries({ x: -pad, y: -pad, width: size + pad * 2, height: size + pad * 2, fill: '#fff' })) bg.setAttribute(k, String(v));
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000');
  svg.append(bg, path);
  return svg;
}

export async function openTip(ctx: ContentScriptContext, handle: string | null) {
  if (open) return;
  open = true;
  try {
    await mountTip(ctx, handle);
  } catch (e) {
    open = false;
    window.alert(`XMRadar: ${(e as Error).message}`);
  }
}

async function mountTip(ctx: ContentScriptContext, detected: string | null) {
  const previousFocus = document.activeElement as HTMLElement | null;
  let closed = false;

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
        result.replaceChildren();
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
          result.replaceChildren(renderIdentity(res.identity, res.check));
        } catch (e) {
          setStatus(`Could not check xmr.bio: ${(e as Error).message}`, 'error');
        } finally {
          busy = false;
          lookupBtn.disabled = false;
        }
      };
      lookupBtn.addEventListener('click', () => void lookup());
      handleInput.addEventListener('keydown', (e) => e.key === 'Enter' && void lookup());

      // the menu item itself says "look up on xmr.bio", so a detected handle is checked right away
      if (detected) void lookup();
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
  const wrap = h('div', { class: 'tip' });
  const addrBox = h('code', { class: 'addr', textContent: id.address });

  if (!check.ok) {
    wrap.append(h('div', { class: 'warn' }, `xmr.bio lists an invalid address for this account (${check.reason}). Don't send to it.`), addrBox);
  } else {
    const copyBtn = h('button', { textContent: 'Copy address' });
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(id.address).then(
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
      const uri = moneroUri(id.address, { amount: value || undefined });
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
      amountErr,
      h('div', { class: 'row' }, walletLink),
    );
  }

  wrap.append(sourcePanel(id));
  return wrap;
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
