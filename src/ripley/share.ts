/**
 * "Copy to Nostr" in X's share menu inside Ripley (ripley-os plans/x-app-xmradar.md, phase 3 P1): XMRadar's own
 * share-menu item (the post is fixed by the user's trusted click on that post's share button), but instead of
 * XMRadar's composer the post goes to Ripley, whose Nostr app opens with it as a draft. Nothing is published here.
 */
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { browser } from './browser';
import { ownStatusId, xExtractor } from '../extractors/x';
import type { ExtractedPost } from '../extractors/types';
import { settingsItem, shareMenuOn } from '../settings';
import { shareMenu, type ShareMenu } from '../entrypoints/content/x-share';

/** Ripley's bridge takes 16 KB per request; the copy stays under this with its JSON framing. */
export const MAX_COPY_BYTES = 15_000;
export const MAX_COPY_IMAGES = 4;

export interface ShareCopy {
  type: 'share-copy';
  statusId: string;
  post: { text: string; images: { url: string; alt?: string }[]; sourceUrl: string; articleCard?: boolean };
  truncated?: boolean;
}

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

/** The request for one post, cut to fit: at most 4 images, the text shortened (whole characters) until it fits. */
export function fitCopy(statusId: string, post: ExtractedPost, max = MAX_COPY_BYTES): ShareCopy {
  const images = post.images.slice(0, MAX_COPY_IMAGES).map((i) => (i.alt ? { url: i.url, alt: i.alt.slice(0, 500) } : { url: i.url }));
  const make = (text: string, truncated: boolean): ShareCopy => ({
    type: 'share-copy',
    statusId,
    post: { text, images, sourceUrl: post.sourceUrl, ...(post.articleCard ? { articleCard: true } : {}) },
    ...(truncated ? { truncated: true } : {}),
  });
  let req = make(post.text, false);
  if (bytes(req) <= max) return req;
  const chars = [...post.text];
  // halve the gap until the longest text that fits is found
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (bytes(make(chars.slice(0, mid).join(''), true)) <= max) lo = mid;
    else hi = mid - 1;
  }
  req = make(chars.slice(0, lo).join(''), true);
  return req;
}

/** The share-menu item, switched live with XMRadar's "Copy to Nostr" setting (Ripley pushes it). */
export function startShare(ctx: ContentScriptContext, send: (req: ShareCopy) => Promise<unknown> = (req) => browser.runtime.sendMessage(req)) {
  let share: ShareMenu | null = null;
  const onClick = (e: Event) => share?.onClick(e);
  const request = async () => {
    const article = share?.takeTarget();
    const id = article ? ownStatusId(article) : null;
    const post = article ? xExtractor.extract(article, document) : null;
    if (!id || !post) throw new Error('that post is no longer on the page');
    return send(fitCopy(id, post));
  };
  const set = (on: boolean) => {
    if (on && !share && ctx.isValid) {
      share = shareMenu(document, request);
      document.addEventListener('click', onClick, true);
    } else if (!on && share) {
      document.removeEventListener('click', onClick, true);
      share.stop();
      share = null;
    }
  };
  void settingsItem.getValue().then((s) => set(shareMenuOn(s)));
  const unwatch = settingsItem.watch((s) => set(shareMenuOn(s)));
  ctx.onInvalidated(() => {
    unwatch();
    set(false);
  });
}
