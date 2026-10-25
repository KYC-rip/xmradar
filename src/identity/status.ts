import { decode } from 'nostr-tools/nip19';
import { storage } from 'wxt/utils/storage';
import type { IdentityProof } from './envelope';
import type { SetupStatus } from '../messaging';

/** Written by the background after every status check; the options page and the popup render it on open. */
export const setupStatusLast = storage.defineItem<{ at: number; status: SetupStatus } | null>('session:setupStatusLast', { fallback: null });

export interface StatusLine {
  text: string;
  kind: 'ok' | 'warn' | '';
}

/** xmr.bio holds a nostr proof for this pubkey (stored as an npub today; hex accepted too). */
export function xmrbioLinked(proofs: IdentityProof[], pubkey: string): boolean {
  const hexOf = (id: string) => {
    const v = id.trim();
    if (/^[0-9a-f]{64}$/i.test(v)) return v.toLowerCase();
    try {
      const d = decode(v);
      return d.type === 'npub' ? d.data : null;
    } catch {
      return null;
    }
  };
  return proofs.some((p) => p.type === 'nostr' && hexOf(p.identifier) === pubkey.toLowerCase());
}

const short = (a: string) => `${a.slice(0, 10)}…${a.slice(-8)}`;

/**
 * The identity status as text, both sources side by side (PLAN-POPUP §7): what Nostr holds,
 * what xmr.bio holds, whether they agree, and where a badge would come from.
 * `handle` is the confirmed X handle, or null.
 */
export function statusLines(s: SetupStatus, handle: string | null): StatusLine[] {
  const out: StatusLine[] = [];
  const addr = s.address;
  out.push(
    !addr
      ? { text: 'Nostr address: not published', kind: '' }
      : addr.check.ok
        ? { text: `Nostr address: ${short(addr.address)}`, kind: 'ok' }
        : { text: `Nostr address: invalid (${addr.check.reason})`, kind: 'warn' },
  );

  const link = s.link;
  const nostrLinked = link?.proof.status === 'verified';
  if (!handle) out.push({ text: 'Nostr X link: confirm your handle first', kind: '' });
  else if (!link) out.push({ text: `Nostr X link: @${handle} is not linked`, kind: '' });
  else if (link.proof.status === 'verified') out.push({ text: `Nostr X link: @${link.handle}`, kind: 'ok' });
  else if (link.proof.status === 'error') out.push({ text: `Nostr X link: X couldn't be reached to check the tweet (${link.proof.reason})`, kind: 'warn' });
  else out.push({ text: `Nostr X link: the proof tweet fails (${link.proof.reason})`, kind: 'warn' });

  const bio = s.xmrbio;
  const bioOk = bio?.found === true && bio.check.ok;
  if (bio && handle) {
    if (bio.found === 'error') out.push({ text: `xmr.bio: couldn't check (${bio.reason})`, kind: 'warn' });
    else if (!bio.found) out.push({ text: `xmr.bio: @${handle} isn't verified there`, kind: '' });
    else if (!bio.check.ok) out.push({ text: `xmr.bio: @${handle} verified, but its address is invalid (${bio.check.reason})`, kind: 'warn' });
    else out.push({ text: `xmr.bio: @${handle} verified, ${short(bio.address)}, ${bio.linked ? 'linked to this key' : 'not linked to this key'}`, kind: bio.linked ? 'ok' : '' });
  }

  const nostrOk = !!addr?.check.ok && nostrLinked;
  if (bio?.found === true && bioOk && addr?.check.ok && bio.address !== addr.address) {
    out.push({ text: 'Your xmr.bio and Nostr addresses differ. Badges show the xmr.bio one and note the difference.', kind: 'warn' });
  }

  if (bioOk) {
    out.push({ text: 'Badge: from xmr.bio once XMRadar reads its directory (live from 3 Nov). Until then, right-click → "Tip with Monero" finds it.', kind: 'ok' });
    if (nostrOk) out.push({ text: 'Also live now for XMRadar users with Nostr discovery on.', kind: 'ok' });
  } else if (nostrOk) {
    out.push({ text: 'Badge: live for XMRadar users with Nostr discovery on.', kind: 'ok' });
  } else {
    out.push({ text: 'Badge: not yet. Publish an address and link your X account here, or verify on xmr.bio.', kind: '' });
  }

  out.push(
    s.unreadable.length
      ? { text: `Read ${s.relays.length} relays; couldn't read ${s.unreadable.join(', ')}.`, kind: 'warn' }
      : { text: `Read ${s.relays.length} relays.`, kind: '' },
  );
  return out;
}

export function ago(at: number, now = Date.now()): string {
  const min = Math.round((now - at) / 60_000);
  return min < 1 ? 'just now' : min < 120 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
}
