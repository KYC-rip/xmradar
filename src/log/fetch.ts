/**
 * Getting the letter in the content script (PLAN-LOG §3, step 2 note): one request to the order page's
 * own origin, with the page's cookies (0trace and Bitania serve the letter only to the order's
 * session), no redirects, 10 s, a bounded body. Or, without a URL, the letter the page shows or the
 * user copies. Nothing here is trusted: the background verifies whatever it gets.
 */

export const FETCH_TIMEOUT_MS = 10_000;
/** an HTML page around the letter (SageSwap) is larger than the letter itself */
export const MAX_FETCH_BYTES = 256 * 1024;

const PGP_BEGIN = '-----BEGIN PGP SIGNED MESSAGE-----';
const PGP_BLOCK_RE = /-----BEGIN PGP SIGNED MESSAGE-----[\s\S]*?-----END PGP SIGNATURE-----/g;
const MISTPROOF_MARK = 'mistex-receipt/1';

export type FetchResult = { ok: true; text: string } | { ok: false; why: string };

async function boundedText(res: Response, max: number): Promise<string> {
  if (Number(res.headers.get('content-length')) > max) throw new Error('too large');
  const reader = res.body?.getReader();
  if (!reader) return (await res.text()).slice(0, max);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new Error('too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(out);
}

/** The letter from an HTML page: the text of the first `<pre>` holding a clear-signed block. */
export function letterFromHtml(html: string): string | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const pre of doc.querySelectorAll('pre')) if (pre.textContent?.includes(PGP_BEGIN)) return pre.textContent;
  return null;
}

/**
 * Fetches `url`, which must be on `pageOrigin`. `fetchFn` is the page-context fetch where the browser
 * has one (Firefox's `content.fetch`), so the request carries the page's cookies.
 */
export async function fetchLetter(url: string, pageOrigin: string, fetchFn: typeof fetch = fetch, signal?: AbortSignal): Promise<FetchResult> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, why: 'bad URL' };
  }
  if (u.origin !== pageOrigin) return { ok: false, why: 'not on this site' };
  let res: Response;
  try {
    res = await fetchFn(u.href, { credentials: 'include', redirect: 'error', cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) : AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    return { ok: false, why: (e as Error).name === 'TimeoutError' ? 'timed out' : 'no answer' };
  }
  // redirect: 'error' already refuses one; the final URL must still be this site
  if (res.url && new URL(res.url).origin !== pageOrigin) return { ok: false, why: 'moved to another site' };
  if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
  let body: string;
  try {
    body = await boundedText(res, MAX_FETCH_BYTES);
  } catch {
    return { ok: false, why: 'too large' };
  }
  if (/^text\/html\b/i.test(res.headers.get('content-type') ?? '')) {
    const text = letterFromHtml(body);
    return text ? { ok: true, text } : { ok: false, why: 'no letter in the page' };
  }
  return { ok: true, text: body };
}

/** The end of the JSON object starting at `from`, string-aware; -1 if it doesn't close within `max`. */
function objectEnd(text: string, from: number, max: number): number {
  let depth = 0;
  let inString = false;
  for (let i = from; i < text.length && i - from < max; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

const MAX_JSON = 16 * 1024;

/**
 * A letter in text the page shows or the user copied: its clear-signed blocks (joined, in order), or
 * the MistProof JSON object around `"format":"mistex-receipt/1"`. Null if there is none.
 */
export function letterInText(text: string): string | null {
  if (text.includes(PGP_BEGIN)) {
    const blocks = text.match(PGP_BLOCK_RE);
    if (blocks) return blocks.join('\n\n');
  }
  const mark = text.indexOf(MISTPROOF_MARK);
  if (mark < 0) return null;
  // the object that holds the mark: try each `{` before it, nearest first
  for (let start = text.lastIndexOf('{', mark), tries = 0; start >= 0 && mark - start < MAX_JSON && tries < 32; start = text.lastIndexOf('{', start - 1), tries++) {
    const end = objectEnd(text, start, MAX_JSON);
    if (end < mark) continue;
    try {
      const o = JSON.parse(text.slice(start, end)) as { format?: unknown };
      if (o && o.format === MISTPROOF_MARK) return text.slice(start, end);
    } catch {
      // not this one
    }
  }
  return null;
}
