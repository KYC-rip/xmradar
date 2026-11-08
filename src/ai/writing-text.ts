/** The page-side half of writing help (PLAN-XPROOFREAD): no requests here, so the content script stays small. */

export type WriteMode = 'proofread' | 'shorten' | 'english';
export type WriteResult = { status: 'ok'; text: string } | { status: 'failed'; reason: string };
export const WRITE_MAX_CHARS = 4_000;

// ---- tokens: one set of rules for the kept-entity check and X's count ----

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
const TRAIL = /[.,;:!?)\]'"’”]+$/;
// a $cashtag starts with a letter ($xmr, not $5)
const ENTITY_RE = /(?:^|[^\w&/])([@#][\p{L}\p{N}_]{1,50}|\$\p{L}[\p{L}\p{N}_]{0,49})/gu;

const normUrl = (u: string) => {
  const bare = u.replace(TRAIL, '');
  try {
    const x = new URL(bare);
    return x.toString().replace(/\/$/, '');
  } catch {
    return bare.toLowerCase();
  }
};

/** The @mentions, #tags, $cashtags and links in a text, normalized (a #tag inside a link isn't one). */
export function entitiesOf(text: string): string[] {
  const urls = [...text.matchAll(URL_RE)].map((m) => normUrl(m[0]));
  const rest = text.replace(URL_RE, ' ');
  const marks = [...rest.matchAll(ENTITY_RE)].map((m) => m[1]!.toLowerCase());
  return [...new Set([...urls, ...marks])];
}

/** What the input had that the output lost (Shorten may drop hashtags). */
export function lostEntities(input: string, output: string, mode: WriteMode): string[] {
  const have = new Set(entitiesOf(output));
  return entitiesOf(input).filter((e) => !have.has(e) && !(mode === 'shorten' && e.startsWith('#')));
}

/** X's count, as its composer shows it: a link is 23, CJK and emoji 2, the rest 1. Advisory. */
export function xLength(text: string): number {
  let n = 0;
  const rest = text.replace(URL_RE, () => {
    n += 23;
    return '';
  });
  for (const ch of rest.normalize('NFC')) {
    const c = ch.codePointAt(0)!;
    const light = c <= 0x10ff || (c >= 0x2000 && c <= 0x200d) || (c >= 0x2010 && c <= 0x201f) || (c >= 0x2032 && c <= 0x2037);
    n += light ? 1 : 2;
  }
  return n;
}

