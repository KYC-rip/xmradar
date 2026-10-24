const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'BUTTON', 'SVG', 'svg', 'TEMPLATE']);
const PARAGRAPH = new Set(['P', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL']);
const PARA_BREAK = '\u0002';
const LINE_BREAK = '\u0001';
const LINE = new Set(['DIV', 'LI', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'TR']);

export interface ToTextOptions {
  /** Return replacement text for a link, or null to fall back to its text content. */
  link?: (a: HTMLAnchorElement) => string | null;
}

/** Turn rendered post HTML into plain text, keeping line breaks, emoji alt text and links. */
export function htmlToText(root: Node, opts: ToTextOptions = {}): string {
  const out: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      out.push((node as Text).data);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    if (SKIP.has(el.tagName) || el.getAttribute('aria-hidden') === 'true') return;
    if (el.tagName === 'BR') return void out.push('\n');
    if (el.tagName === 'IMG') {
      const alt = el.getAttribute('alt');
      if (alt) out.push(alt);
      return;
    }
    if (el.tagName === 'A' && opts.link) {
      const replaced = opts.link(el as HTMLAnchorElement);
      if (replaced != null) return void out.push(replaced);
    }
    const sep = PARAGRAPH.has(el.tagName) ? PARA_BREAK : LINE.has(el.tagName) ? LINE_BREAK : '';
    out.push(sep);
    el.childNodes.forEach(walk);
    out.push(sep);
  };
  walk(root);
  return out
    .join('')
    // block boundaries don't stack: </div><div> is one line break, any paragraph makes it two
    .replace(/[ \t]*[\u0001\u0002][\s\u0001\u0002]*/g, (run) => (run.includes(PARA_BREAK) ? '\n\n' : '\n'))
    .replace(/\r/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Sites render long links as a truncated display text ("example.com/very/lo…") while the
 * full URL is still in hidden spans. Recover it when possible, otherwise keep the href.
 */
export function resolveDisplayedLink(a: HTMLAnchorElement): string {
  const title = a.getAttribute('title');
  if (title && /^https?:\/\//.test(title)) return title;
  const raw = (a.textContent ?? '').trim();
  const text = raw.replace(/…$/, '');
  if (/^https?:\/\/\S+$/.test(text)) return text;
  // untruncated bare display text like "example.com/page"
  if (!raw.includes('…') && /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(text)) return `https://${text}`;
  return a.href || raw;
}

export function absUrl(url: string | null | undefined, doc: Document): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url, doc.baseURI).toString();
  } catch {
    return undefined;
  }
}
