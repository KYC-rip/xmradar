/**
 * One section at a time, picked by the URL hash (`#posting`, `#identity`, `#burner`).
 * Nav links are plain hash links, so back/forward and the popup's links work.
 * No or unknown hash → the first section. Returns the name shown.
 */
export function mountSections(doc: Document, onShow?: (name: string) => void) {
  const sections = [...doc.querySelectorAll<HTMLElement>('[data-section]')];
  const links = [...doc.querySelectorAll<HTMLAnchorElement>('[data-nav]')];

  function show(): string {
    const want = doc.defaultView?.location.hash.slice(1) ?? '';
    const target = sections.find((s) => s.dataset.section === want) ?? sections[0]!;
    const name = target.dataset.section!;
    for (const s of sections) s.hidden = s !== target;
    for (const a of links) {
      if (a.dataset.nav === name) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    onShow?.(name);
    return name;
  }

  doc.defaultView?.addEventListener('hashchange', show);
  return show();
}
