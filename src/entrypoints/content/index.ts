import { handleFromTarget } from '../../identity/x-handle';
import { sendToBackground, type OpenComposerMsg, type OpenTipMsg } from '../../messaging';
import { cleanXLinksOn, settingsItem, shareMenuOn, siwmHelperOn } from '../../settings';
import { startSigninLinks } from '../../siwm/link-click';
import { isXHost } from '../../sender';
import { openComposer } from './composer';
import { openTip } from './tip';
import { startReceipts } from './receipt';
import { startSiteInfo } from './site';
import { startBadges } from './x-badges';
import { startWriting } from './x-write';
import { startCopyLinks } from './x-copy-links';
import { startSyncedMarks } from './x-synced';
import { startSetupCard } from './x-setup-card';
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
    // writing help in X's composer (PLAN-XPROOFREAD): its own switch, not the badges'
    if (onX) startWriting(ctx);
    // posts copied to Nostr get a small mark; switched live from the options page
    if (onX) startSyncedMarks(ctx);
    // until the Monero identity is set up: a card that opens setup.html (PLAN-XOREACH)
    if (onX) startSetupCard(ctx);
    // swap receipts (NKIP-0001) on any other site's top frame
    startReceipts(ctx);
    // site info from the xmr.club feed (badge, popup card, warnings)
    startSiteInfo(ctx);

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
    // X's share tracking taken out of copied X links; switched live too
    let stopCopyLinks: (() => void) | null = null;
    const setCopyLinks = (on: boolean) => {
      if (on && !stopCopyLinks && alive) stopCopyLinks = startCopyLinks(document);
      else if (!on && stopCopyLinks) {
        stopCopyLinks();
        stopCopyLinks = null;
      }
    };
    if (onX) {
      const apply = (s: Parameters<typeof shareMenuOn>[0]) => {
        setShare(shareMenuOn(s));
        setCopyLinks(cleanXLinksOn(s));
      };
      void settingsItem.getValue().then(apply);
      const unwatch = settingsItem.watch(apply);
      ctx.onInvalidated(() => {
        alive = false;
        unwatch();
        setShare(false);
        setCopyLinks(false);
      });
    }

    // Sign in with Monero links open XMRadar's consent window; the user's own wallet signs (PLAN-SIWM)
    let siwmOn = true;
    const readSiwm = (s: Parameters<typeof siwmHelperOn>[0]) => (siwmOn = siwmHelperOn(s));
    void settingsItem.getValue().then(readSiwm);
    const unwatchSiwm = settingsItem.watch(readSiwm);
    // no consent window (helper switched off meanwhile, or it couldn't open): the link does what it would without XMRadar
    const stopSignin = startSigninLinks(document, () => siwmOn, (uri) =>
      void sendToBackground({ type: 'siwm-open', uri })
        .then((r) => r ?? Promise.reject())
        .catch(() => location.assign(uri)),
    );
    ctx.onInvalidated(() => {
      unwatchSiwm();
      stopSignin();
    });

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
