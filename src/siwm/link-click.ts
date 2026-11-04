/**
 * Sign in with Monero links in pages (PLAN-SIWM): a real, plain left click on a `monero-signin:` link is
 * taken over and its link handed to XMRadar's consent window. Anything else is left to the page.
 */
export function signinLinkOf(e: MouseEvent): string | null {
  if (!e.isTrusted || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const a = e.composedPath().find((n): n is HTMLAnchorElement => (n as Element).localName === 'a' && (n as Element).hasAttribute?.('href'));
  const href = a?.getAttribute('href')?.trim() ?? '';
  return /^monero-signin:/i.test(href) ? href : null;
}

export function startSigninLinks(doc: Document, on: () => boolean, open: (uri: string) => void): () => void {
  const onClick = (e: MouseEvent) => {
    if (!on()) return;
    const uri = signinLinkOf(e);
    if (!uri) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    open(uri);
  };
  doc.addEventListener('click', onClick, true);
  return () => doc.removeEventListener('click', onClick, true);
}
