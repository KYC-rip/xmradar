import { handleFromTarget } from '../../identity/x-handle';
import { sendToBackground, type OpenComposerMsg, type OpenTipMsg } from '../../messaging';
import { settingsItem, shareMenuOn } from '../../settings';
import { isXHost } from '../../sender';
import { openComposer } from './composer';
import { openTip } from './tip';
import { startBadges } from './x-badges';
import { shareMenu, type ShareMenu } from './x-share';
import './style.css';

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  cssInjectionMode: 'ui',
  main(ctx) {
    const w = window as unknown as { __s2nContent?: boolean };
    if (w.__s2nContent) return;
    w.__s2nContent = true;

    const onX = window === window.top && isXHost(location.hostname);
    if (onX) startBadges(ctx);

    // "Copy to Nostr" in X's share menu; switched live from the options page
    let share: ShareMenu | null = null;
    let alive = true;
    const onShareClick = (e: Event) => share?.onClick(e);
    const setShare = (on: boolean) => {
      // a settings read can resolve after the script was invalidated
      if (on && !share && alive) {
        share = shareMenu(document, () => sendToBackground({ type: 'share-menu-copy' }));
        document.addEventListener('click', onShareClick, true);
      } else if (!on && share) {
        document.removeEventListener('click', onShareClick, true);
        share.stop();
        share = null;
      }
    };
    if (onX) {
      void settingsItem.getValue().then((s) => setShare(shareMenuOn(s)));
      const unwatch = settingsItem.watch((s) => setShare(shareMenuOn(s)));
      ctx.onInvalidated(() => {
        alive = false;
        unwatch();
        setShare(false);
      });
    }

    let lastContextTarget: Element | null = null;
    let lastHover: Element | null = null;
    document.addEventListener('contextmenu', (e) => (lastContextTarget = e.target as Element), true);
    // a plain assignment is cheap enough not to need throttling
    document.addEventListener('pointerover', (e) => (lastHover = e.target as Element), { capture: true, passive: true });

    browser.runtime.onMessage.addListener((msg: OpenComposerMsg | OpenTipMsg) => {
      if (msg?.type === 'open-tip') {
        void openTip(ctx, handleFromTarget(lastContextTarget, location));
        return;
      }
      if (msg?.type !== 'open-composer') return;
      if (msg.fromShareMenu) {
        // the tweet picked in the share menu, never a text selection elsewhere on the page
        const article = share?.takeTarget();
        if (article) void openComposer(ctx, { ...msg, selection: undefined }, article);
        else console.warn('[XMRadar] share menu: the post moved or the request expired; try again');
        return;
      }
      const selection = msg.selection ?? window.getSelection()?.toString();
      let target = msg.fromCommand ? lastHover : lastContextTarget;
      if (msg.fromCommand && selection) {
        const anchor = window.getSelection()?.anchorNode;
        target = anchor instanceof Element ? anchor : (anchor?.parentElement ?? target);
      }
      void openComposer(ctx, { ...msg, selection }, target);
    });
  },
});
