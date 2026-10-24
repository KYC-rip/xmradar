import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it, vi } from 'vitest';
import { renderIdentity } from '../src/entrypoints/content/tip';
import {
  checkResolveFreshness,
  parseResolvedIdentity,
  PINNED_XMRBIO_KEYS,
  RESOLVE_MAX_AGE_MS,
  toTimestamp,
  verifySignedEnvelope,
  type ResolvedIdentity,
} from '../src/identity/envelope';
import { handleFromTarget } from '../src/identity/x-handle';
import { resolveXmrbio } from '../src/identity/xmrbio';
import { isXUrl } from '../src/sender';
import { makeDoc } from './helpers';

// recorded from the live API, signed by the real xmr.bio key
const REAL = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/xmrbio-resolve-xbtoshi.json'), 'utf8'));
const REAL_AT = Date.parse(JSON.parse(REAL.payload).resolved_at);
const [PINNED] = PINNED_XMRBIO_KEYS;

function signWith(secret: Uint8Array, payload: object) {
  const json = JSON.stringify(payload);
  return {
    payload: json,
    signature: bytesToHex(ed25519.sign(new TextEncoder().encode(json), secret)),
    public_key: bytesToHex(ed25519.getPublicKey(secret)),
    alg: 'ed25519',
  };
}

describe('pinned keys', () => {
  it('is a non-empty set of full 32-byte hex keys', () => {
    expect(PINNED_XMRBIO_KEYS.size).toBeGreaterThan(0);
    for (const k of PINNED_XMRBIO_KEYS) expect(k).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('verifySignedEnvelope', () => {
  it('accepts a real xmr.bio response', () => {
    const { data, key } = verifySignedEnvelope(REAL, PINNED_XMRBIO_KEYS);
    expect(key).toBe(PINNED);
    expect((data as { handle: string }).handle).toBe('xbtoshi');
  });

  it('rejects a tampered payload or signature', () => {
    const payload = REAL.payload.replace(REAL.payload.match(/"address":"(\w+)"/)[1], 'x'.repeat(95));
    expect(() => verifySignedEnvelope({ ...REAL, payload }, PINNED_XMRBIO_KEYS)).toThrow(/Bad signature/);
    const signature = `${REAL.signature.slice(0, -2)}${REAL.signature.endsWith('00') ? '01' : '00'}`;
    expect(() => verifySignedEnvelope({ ...REAL, signature }, PINNED_XMRBIO_KEYS)).toThrow(/Bad signature/);
  });

  it('rejects keys outside the pinned set, and accepts a rotated-in key', () => {
    const secret = ed25519.utils.randomSecretKey();
    const env = signWith(secret, { hello: 1 });
    expect(() => verifySignedEnvelope(env, PINNED_XMRBIO_KEYS)).toThrow(/unknown key/);
    // a valid signature from a pinned key that is claimed under another key fails too
    expect(() => verifySignedEnvelope({ ...REAL, public_key: env.public_key }, PINNED_XMRBIO_KEYS)).toThrow(/unknown key/);
    expect(verifySignedEnvelope(env, new Set([...PINNED_XMRBIO_KEYS, env.public_key])).data).toEqual({ hello: 1 });
  });

  it('rejects malformed envelopes and other algorithms', () => {
    expect(() => verifySignedEnvelope(null, PINNED_XMRBIO_KEYS)).toThrow(/Malformed/);
    expect(() => verifySignedEnvelope({ ...REAL, payload: { a: 1 } }, PINNED_XMRBIO_KEYS)).toThrow(/Malformed/);
    expect(() => verifySignedEnvelope({ ...REAL, alg: 'none' }, PINNED_XMRBIO_KEYS)).toThrow(/algorithm/);
    expect(() => verifySignedEnvelope({ ...REAL, signature: 'zz' }, PINNED_XMRBIO_KEYS)).toThrow(/Malformed/);
  });
});

describe('parseResolvedIdentity', () => {
  it('parses the real payload, including SQLite-style proof timestamps', () => {
    const id = parseResolvedIdentity(JSON.parse(REAL.payload), PINNED!);
    expect(id).toMatchObject({ handle: 'xbtoshi', signedBy: PINNED });
    expect(id.proofs[0]).toMatchObject({ type: 'nostr', identifier: expect.stringMatching(/^npub1/) });
  });

  it('rejects unknown versions and bad handles, and drops malformed proofs', () => {
    const base = JSON.parse(REAL.payload);
    expect(() => parseResolvedIdentity({ ...base, v: 3 }, 'k')).toThrow(/version/);
    expect(() => parseResolvedIdentity({ ...base, handle: '../evil' }, 'k')).toThrow(/handle/);
    expect(parseResolvedIdentity({ ...base, proofs: [{ type: 1 }, null, ...base.proofs] }, 'k').proofs).toHaveLength(1);
  });
});

describe('checkResolveFreshness', () => {
  const id = parseResolvedIdentity(JSON.parse(REAL.payload), PINNED!);
  it('accepts a recent response for the requested handle', () => {
    expect(checkResolveFreshness(id, '@XBToshi', undefined, REAL_AT + 60_000)).toBe(REAL_AT);
  });
  it('rejects old, future, mismatched and replayed responses', () => {
    expect(() => checkResolveFreshness(id, 'xbtoshi', undefined, REAL_AT + RESOLVE_MAX_AGE_MS + 1)).toThrow(/too old/);
    expect(() => checkResolveFreshness(id, 'xbtoshi', undefined, REAL_AT - RESOLVE_MAX_AGE_MS - 1)).toThrow(/future/);
    expect(() => checkResolveFreshness(id, 'someoneelse', undefined, REAL_AT)).toThrow(/different handle/);
    expect(() => checkResolveFreshness(id, 'xbtoshi', REAL_AT + 1, REAL_AT)).toThrow(/older than/);
  });
});

describe('resolveXmrbio', () => {
  const respond = (status: number, body: unknown = {}) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('verifies a real response, validates the address and records the resolution time', async () => {
    const fetchFn = respond(200, REAL);
    const { result, seen } = await resolveXmrbio('@XBToshi', [], { fetch: fetchFn, now: REAL_AT });
    expect(fetchFn).toHaveBeenCalledWith('https://api.kyc.rip/v1/bio/resolve/xbtoshi', expect.objectContaining({ credentials: 'omit' }));
    expect(result).toMatchObject({ found: true, check: { ok: true, type: 'subaddress' } });
    expect(seen).toEqual([['xbtoshi', REAL_AT]]);
  });

  it('rejects a replay of an older response than one already accepted', async () => {
    await expect(resolveXmrbio('xbtoshi', [['xbtoshi', REAL_AT + 5000]], { fetch: respond(200, REAL), now: REAL_AT })).rejects.toThrow(/older than/);
  });

  it('treats prototype-named handles as ordinary keys in the replay guard', async () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const env = signWith(ed25519.utils.randomSecretKey(), { ...JSON.parse(REAL.payload), handle: name });
      const keys = new Set([env.public_key]);
      const h = name.toLowerCase();
      const { seen } = await resolveXmrbio(name, [], { fetch: respond(200, env), now: REAL_AT, keys });
      expect(seen).toEqual([[h, REAL_AT]]);
      await expect(resolveXmrbio(name, [[h, REAL_AT + 1]], { fetch: respond(200, env), now: REAL_AT, keys })).rejects.toThrow(/older than/);
    }
  });

  it('reports a missing profile, and fails on errors or bad signatures', async () => {
    expect((await resolveXmrbio('nobody', [], { fetch: respond(404) })).result).toEqual({ found: false });
    await expect(resolveXmrbio('xbtoshi', [], { fetch: respond(500) })).rejects.toThrow(/500/);
    await expect(resolveXmrbio('xbtoshi', [], { fetch: respond(200, { ...REAL, signature: '0'.repeat(128) }), now: REAL_AT })).rejects.toThrow(/signature/);
    await expect(resolveXmrbio('not a handle!', [], { fetch: respond(200, REAL) })).rejects.toThrow(/handle/);
  });
});

describe('handleFromTarget', () => {
  const tweet = `<article data-testid="tweet"><div data-testid="User-Name"><a href="/xbtoshi">CyberSatoshi</a><a href="/xbtoshi">@xbtoshi</a></div>
    <div data-testid="tweetText" id="t">hello <a href="/fiatjaf" id="mention">@fiatjaf</a></div></article>
    <a href="/jack" id="profile">jack</a><a href="/jack/status/20" id="status">status</a><p id="none">x</p>`;
  const doc = makeDoc('https://x.com/home', tweet);
  const at = (path: string, host = 'x.com') => ({ hostname: host, pathname: path });

  it("uses a right-clicked mention, otherwise the tweet's author", () => {
    expect(handleFromTarget(doc.getElementById('t'), at('/home'))).toBe('xbtoshi');
    expect(handleFromTarget(doc.getElementById('mention'), at('/home'))).toBe('fiatjaf');
  });
  it('uses a bare profile link, then the profile page path', () => {
    expect(handleFromTarget(doc.getElementById('profile'), at('/home'))).toBe('jack');
    expect(handleFromTarget(doc.getElementById('status'), at('/home'))).toBeNull();
    expect(handleFromTarget(doc.getElementById('none'), at('/Monero/with_replies'))).toBe('Monero');
  });
  it('ignores app pages and other sites', () => {
    expect(handleFromTarget(doc.getElementById('none'), at('/explore'))).toBeNull();
    expect(handleFromTarget(doc.getElementById('t'), at('/home', 'evil.com'))).toBeNull();
  });
});

describe('isXUrl', () => {
  it('accepts only https X hosts', () => {
    expect(isXUrl('https://x.com/home')).toBe(true);
    expect(isXUrl('https://mobile.twitter.com/a')).toBe(true);
    expect(isXUrl('http://x.com/')).toBe(false);
    expect(isXUrl('https://x.com.evil.com/')).toBe(false);
    expect(isXUrl(undefined)).toBe(false);
  });
});

describe('toTimestamp', () => {
  it('reads SQLite timestamps (with or without fractions) as UTC', () => {
    expect(toTimestamp('2026-07-08 17:03:45')).toBe(Date.UTC(2026, 6, 8, 17, 3, 45));
    expect(toTimestamp('2026-07-08 17:03:45.123')).toBe(Date.UTC(2026, 6, 8, 17, 3, 45, 123));
    expect(toTimestamp('2026-10-24T06:26:13.224Z')).toBe(Date.UTC(2026, 9, 24, 6, 26, 13, 224));
    expect(toTimestamp('nope')).toBeNaN();
  });
});

describe('renderIdentity', () => {
  const hostile: ResolvedIdentity = {
    handle: 'xbtoshi',
    address: '89fM69NVioz94JQrJFLGPDa8PMpjea7TV8JQktbLBLpX9gKMfrt3dge7KMdqg86coZjCxCm3fn1WKdM8WBMJhEdaUimo8Q3',
    displayName: '<img src=x onerror=alert(1)>',
    verifiedAt: '2025-12-30T12:45:25.669Z',
    resolvedAt: '2026-10-24T06:26:13.224Z',
    signedBy: PINNED!,
    proofs: [
      { type: 'nostr', identifier: '<script>alert(1)</script>', verifiedAt: '"><b>' },
      { type: '<b>x</b>', identifier: 'javascript:alert(1)', verifiedAt: '‮gnp.exe' },
      { type: 'constructor', identifier: 'c', verifiedAt: 'x' },
      { type: 'nostr', identifier: 'npub10hqclu8wc4mhqjem300cep0rpc7f2uunn5h2lcxrx8wp3vmcrq0quj4fln', verifiedAt: '2026-07-08 17:03:45' },
    ],
  };

  it('renders untrusted strings as text and links only from validated templates', () => {
    const el = renderIdentity(hostile, { ok: true, type: 'subaddress' });
    expect(el.querySelector('script, img, b')).toBeNull();
    expect(el.textContent).toContain('<script>alert(1)</script>');
    const hrefs = [...el.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual([
      expect.stringMatching(/^monero:89fM/),
      'https://njump.me/npub10hqclu8wc4mhqjem300cep0rpc7f2uunn5h2lcxrx8wp3vmcrq0quj4fln',
      'https://xmr.bio/xbtoshi',
    ]);
    expect(el.querySelector('svg.qr path')?.getAttribute('d')).toMatch(/^M/);
    expect(el.textContent).toContain('constructor: c');
  });

  it('drops the QR and wallet link while the amount is invalid', () => {
    const el = renderIdentity(hostile, { ok: true, type: 'subaddress' });
    const amount = el.querySelector<HTMLInputElement>('input[aria-label="Amount in XMR"]')!;
    const wallet = () => el.querySelector('a.button')!;
    amount.value = '1e3';
    amount.dispatchEvent(new Event('input'));
    expect(el.querySelector('svg.qr')).toBeNull();
    expect(wallet().getAttribute('href')).toBeNull();
    expect(el.textContent).toContain('Amount must be a number');
    amount.value = '0.5';
    amount.dispatchEvent(new Event('input'));
    expect(wallet().getAttribute('href')).toMatch(/\?tx_amount=0\.5$/);
    expect(el.querySelector('svg.qr')).not.toBeNull();
  });

  it('shows an invalid address as a warning, with no QR or wallet link', () => {
    const el = renderIdentity({ ...hostile, address: 'not-an-address' }, { ok: false, reason: 'wrong length' });
    expect(el.textContent).toContain('invalid address');
    expect(el.textContent).toContain('wrong length');
    expect(el.querySelector('svg.qr, a[href^="monero:"]')).toBeNull();
  });
});
