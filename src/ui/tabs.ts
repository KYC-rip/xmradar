import { storage } from 'wxt/utils/storage';

export const popupTabItem = storage.defineItem<string | null>('local:popupTab', { fallback: null });

/**
 * ARIA tabs: `role="tab"` buttons with `data-tab` and `aria-controls` inside a `role="tablist"`,
 * roving tabindex, Left/Right/Home/End. `onShow` runs on every selection (it loads a panel once).
 * An unknown `initial` falls back to the first tab. Returns the select function.
 */
export function mountTabs(list: HTMLElement, initial: string | null, onShow: (name: string) => void) {
  const tabs = [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const doc = list.ownerDocument;
  const panel = (t: HTMLElement) => doc.getElementById(t.getAttribute('aria-controls') ?? '');

  function select(name: string, focus = false) {
    const target = tabs.find((t) => t.dataset.tab === name) ?? tabs[0]!;
    for (const t of tabs) {
      const on = t === target;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      panel(t)?.toggleAttribute('hidden', !on);
    }
    if (focus) target.focus();
    onShow(target.dataset.tab!);
  }

  for (const t of tabs) t.addEventListener('click', () => select(t.dataset.tab!));
  list.addEventListener('keydown', (e) => {
    const i = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1 + tabs.length, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    select(tabs[next % tabs.length]!.dataset.tab!, true);
  });
  select(initial ?? '');
  return select;
}
