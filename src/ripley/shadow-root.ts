/**
 * `wxt/utils/content-script-ui/shadow-root` for the Ripley X bundle: WXT's own createShadowRootUi (open
 * shadow roots, as in the extension), with XMRadar's content CSS handed over inline — the extension loads it
 * from its own package URL (`cssInjectionMode: 'ui'`), which doesn't exist in X's page.
 */
// the real module, by file (the bare specifier is aliased to this file)
import { createShadowRootUi as wxtCreateShadowRootUi } from '../../node_modules/wxt/dist/utils/content-script-ui/shadow-root.mjs';
import css from '../entrypoints/content/style.css?inline';

const UI_CSS = css.replaceAll(':root', ':host');

export const createShadowRootUi: typeof wxtCreateShadowRootUi = (ctx, options) =>
  wxtCreateShadowRootUi(ctx, { ...options, css: [UI_CSS, options.css ?? ''].join('\n') });
