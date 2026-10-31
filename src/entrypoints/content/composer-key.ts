import { extractPost } from '../../extractors';
import { ownStatusId, tweetFor, xExtractor } from '../../extractors/x';
import type { OpenComposerMsg } from '../../messaging';

/** FNV-1a, 64-bit, twice with different offsets: only where Web Crypto is missing (plain http, file:). */
function fnvHex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const run = (offset: bigint) => {
    let h = offset;
    for (const b of bytes) h = BigInt.asUintN(64, (h ^ BigInt(b)) * 0x100000001b3n);
    return h.toString(16).padStart(16, '0');
  };
  return run(0xcbf29ce484222325n) + run(0x84222325cbf29ce4n);
}

/** SHA-256 hex of the text; Web Crypto is only there in secure pages, so a local hash stands in elsewhere. */
async function textKey(text: string): Promise<string> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return `f${fnvHex(text)}`;
  }
}

/**
 * Which copy a Copy to Nostr request is (PLAN-PARALLEL §1), known before its composer mounts. The explicit
 * request wins: a selection, then an image, then the X tweet (its status id, the same on x.com and
 * twitter.com), then the post's own address as the site's extractor finds it (a Mastodon or Bluesky post in
 * a timeline), then the page. Read from the page, so tested with a DOM.
 */
export async function composerKey(target: Element | null, msg: Pick<OpenComposerMsg, 'selection' | 'srcUrl'>, doc: Document): Promise<string> {
  const loc = doc.location;
  const page = `${loc.origin}${loc.pathname}`;
  const selection = msg.selection?.trim();
  if (selection) return `sel:${page}:${await textKey(selection)}`;
  if (msg.srcUrl) {
    try {
      const u = new URL(msg.srcUrl, loc.href);
      return `img:${u.origin}${u.pathname}`;
    } catch {
      return `img:${msg.srcUrl}`;
    }
  }
  if (xExtractor.matches(doc)) {
    const tweet = tweetFor(target, doc);
    const id = tweet && ownStatusId(tweet);
    if (id) return `x:${id}`;
  }
  // another site's post: its own address, when an extractor recognises one (not the generic page fallback)
  try {
    const { post, fallback } = extractPost(target, doc);
    if (!fallback && post.sourceUrl) {
      const u = new URL(post.sourceUrl, loc.href);
      if (`${u.origin}${u.pathname}` !== page) return `post:${u.origin}${u.pathname}`;
    }
  } catch {
    // no post found: the page
  }
  return `page:${page}`;
}
