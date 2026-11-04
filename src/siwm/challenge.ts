import { validateMoneroAddress } from '../xmr/address';

/**
 * NKIP-0003 Sign-In with Monero, the wallet's checks (PLAN-SIWM): the challenge URI parsed with every v1
 * rule, and the message built from it byte for byte. XMRadar signs nothing; the user's wallet does.
 */

export interface Challenge {
  address: string;
  nonce: string;
  session: string;
  origin: string;
  purpose: string;
  handle: string;
  dk: string;
  issued_at: string;
  expires_at: string;
  return_url: string;
  v: '1';
}

export type Parsed = { ok: true; c: Challenge } | { ok: false; reason: string };

const REQUIRED = ['address', 'nonce', 'session', 'origin', 'handle', 'dk', 'issued_at', 'expires_at', 'return_url', 'v'] as const;
const ALLOWED = new Set<string>([...REQUIRED, 'purpose']);

const CTRL = /[\u0000-\u001f\u007f]/;
const ADDRESS = /^[48][1-9A-HJ-NP-Za-km-z]{94}$/;
const NONCE = /^[A-Za-z0-9_-]{22,128}$/;
const SESSION = /^[A-Za-z0-9_-]{1,128}$/;
const ORIGIN = /^[a-z0-9.-]+(?::(\d{1,5}))?$/;
const PURPOSE = /^[a-z0-9_-]{1,32}$/;
const DK = /^[0-9a-f]{16}$/;
const TIME = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(\.\d{1,3})?Z$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_WINDOW_MS = 15 * 60_000;

/**
 * Unicode's Default_Ignorable_Code_Point (DerivedCoreProperties, stable since Unicode 6), in full: the
 * reference checker's shorter list misses some (soft hyphen, tags, musical formatting).
 */
const DEFAULT_IGNORABLE: [number, number][] = [
  [0x00ad, 0x00ad], [0x034f, 0x034f], [0x061c, 0x061c], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f],
  [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff],
  [0xffa0, 0xffa0], [0xfff0, 0xfff8], [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a], [0xe0000, 0xe0fff],
];
/** letters that render blank */
const BLANK = new Set([0x115f, 0x1160, 0x3164, 0xffa0, 0x2800]);
const OTHER_OR_SEPARATOR = /[\p{C}\p{Z}]/u;

function handleOk(h: string): boolean {
  const points = [...h];
  if (points.length < 1 || points.length > 64) return false;
  return points.every((ch) => {
    const o = ch.codePointAt(0)!;
    return !OTHER_OR_SEPARATOR.test(ch) && !BLANK.has(o) && !DEFAULT_IGNORABLE.some(([a, b]) => o >= a && o <= b);
  });
}

/** ms since the epoch for a v1 time string, or null; impossible dates (Feb 30) are refused */
function timeOf(s: string): number | null {
  const m = TIME.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const t = Date.UTC(y, mo - 1, d, h, mi, se) + (m[7] ? Math.round(Number(m[7]) * 1000) : 0);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || h > 23 || mi > 59 || se > 59) return null;
  return t;
}

function returnUrlOk(raw: string): boolean {
  if (raw.includes('#')) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username || u.password || /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(raw)) return false;
  if (!u.hostname) return false;
  return u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname));
}

/** form-urlencoded decoding (`+` is a space); null on a broken escape */
function decode(s: string): string | null {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

export function parseChallenge(uri: string): Parsed {
  const no = (reason: string): Parsed => ({ ok: false, reason });
  const m = /^monero-signin:(.*)$/is.exec(uri.trim());
  if (!m) return no('not a monero-signin link');
  let rest = m[1]!;
  if (rest.startsWith('//')) return no('monero-signin:// is not a sign-in link');
  if (rest.startsWith('?')) rest = rest.slice(1);
  const p = new Map<string, string>();
  for (const part of rest.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const k = decode(eq < 0 ? part : part.slice(0, eq));
    const v = decode(eq < 0 ? '' : part.slice(eq + 1));
    if (k === null || v === null) return no('a value is not properly encoded');
    if (p.has(k)) return no(`${k} appears twice`);
    if (!ALLOWED.has(k)) return no(`unknown parameter ${k}`);
    p.set(k, v);
  }
  if (p.get('v') !== '1') return no('not version 1');
  if (p.has('purpose') && !p.get('purpose')) return no('purpose is empty');
  if (!p.has('purpose')) p.set('purpose', 'login');
  for (const k of [...REQUIRED, 'purpose']) {
    const v = p.get(k);
    if (!v) return no(`${k} is missing`);
    if (CTRL.test(v)) return no(`control character in ${k}`);
  }
  const g = (k: string) => p.get(k)!;
  const origin = ORIGIN.exec(g('origin'));
  if (!origin || (origin[1] !== undefined && (Number(origin[1]) < 1 || Number(origin[1]) > 65535))) return no('origin is not a bare host');
  if (!DK.test(g('dk'))) return no('dk is not 16 lowercase hex characters');
  const addr = ADDRESS.test(g('address')) ? validateMoneroAddress(g('address')) : null;
  if (!addr?.ok || addr.type === 'integrated') return no('address is not a valid mainnet standard address or subaddress');
  if (!NONCE.test(g('nonce'))) return no('nonce is not 22–128 characters of A–Z, a–z, 0–9, _ or -');
  if (!SESSION.test(g('session'))) return no('session is not 1–128 characters of A–Z, a–z, 0–9, _ or -');
  if (!PURPOSE.test(g('purpose'))) return no('purpose is not 1–32 characters of a–z, 0–9, _ or -');
  if (g('handle').normalize('NFC') !== g('handle')) return no('handle is not in NFC form');
  if (!handleOk(g('handle'))) return no('handle has invisible, spacing or direction characters, or is too long');
  if (!returnUrlOk(g('return_url'))) return no('return_url must be https (http only to this computer), without user info or #');
  const iat = timeOf(g('issued_at'));
  const exp = timeOf(g('expires_at'));
  if (iat === null || exp === null) return no('a time is not in the YYYY-MM-DDTHH:MM:SSZ form');
  if (!(iat < exp && exp <= iat + MAX_WINDOW_MS)) return no('the time window must be more than 0 and at most 15 minutes');
  return {
    ok: true,
    c: {
      address: g('address'),
      nonce: g('nonce'),
      session: g('session'),
      origin: g('origin'),
      purpose: g('purpose'),
      handle: g('handle'),
      dk: g('dk'),
      issued_at: g('issued_at'),
      expires_at: g('expires_at'),
      return_url: g('return_url'),
      v: '1',
    },
  };
}

/** The v1 message: LF-joined, no trailing newline. */
export const canonicalMessage = (c: Challenge) =>
  [
    `${c.origin} wants you to sign in with your Monero address:`,
    c.address,
    '',
    `Sign in to ${c.origin} as @${c.handle}. This proves you control this address. No funds move.`,
    '',
    `Purpose: ${c.purpose}`,
    `Handle: ${c.handle}`,
    `Nonce: ${c.nonce}`,
    `Device-Key: ${c.dk}`,
    `Issued-At: ${c.issued_at}`,
    `Expiration-Time: ${c.expires_at}`,
    'Version: 1',
  ].join('\n');

/** Expired, or issued more than 5 minutes ahead of this clock (the verifier's clock decides; this catches mistakes). */
export function timely(c: Challenge, now: number): 'ok' | 'expired' | 'future' {
  if (timeOf(c.expires_at)! <= now) return 'expired';
  if (timeOf(c.issued_at)! > now + 5 * 60_000) return 'future';
  return 'ok';
}

export const expiresAt = (c: Challenge) => timeOf(c.expires_at)!;

export const callbackHost = (c: Challenge) => new URL(c.return_url).host;
