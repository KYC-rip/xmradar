import { htmlToText } from "./html-to-text";

/**
 * A quote tweet's quoted post as a picture (PLAN-QUOTESHOT): the box X draws for it, the words for the
 * picture's description, and what's hidden while it's captured (the time, which shows the viewer's time
 * zone or when they looked, and X's own labels, which show their interface language).
 */

const QUOTE = 'div[role="link"]';
const ALT_GRAPHEMES = 400;

/** The quoted post's box in the tweet: a role=link box with its own author line, not one inside another quote. */
export function quoteBox(article: Element): HTMLElement | null {
  for (const box of article.querySelectorAll<HTMLElement>(QUOTE)) {
    const outer = box.parentElement?.closest(QUOTE);
    if (outer && article.contains(outer)) continue;
    if (box.querySelector('[data-testid="User-Name"]')) return box;
  }
  return null;
}

/** the box's own parts, not a quote nested inside it */
const ownIn = (box: Element, el: Element) =>
  el.parentElement?.closest(QUOTE) === box || el.closest(QUOTE) === box;

const isSeparator = (t: string) => /^[\s·•]*$/.test(t);

/** A text node that may show: the author's name and @handle (not the time), or the post's own text. */
function allowed(box: Element, node: Text): boolean {
  const el = node.parentElement;
  if (!el || !ownIn(box, el)) return false;
  if (el.closest('[data-testid="tweetText"]')) return true;
  const name = el.closest('[data-testid="User-Name"]');
  if (!name || el.closest("time")) return false;
  // the display name is the author line's first block; from the rest only the @handle, never a label
  // ("Follows you") or the time and its "·"
  if (name.firstElementChild?.contains(el)) return !isSeparator(node.data);
  return /^@[A-Za-z0-9_]{1,15}$/.test(node.data.trim());
}

const graphemes = (s: string) =>
  [
    ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s),
  ].map((x) => x.segment);

/** "Quoted post by Name @handle: text", with no time and no URL, cut at 400 characters. */
export function quoteAlt(box: Element): string {
  const name = [...box.querySelectorAll('[data-testid="User-Name"]')].find(
    (n) => ownIn(box, n),
  );
  const who = name
    ? textNodes(name)
        .filter((t) => allowed(box, t))
        .map((t) => t.data.trim())
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
    : "";
  const textEl = [...box.querySelectorAll('[data-testid="tweetText"]')].find(
    (n) => ownIn(box, n),
  );
  // links as their words: the description never carries a URL
  // X's "Show more" and buttons aren't the post's words
  const words = textEl?.cloneNode(true) as Element | undefined;
  words
    ?.querySelectorAll(
      '[data-testid="tweet-text-show-more-link"], button, [role="button"]',
    )
    .forEach((el) => el.remove());
  const text = words
    ? htmlToText(words, { link: () => null, inlineDivs: true })
        .replace(/https?:\/\/\S+/g, "")
        .replace(/\s+/g, " ")
        .trim()
    : "";
  const alt = `Quoted post${who ? ` by ${who}` : ""}${text ? `: ${text}` : ""}`;
  const g = graphemes(alt);
  return g.length > ALT_GRAPHEMES
    ? `${g.slice(0, ALT_GRAPHEMES).join("").trimEnd()}…`
    : alt;
}

function textNodes(root: Node): Text[] {
  const out: Text[] = [];
  const walker = (root.ownerDocument ?? (root as Document)).createTreeWalker(
    root,
    4 /* SHOW_TEXT */,
  );
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

/**
 * Hides everything in the box but the author's name and @handle, the post's text and its pictures: the
 * time, "·", buttons and every other label, and any quote nested inside. `visibility` keeps the layout.
 * A label sharing an element with allowed words is wrapped in a span of its own, so hiding it never hides
 * them. Returns a restore that puts back each change exactly, once.
 */
export function hideForShot(box: HTMLElement): () => void {
  const doc = box.ownerDocument;
  const undo: (() => void)[] = [];
  const hidden = new Set<HTMLElement>();
  const hide = (el: HTMLElement) => {
    if (hidden.has(el)) return;
    hidden.add(el);
    // the attribute as it was, word for word
    const before = el.getAttribute("style");
    el.style.setProperty("visibility", "hidden", "important");
    undo.push(() =>
      before === null
        ? el.removeAttribute("style")
        : el.setAttribute("style", before),
    );
  };
  const restore = () => {
    for (const f of undo.reverse()) f();
    undo.length = 0;
  };
  try {
    hideAll();
  } catch (e) {
    // a partial hide is put back before the error goes on
    restore();
    throw e;
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    restore();
  };

  function hideAll() {
    // a nested quote goes whole: its author, text and pictures aren't this post's
    for (const inner of box.querySelectorAll<HTMLElement>(QUOTE))
      if (inner !== box && inner.parentElement?.closest(QUOTE) === box)
        hide(inner);
    // X's controls, a link or a button: "Show more" can be either
    for (const el of box.querySelectorAll<HTMLElement>(
      'time, button, [role="button"], [data-testid="tweet-text-show-more-link"]',
    ))
      if (ownIn(box, el)) hide(el);
    for (const node of textNodes(box)) {
      if (!node.data.trim() || allowed(box, node)) continue;
      const parent = node.parentElement;
      if (!parent || !ownIn(box, parent) || hidden.has(parent)) continue;
      // the parent holds only this text: hide it; else give the text a span of its own
      if (parent !== box && parent.textContent === node.data) {
        hide(parent);
        continue;
      }
      const span = doc.createElement("span");
      node.replaceWith(span);
      span.append(node);
      hide(span);
      undo.push(() => span.replaceWith(node));
    }
  }
}
