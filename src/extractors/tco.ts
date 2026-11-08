/**
 * X's t.co short links made their destinations. A link X shows as a card has only its t.co address on the
 * page, so the copy would carry a link the reader can't see through. t.co tells a browser the destination
 * in its own page (title and refresh), so it's read from there with redirects off: the destination site is
 * never contacted, and no cookie goes to t.co.
 */

/** A t.co link as it appears in text or a card's href. */
export const TCO = /https:\/\/t\.co\/([A-Za-z0-9]{4,16})\b/g;
const CODE = /^[A-Za-z0-9]{4,16}$/;
const PAGE_MAX = 64 * 1024;
const TIMEOUT_MS = 3_000;

const httpUrl = (raw: string | undefined): string | null => {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return null;
    // another t.co link is no better than the one we had
    return u.hostname === 't.co' ? null : u.toString();
  } catch {
    return null;
  }
};

const unescapeHtml = (s: string) =>
  s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|amp|quot|apos|lt|gt);/gi, (_, e: string) => {
    const named: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
    if (e[0] !== '#') return named[e.toLowerCase()]!;
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  });

/** The destination in t.co's own page: the refresh target, else the title; both must agree when both are there. */
export function tcoDestination(html: string): string | null {
  const refresh = /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']\s*\d+\s*;\s*url=([^"'>]+)["']/i.exec(html)?.[1];
  const title = /<title>([^<]{1,4096})<\/title>/i.exec(html)?.[1];
  const a = httpUrl(refresh && unescapeHtml(refresh));
  const b = httpUrl(title && unescapeHtml(title));
  if (a && b && a !== b) return null;
  return a ?? b;
}

/** At most PAGE_MAX of the body (the destination is in the first few hundred bytes). */
async function headOf(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return (await res.text()).slice(0, PAGE_MAX);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < PAGE_MAX) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    size += value.byteLength;
  }
  void reader.cancel().catch(() => {});
  const all = new Uint8Array(Math.min(size, PAGE_MAX));
  let at = 0;
  for (const c of chunks) {
    const part = c.subarray(0, all.length - at);
    all.set(part, at);
    at += part.length;
    if (at >= all.length) break;
  }
  return new TextDecoder().decode(all);
}

/** One t.co code's destination, or null (not found, slow, or t.co answered with a redirect we don't follow). */
export async function resolveTco(code: string, fetchFn: typeof fetch = fetch): Promise<string | null> {
  if (!CODE.test(code)) return null;
  try {
    const res = await fetchFn(`https://t.co/${code}`, {
      credentials: 'omit',
      redirect: 'manual',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok || res.type === 'opaqueredirect') return null;
    if (Number(res.headers.get('content-length')) > PAGE_MAX) return null;
    return tcoDestination(await headOf(res));
  } catch {
    return null;
  }
}

/** The codes of the t.co links in a text, each once, at most `max`. */
export function tcoCodes(text: string, max = 10): string[] {
  return [...new Set([...text.matchAll(TCO)].map((m) => m[1]!))].slice(0, max);
}

/**
 * The text with each resolved t.co link made its destination. A destination already written out in the
 * text (the tweet named it and X also drew its card), or one an earlier t.co link became, isn't repeated:
 * that link goes, with its line if it stood alone. Unresolved ones stay. Links are compared whole, so
 * `https://a.example` isn't taken for `https://a.example/page`.
 */
export function expandTco(text: string, found: Record<string, string | null>): string {
  const URLS = /https?:\/\/[^\s<>"'`]+/g;
  // as written in prose (no trailing punctuation), in the form URL gives it (`https://a.example` → `…/`)
  const trim = (u: string) => {
    const bare = u.replace(/[.,;:!?)\]'"’”]+$/, '');
    try {
      return new URL(bare).toString();
    } catch {
      return bare;
    }
  };
  const have = new Set([...text.matchAll(URLS)].map((m) => trim(m[0])).filter((u) => !/^https:\/\/t\.co\//.test(u)));
  const out: string[] = [];
  for (const line of text.split('\n')) {
    let dropped = false;
    const next = line.replace(TCO, (whole, code: string) => {
      const dest = found[code];
      if (!dest) return whole;
      if (have.has(dest)) {
        dropped = true;
        return '';
      }
      have.add(dest);
      return dest;
    });
    // a line that was only the dropped link goes with it
    if (dropped && !next.trim()) continue;
    out.push(dropped ? next.replace(/[ \t]{2,}/g, ' ').trimEnd() : next);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '');
}
