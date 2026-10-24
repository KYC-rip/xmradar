type Props<K extends keyof HTMLElementTagNameMap> = Partial<HTMLElementTagNameMap[K]> & { class?: string; attrs?: Record<string, string> };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props<K> = {}, ...children: (Node | string)[]) {
  const el = document.createElement(tag);
  const { class: cls, attrs, ...rest } = props;
  if (cls) el.className = cls;
  for (const [k, v] of Object.entries(attrs ?? {})) el.setAttribute(k, v);
  Object.assign(el, rest);
  el.append(...children);
  return el;
}

/** Escape closes, Tab cycles inside the dialog. */
export function trapFocus(dialog: HTMLElement, onEscape: () => void) {
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onEscape();
    }
    if (e.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll<HTMLElement>('textarea, input, button, a[href]')].filter((el) => !(el as HTMLButtonElement).disabled);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = (dialog.getRootNode() as ShadowRoot).activeElement;
    if (e.shiftKey && active === first) (e.preventDefault(), last?.focus());
    else if (!e.shiftKey && active === last) (e.preventDefault(), first?.focus());
  });
}
