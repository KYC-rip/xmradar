import { MISTPROOF_MARK, PGP_BEGIN } from "./fetch";

/**
 * Letters of guarantee behind a download link (PLAN-LOGLINK): DEX.fo puts its signed message only in
 * `<a download="receipt.asc" href="data:application/pgp-keys,…">`. Only `data:` links are read (nothing is
 * fetched); at most MAX_LINKS of them (the first in page order, so more `data:` links than that before a letter hide it), each at most MAX_HREF characters; a text kind only; kept when it holds a
 * letter's marker. The background still checks the letter against xmr.club's key.
 */

export const MAX_LINKS = 5;
export const MAX_HREF = 64 * 1024;
const TYPE_OK =
  /^(?:text\/[a-z0-9.+-]+|application\/(?:pgp-[a-z0-9.+-]+|octet-stream|json|[a-z0-9.-]+\+json))?$/;

/** The text of one `data:` URL, or null: not data, a kind that isn't text, too long, or undecodable. */
export function decodeDataUrl(href: string): string | null {
  if (href.length > MAX_HREF || !/^data:/i.test(href)) return null;
  const comma = href.indexOf(",");
  if (comma < 0) return null;
  const [type = "", ...params] = href
    .slice(5, comma)
    .split(";")
    .map((p) => p.trim().toLowerCase());
  if (!TYPE_OK.test(type)) return null;
  const body = href.slice(comma + 1);
  try {
    if (params.includes("base64")) {
      const bin = atob(body.replace(/\s+/g, ""));
      return new TextDecoder("utf-8").decode(
        Uint8Array.from(bin, (c) => c.charCodeAt(0)),
      );
    }
    return decodeURIComponent(body);
  } catch {
    return null;
  }
}

/** Decoded once per href; only the links the page has now are kept, so it never holds more than MAX_LINKS. */
const decoded = new Map<string, string | null>();

/** Letters in the page's `data:` links, in page order. */
export function dataLinkLetters(doc: Document = document): string[] {
  const hrefs: string[] = [];
  for (const a of doc.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") ?? "";
    if (!/^\s*data:/i.test(href)) continue;
    hrefs.push(href.trim());
    if (hrefs.length >= MAX_LINKS) break;
  }
  for (const k of [...decoded.keys()])
    if (!hrefs.includes(k)) decoded.delete(k);
  const out: string[] = [];
  for (const href of hrefs) {
    if (!decoded.has(href)) {
      const text = decodeDataUrl(href);
      decoded.set(
        href,
        text && (text.includes(PGP_BEGIN) || text.includes(MISTPROOF_MARK))
          ? text
          : null,
      );
    }
    const t = decoded.get(href);
    if (t) out.push(t);
  }
  return out;
}

/** Receipts stopped: let go of the decoded texts at once. */
export const resetDataLinks = () => decoded.clear();
