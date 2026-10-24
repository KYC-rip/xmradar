/**
 * Rendered article HTML → Markdown, for two layouts:
 * - X's logged-in Draft.js markup: blocks are `.longform-*` classes, bold/italic are inline styles,
 *   and every link sits in its own wrapper div, so unknown divs must stay inline (DRAFT-LINK-DIV).
 * - Semantic HTML (X logged out, and anything else): p, h1–h6, ul/ol, figure, blockquote, pre.
 */

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'BUTTON', 'SVG', 'svg', 'TEMPLATE']);
const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE', 'FIGURE', 'SECTION', 'HR']);
const HEADER_LEVEL: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

export interface MarkdownImage {
  url: string;
  alt?: string;
}

export interface MarkdownResult {
  markdown: string;
  images: MarkdownImage[];
  /** Plain text of the first paragraph. */
  firstParagraph: string;
}

export interface ToMarkdownOptions {
  /** Base for relative and protocol-relative links. */
  baseUrl: string;
  /** Map an image src to the URL to publish (e.g. full size). */
  imageUrl?: (src: string) => string;
}

/** Backslash-escape Markdown syntax in literal text. */
export function escapeText(text: string): string {
  return text.replace(/[\\`*_[\]<>&|~]/g, (c) => `\\${c}`);
}

/** Characters that would start a heading, quote, list or rule at the start of a line. */
function escapeLineStarts(text: string): string {
  return text
    // a line of only = or - would turn the line above into a heading
    .replace(/^([ \t]*)([=-])(?=[=\- \t]*$)/gm, '$1\\$2').replace(/^([ \t]*)(#|[-+](?=\s|$)|\d+(?=[.)](?:\s|$)))/gm, (_m, ws: string, mark: string) => `${ws}${/^\d/.test(mark) ? `${mark}\\` : `\\${mark}`}`);
}

/** A link or image destination, always in `<…>` form so `(`, `)` and spaces can't break out. */
export function destination(url: string): string {
  return `<${url.replace(/[<>\s]/g, (c) => encodeURIComponent(c))}>`;
}

export const imageToken = (img: MarkdownImage) => `![${escapeText(img.alt ?? '')}](${destination(img.url)})`;

function safeUrl(href: string | null, base: string): string | null {
  if (!href) return null;
  try {
    const u = new URL(href, base);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

const styleOf = (el: Element) => (el.getAttribute('style') ?? '').toLowerCase();
const isBold = (el: Element) => el.tagName === 'B' || el.tagName === 'STRONG' || /font-weight:\s*(bold|[6-9]00)/.test(styleOf(el));
const isItalic = (el: Element) => el.tagName === 'I' || el.tagName === 'EM' || /font-style:\s*italic/.test(styleOf(el));
const longformClass = (el: Element) => [...el.classList].find((c) => c.startsWith('longform-'));
const isSeparator = (el: Element) => el.tagName === 'HR' || el.getAttribute('role') === 'separator';

function isBlock(el: Element): boolean {
  if (BLOCK_TAGS.has(el.tagName) || isSeparator(el)) return true;
  // Draft blocks carry data-block; plain wrapper divs (including link wrappers) are inline
  return el.hasAttribute('data-block') || !!longformClass(el);
}

function containsBlock(el: Element): boolean {
  for (const child of el.children) if (isBlock(child) || containsBlock(child)) return true;
  return false;
}

/** Wrap in emphasis markers, keeping surrounding whitespace outside them so the markers still apply. */
function wrap(inner: string, marker: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!;
  return m[2] ? `${m[1]}${marker}${m[2]}${marker}${m[3]}` : inner;
}

const plain = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();

export function htmlToMarkdown(root: Element, opts: ToMarkdownOptions): MarkdownResult {
  const images: MarkdownImage[] = [];
  const blocks: { text: string; list?: boolean }[] = [];
  let firstParagraph = '';
  /** Ordered-list counters per nesting depth. */
  let ordinals: number[] = [];
  /** How deep in semantic nested lists the walker is (Draft marks depth with a class instead). */
  let nesting = 0;

  const image = (img: Element): string => {
    const src = safeUrl(img.getAttribute('src'), opts.baseUrl);
    if (!src) return '';
    const alt = img.getAttribute('alt')?.trim();
    const entry = { url: opts.imageUrl ? opts.imageUrl(src) : src, alt: alt && alt !== 'Image' ? alt : undefined };
    if (!images.some((i) => i.url === entry.url)) images.push(entry);
    return imageToken(entry);
  };

  /** The rest of a link URL that X rendered as plain text right after the shortened link. */
  let remainder = '';
  const inline = (node: Node, ctx: { bold: boolean; italic: boolean; link: boolean }): string => {
    if (node.nodeType === 3) {
      let data = (node as Text).data;
      // only the very next text can continue the link
      // and only when the URL really ends there, not when a word happens to start the same way
      if (remainder && data.startsWith(remainder) && !/^[\w/-]/.test(data.slice(remainder.length))) data = data.slice(remainder.length);
      remainder = '';
      return escapeText(data);
    }
    if (node.nodeType !== 1) return '';
    const el = node as Element;
    if (SKIP.has(el.tagName) || el.getAttribute('aria-hidden') === 'true') return '';
    if (el.tagName === 'BR') return '\n';
    if (el.tagName === 'IMG') {
      // content images become Markdown images; anything else (emoji) keeps its alt text
      const src = el.getAttribute('src') ?? '';
      return /pbs\.twimg\.com\/media\//.test(src) || !el.getAttribute('alt') ? image(el) : escapeText(el.getAttribute('alt')!);
    }
    if (el.tagName === 'A' && !ctx.link) {
      const img = el.querySelector('img');
      if (img) return image(img);
      const href = safeUrl(el.getAttribute('href'), opts.baseUrl);
      const inner = children(el, { ...ctx, link: true });
      if (!href) return inner;
      // a visible URL (possibly shortened by X) is shown in full instead
      const visible = plain(el);
      const [, lead, , trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(el.textContent ?? '')!;
      if (!visible || /^https?:\/\//i.test(visible)) {
        const full = href.replace(/\/$/, '');
        remainder = full.startsWith(visible) ? full.slice(visible.length) : '';
        return `${lead}${destination(href)}${trail}`;
      }
      remainder = '';
      return `${lead}[${inner.trim()}](${destination(href)})${trail}`;
    }
    const bold = !ctx.bold && isBold(el);
    const italic = !ctx.italic && isItalic(el);
    let out = children(el, { ...ctx, bold: ctx.bold || bold, italic: ctx.italic || italic });
    if (italic) out = wrap(out, '*');
    if (bold) out = wrap(out, '**');
    return out;
  };

  const children = (el: Element, ctx: { bold: boolean; italic: boolean; link: boolean }) => [...el.childNodes].map((n) => inline(n, ctx)).join('');
  const ctx0 = { bold: false, italic: false, link: false };

  const clean = (md: string) => escapeLineStarts(md.replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim());

  const push = (text: string, list = false) => {
    if (!text.trim()) return;
    if (!list) ordinals = [];
    blocks.push({ text, list });
  };

  const paragraph = (el: Element) => {
    const text = clean(children(el, ctx0));
    if (text && !firstParagraph && !/^!\[/.test(text)) firstParagraph = plain(el);
    push(text);
  };

  const listItem = (el: Element) => {
    const ordered = el.parentElement?.tagName === 'OL' || longformClass(el) === 'longform-ordered-list-item';
    const depthClass = [...el.classList].find((c) => /DraftStyleDefault-depth\d/.test(c));
    const depth = (depthClass ? Number(depthClass.match(/depth(\d)/)![1]) : 0) + nesting;
    // nested lists inside a semantic li are rendered as their own items afterwards
    const nested = [...el.querySelectorAll(':scope > ul, :scope > ol')];
    nested.forEach((n) => n.remove());
    const text = clean(children(el, ctx0)).replace(/\n/g, `\n${'   '.repeat(depth + 1)}`);
    ordinals.length = depth + 1; // leaving a nested list restarts its numbering
    ordinals[depth] = ordered ? (ordinals[depth] ?? 0) + 1 : 0;
    push(`${'   '.repeat(depth)}${ordered ? `${ordinals[depth]}.` : '-'} ${text}`, true);
    nesting++;
    nested.forEach((n) => walk(n));
    nesting--;
  };

  const block = (el: Element) => {
    const lf = longformClass(el);
    const heading = /^H([1-6])$/.exec(el.tagName)?.[1] ?? (lf?.startsWith('longform-header-') ? HEADER_LEVEL[lf.slice(16)] : undefined);
    if (isSeparator(el)) return push('---');
    if (heading) return push(`${'#'.repeat(Number(heading))} ${clean(children(el, ctx0)).replace(/\n/g, ' ')}`);
    if (el.tagName === 'LI' || lf?.endsWith('-list-item')) return listItem(el);
    if (el.tagName === 'PRE' || lf === 'longform-code-block') {
      const code = (el.textContent ?? '').replace(/\n$/, '');
      const fence = '`'.repeat(Math.max(3, ...(code.match(/`+/g) ?? []).map((r) => r.length + 1)));
      return push(`${fence}\n${code}\n${fence}`);
    }
    if (el.tagName === 'BLOCKQUOTE' || lf === 'longform-blockquote') {
      return push(clean(children(el, ctx0)).replace(/^/gm, '> '));
    }
    if (el.tagName === 'FIGURE' || el.tagName === 'SECTION') {
      const sep = el.querySelector('hr, [role="separator"]');
      const img = el.querySelector('img');
      if (img) return push(image(img));
      if (sep) return push('---');
      // an unknown embed degrades to its text instead of vanishing
      return paragraph(el);
    }
    if (el.tagName === 'UL' || el.tagName === 'OL') return walk(el);
    paragraph(el);
  };

  /** Containers are descended into; loose inline content between blocks becomes a paragraph. */
  function walk(container: Element) {
    let loose: Node[] = [];
    const flush = () => {
      if (!loose.length) return;
      const text = clean(loose.map((n) => inline(n, ctx0)).join(''));
      if (text && !firstParagraph && !/^!\[/.test(text)) firstParagraph = loose.map((n) => n.textContent ?? '').join('').replace(/\s+/g, ' ').trim();
      loose = [];
      push(text);
    };
    for (const node of [...container.childNodes]) {
      if (node.nodeType === 1) {
        const el = node as Element;
        if (SKIP.has(el.tagName)) continue;
        if (isBlock(el)) {
          flush();
          block(el);
          continue;
        }
        if (containsBlock(el)) {
          flush();
          walk(el);
          continue;
        }
      }
      loose.push(node);
    }
    flush();
  }

  walk(root.cloneNode(true) as Element);

  const markdown = blocks.reduce((out, b, i) => (i === 0 ? b.text : `${out}${b.list && blocks[i - 1]!.list ? '\n' : '\n\n'}${b.text}`), '');
  return { markdown, images, firstParagraph };
}

const IMAGE_TOKEN = /!\[((?:\\.|[^\]\\])*)\]\(<([^<>\n]*)>\)/g;

/**
 * Point generated image tokens at their final URLs (keyed by original URL), and drop tokens
 * whose image maps to null. Only whole `![alt](<url>)` tokens are touched, never other text.
 */
export function replaceImages(markdown: string, finals: Map<string, string | null>): string {
  const byDest = new Map([...finals].map(([from, to]) => [destination(from), to] as const));
  return markdown
    .replace(IMAGE_TOKEN, (token, alt: string, dest: string) => {
      const to = byDest.get(`<${dest}>`);
      if (to === undefined) return token;
      return to === null ? '' : `![${alt}](${destination(to)})`;
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
