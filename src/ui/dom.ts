/** A panel's child by `data-<attr>="name"`; required ones throw at mount with their name. */
export function part<T extends HTMLElement>(root: HTMLElement, attr: string, name: string): T {
  const el = root.querySelector<T>(`[data-${attr}="${name}"]`);
  if (!el) throw new Error(`${attr} panel: missing [data-${attr}="${name}"]`);
  return el;
}

export const optionalPart = <T extends HTMLElement>(root: HTMLElement, attr: string, name: string) => root.querySelector<T>(`[data-${attr}="${name}"]`);

export function setStatus(el: HTMLElement, text: string, kind: 'ok' | 'error' | 'warn' | '' = '') {
  el.textContent = text;
  el.className = kind;
}
