import { cleanCopiedString, CLEAN_LINKS_ATTR } from './content/x-copy-links';

/**
 * MAIN-world companion to `x-copy-links.ts` for Mobile X (and modern desktop X), where "Copy link"
 * calls `navigator.clipboard.writeText(...)` (no DOM `copy` event) and "Share post via…" calls
 * `navigator.share({ url })`.
 *
 * Strictly gated on `document.documentElement.getAttribute('data-xmradar-clean-links') === '1'` so
 * toggling the setting off in Options disables it immediately with zero reload.
 */

export interface CleanLinkWindowLike {
  __xmradarCleanLinksPatched?: boolean;
  Clipboard?: { prototype?: { writeText?: (text: string) => Promise<void> } };
  Navigator?: { prototype?: { share?: (data?: ShareData) => Promise<void> } };
  navigator?: {
    clipboard?: { writeText?: (text: string) => Promise<void> };
    share?: (data?: ShareData) => Promise<void>;
  };
}

export function installMainWorldLinkCleaner(win: CleanLinkWindowLike, doc: Document): void {
  if (win.__xmradarCleanLinksPatched) return;
  win.__xmradarCleanLinksPatched = true;

  const active = () => doc.documentElement?.getAttribute(CLEAN_LINKS_ATTR) === '1';

  const patchWriteText = (host: { writeText?: (text: string) => Promise<void> } | undefined) => {
    if (!host || typeof host.writeText !== 'function') return false;
    const orig = host.writeText;
    try {
      host.writeText = function (this: unknown, text: string) {
        const next = active() && typeof text === 'string' ? cleanCopiedString(text) : text;
        return orig.call(this, next);
      };
      return true;
    } catch {
      return false;
    }
  };

  if (!patchWriteText(win.Clipboard?.prototype)) {
    patchWriteText(win.navigator?.clipboard);
  }

  const patchShare = (host: { share?: (data?: ShareData) => Promise<void> } | undefined) => {
    if (!host || typeof host.share !== 'function') return false;
    const orig = host.share;
    try {
      host.share = function (this: unknown, data?: ShareData) {
        if (active() && data && typeof data === 'object') {
          let changed = false;
          const copy: ShareData = { ...data };
          if (typeof copy.url === 'string') {
            const cleanUrl = cleanCopiedString(copy.url);
            if (cleanUrl !== copy.url) {
              copy.url = cleanUrl;
              changed = true;
            }
          }
          if (typeof copy.text === 'string') {
            const cleanText = cleanCopiedString(copy.text);
            if (cleanText !== copy.text) {
              copy.text = cleanText;
              changed = true;
            }
          }
          if (changed) return orig.call(this, copy);
        }
        return orig.call(this, data);
      };
      return true;
    } catch {
      return false;
    }
  };

  if (!patchShare(win.Navigator?.prototype)) {
    patchShare(win.navigator);
  }
}

export default defineContentScript({
  matches: ['https://x.com/*', 'https://twitter.com/*', 'https://mobile.x.com/*', 'https://mobile.twitter.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    if (window !== window.top) return;
    installMainWorldLinkCleaner(window as unknown as CleanLinkWindowLike, document);
  },
});
