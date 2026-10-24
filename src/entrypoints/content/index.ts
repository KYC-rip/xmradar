import type { OpenComposerMsg } from '../../messaging';
import { openComposer } from './composer';
import './style.css';

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  cssInjectionMode: 'ui',
  main(ctx) {
    const w = window as unknown as { __s2nContent?: boolean };
    if (w.__s2nContent) return;
    w.__s2nContent = true;

    let lastContextTarget: Element | null = null;
    let lastHover: Element | null = null;
    document.addEventListener('contextmenu', (e) => (lastContextTarget = e.target as Element), true);
    // a plain assignment is cheap enough not to need throttling
    document.addEventListener('pointerover', (e) => (lastHover = e.target as Element), { capture: true, passive: true });

    browser.runtime.onMessage.addListener((msg: OpenComposerMsg) => {
      if (msg?.type !== 'open-composer') return;
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
