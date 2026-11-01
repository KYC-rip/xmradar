/** Hashtags as Nostr `t` tags (NIP-24: lowercase), PLAN-TAGS. */
/** more looks like spam: ROS hides a stranger's note with more than 5 hashtags (`t` tags and #words together) */
export const MAX_TAGS = 5;
const MAX_LEN = 50;
const TAG_RE = /^[\p{L}\p{N}_](?:[\p{L}\p{N}_-]*[\p{L}\p{N}_])?$/u;

/** A tag name from what the user (or a model) typed, or null: no `#`, no spaces, lowercase, at least one letter. */
export function cleanTag(input: string): string | null {
  const t = input.trim().replace(/^#+/, '').replace(/\s+/g, '').toLowerCase();
  if (!t || t.length > MAX_LEN || !TAG_RE.test(t) || !/\p{L}/u.test(t)) return null;
  return t;
}

/** The `#hashtags` in a text, in order, deduped; not inside a URL (`…/a#frag`) and never only digits. */
export function hashtagsOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(^|[^\p{L}\p{N}_&/#])#([\p{L}\p{N}_][\p{L}\p{N}_-]*)/gu)) {
    const start = m.index + m[1]!.length;
    // a fragment in a link: the word before the # runs back to whitespace through a URL; punctuation ends the link
    if (!/[,;!)\]}>'"]$/.test(m[1]!) && /(?:\S*:\/\/|(?:^|\s)www\.)\S*$/i.test(text.slice(0, start))) continue;
    const t = cleanTag(m[2]!.replace(/-+$/, ''));
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Tags not already written in the text as a hashtag, as a last `#a #b` line (empty when none). */
export function missingHashtagLine(text: string, tags: string[]): string {
  const shown = new Set(hashtagsOf(text));
  return tags
    .filter((t) => !shown.has(t))
    .map((t) => `#${t}`)
    .join(' ');
}

/** Clean, deduped and capped, for an event. */
export function eventTags(tags: string[]): string[][] {
  const out: string[] = [];
  for (const raw of tags) {
    const t = cleanTag(raw);
    if (t && !out.includes(t)) out.push(t);
    if (out.length === MAX_TAGS) break;
  }
  return out.map((t) => ['t', t]);
}
