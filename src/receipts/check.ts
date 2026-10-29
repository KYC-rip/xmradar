import { fetchManifest, fetchPolicy } from './fetch';
import { issuerMatchesPage } from './guards';
import { saveReceipt, type ReceiptStore, type SavedReceipt } from './store';
import { commitment, keyFor, linkableV1, readReceipt, receiptSigValid, unsaltedPublicDeposit, type Manifest, type Receipt } from './verify';

/**
 * The order-page check in the background (PLAN-NKIP01 §1.1, §2, §3, §12): from the receipt text a page
 * carries to the card's lines, saving the receipt locally. It contacts only the issuer's own host (the
 * page the user has open), never a relay (§12: no public-record lookup from the order page).
 */

export const MAX_RECEIPT_TEXT = 64 * 1024;

export type Level = 'ok' | 'caution' | 'warn' | 'off';
export interface Line {
  level: Level;
  text: string;
}

export interface PageCheck {
  receipt?: Receipt;
  commitment?: string;
  /** Signed, Expiry and, where they apply, the receipt-format and policy lines */
  lines: Line[];
  saved: boolean;
  /** "Couldn't save this receipt (browser storage full)" and the like */
  saveError?: string;
}

export interface CheckDeps {
  store: ReceiptStore;
  /** may XMRadar read this https origin? (Firefox grants host access separately) */
  hasAccess: (origin: string) => Promise<boolean>;
  fetch?: typeof fetch;
  /** ms */
  now?: () => number;
}

const time = (secs: number) => new Date(secs * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function signedLine(r: Receipt, m: Manifest): Line {
  const key = keyFor(m, r.key_id, r.created_at);
  switch (key.status) {
    case 'unknown':
      return { level: 'warn', text: `Signed with a key ${r.issuer} doesn't list. Don't deposit.` };
    case 'bad-key':
      return { level: 'warn', text: `${r.issuer}'s manifest lists this key wrongly. Don't deposit.` };
    case 'unrotated':
      return { level: 'warn', text: `Signed with a new key ${r.issuer} hasn't signed over from its old one. Don't trust it yet.` };
    case 'not-yet':
      return { level: 'warn', text: 'Signed before its key was valid. Don’t deposit.' };
    case 'revoked':
      return { level: 'warn', text: `Signed with a key ${r.issuer} revoked before this order. Don't deposit.` };
  }
  if (!receiptSigValid(r, key.publicKey)) return { level: 'warn', text: 'The signature doesn’t match this receipt: it was changed after signing. Don’t deposit.' };
  if (key.status === 'revoked-later') return { level: 'caution', text: `Signed by ${r.issuer}, with a key it revoked later; its public log wasn't checked.` };
  return { level: 'ok', text: `Signed by ${r.issuer}` };
}

/**
 * Check one receipt found on the page at `pageUrl` (the sender's top-frame URL, never the message's).
 * `eventId` is the attestation id the page showed next to the address, kept for the later check (§12.1).
 */
export async function checkPageReceipt(text: string, pageUrl: string, deps: CheckDeps, opts: { eventId?: string } = {}): Promise<PageCheck> {
  const now = (deps.now ?? Date.now)();
  if (text.length > MAX_RECEIPT_TEXT) return { lines: [{ level: 'caution', text: 'This page has a receipt too large to check, so XMRadar didn\'t check it.' }], saved: false };
  const parsed = readReceipt(text);
  if ('error' in parsed) return { lines: [{ level: 'caution', text: `This page has a receipt XMRadar can't read (${parsed.error}), so it wasn't checked.` }], saved: false };
  const r = parsed.receipt;
  const c = commitment(r);
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return { lines: [{ level: 'warn', text: 'This page’s address can’t be read; receipt not checked.' }], saved: false };
  }
  const lines: Line[] = [];
  let manifest: Manifest | undefined;
  const access = await deps.hasAccess(`https://${r.issuer}`).catch(() => false);

  if (page.protocol !== 'https:') lines.push({ level: 'warn', text: 'Page not secure: receipt not checked.' });
  else if (!issuerMatchesPage(r.issuer, pageUrl)) lines.push({ level: 'warn', text: `Receipt is for ${r.issuer}, but this page is ${page.hostname}. Not checked.` });
  else if (!access) lines.push({ level: 'caution', text: 'XMRadar needs access to this site to check the receipt.' });
  else {
    try {
      manifest = await fetchManifest(r.issuer, deps.fetch);
      lines.push(signedLine(r, manifest));
    } catch (e) {
      lines.push({ level: 'caution', text: `Manifest unreachable: signature not checked (${(e as Error).message}).` });
    }
  }

  // R16, and the old format's linkability
  if (unsaltedPublicDeposit(r))
    lines.push({ level: 'warn', text: `Unsalted receipt for a ${r.deposit_asset} deposit: the exchange broke NKIP-0001 R16, and your payout address can be linked to this deposit.` });
  else if (linkableV1(r)) lines.push({ level: 'caution', text: 'Old receipt format: anyone who knows your payout address can link it to this deposit.' });

  lines.push(
    now / 1000 < r.expires_at
      ? { level: 'ok', text: `Valid until ${time(r.expires_at)}` }
      : { level: 'warn', text: `Expired at ${time(r.expires_at)}. Don't deposit to this address now; check the exchange's policy.` },
  );

  // the policy text is archived once per hash; a mismatch is only a caution, the receipt still stands
  if (manifest && !(await deps.store.getPolicy(r.policy_hash).catch(() => null))) {
    try {
      const p = await fetchPolicy(manifest, r.policy_hash, deps.fetch);
      if (p.matches) await deps.store.putPolicy(r.policy_hash, p.bytes);
      else lines.push({ level: 'caution', text: 'The policy the exchange serves doesn’t match the one this receipt names.' });
    } catch (e) {
      lines.push({ level: 'caution', text: `Policy not archived (${(e as Error).message}).` });
    }
  }

  // R18: a reused XMR payout address links this swap to the earlier one (never this receipt itself)
  if (r.payout_asset.toUpperCase() === 'XMR') {
    const saved = await deps.store.list().catch(() => [] as SavedReceipt[]);
    const before = saved.find((s) => s.commitment !== c && s.receipt.payout_address === r.payout_address);
    if (before) lines.push({ level: 'caution', text: `You've used this payout address before (order ${before.receipt.order_id}). A fresh subaddress per swap keeps orders unlinkable.` });
  }

  try {
    const eventId = opts.eventId && /^[0-9a-f]{64}$/.test(opts.eventId) ? opts.eventId : undefined;
    await saveReceipt(deps.store, { commitment: c, receipt: r, page: page.origin + page.pathname, savedAt: now, ...(manifest ? { manifest } : {}), ...(eventId ? { eventId } : {}) }, Math.floor(now / 1000));
    return { receipt: r, commitment: c, lines, saved: true };
  } catch (e) {
    const quota = (e as Error)?.name === 'QuotaExceededError';
    return { receipt: r, commitment: c, lines, saved: false, saveError: quota ? 'Couldn’t save this receipt (browser storage full).' : `Couldn’t save this receipt (${(e as Error).message}).` };
  }
}
