import { aiTagsItem } from '../../settings';
import { sendToBackground } from '../../messaging';
import { lostEntities, xLength, WRITE_MAX_CHARS, type WriteMode, type WriteResult } from '../../ai/writing-text';

/**
 * Writing help in X's composer (PLAN-XPROOFREAD): a pen in the toolbar opens a small panel that proofreads,
 * shortens or translates the draft (or the selected part) with the user's own AI, shows what changed, and puts
 * the result back with a paste, which X's editor (Draft.js) takes as the user's own: its state and undo follow.
 */

export const WRITE_BUTTON = 'xmradar-write-btn';
const EDITOR = '[data-testid^="tweetTextarea_"][contenteditable="true"]';
const MODES: { mode: WriteMode; label: string }[] = [
  { mode: 'proofread', label: 'Proofread' },
  { mode: 'shorten', label: 'Shorten' },
  { mode: 'english', label: 'English' },
];
const SOURCE_LABEL = { local: 'Local model: the text stays on this computer', anthropic: 'Anthropic, with your key', openai: 'Your provider, with your key' } as const;

/** The draft's text as X shows it (Draft ends with a line break of its own). */
export const editorText = (editor: Element) => ((editor as HTMLElement).innerText ?? editor.textContent ?? '').replace(/​/g, '').replace(/\n$/, '');
const same = (a: string, b: string) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

/** The composer's editors for a toolbar: the nearest ancestor (up to 10 levels) holding one. */
export function editorsFor(toolbar: Element): HTMLElement[] {
  let up: Element | null = toolbar;
  for (let i = 0; i < 10 && up; i++, up = up.parentElement) {
    const found = [...up.querySelectorAll<HTMLElement>(EDITOR)];
    if (found.length) return found;
  }
  return [];
}

export interface WriteTarget {
  editor: HTMLElement;
  /** the whole draft when asked */
  draft: string;
  /** the selected part, when there was one inside the editor */
  range: Range | null;
  text: string;
}

/** What the button works on: the selection inside one of these editors, or the focused (else first) editor's whole draft. */
export function captureTarget(editors: HTMLElement[], lastFocused: HTMLElement | null, doc: Document = document): WriteTarget | null {
  const sel = doc.getSelection();
  const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const inside = r ? editors.find((e) => e.contains(r.commonAncestorContainer)) : undefined;
  if (inside && r && !r.collapsed && r.toString().trim()) return { editor: inside, draft: editorText(inside), range: r.cloneRange(), text: r.toString() };
  const editor = inside ?? (lastFocused && editors.includes(lastFocused) ? lastFocused : editors[0]);
  if (!editor) return null;
  const draft = editorText(editor);
  return { editor, draft, range: null, text: draft };
}

/** Put `text` in place of the range (or the whole draft) as a paste, once Draft has the selection; false when it didn't take. */
export async function putBack(t: WriteTarget, text: string, doc: Document = document): Promise<boolean> {
  const { editor } = t;
  const select = () => {
    editor.focus();
    const sel = doc.getSelection();
    if (!sel) return false;
    let r = t.range;
    if (!r || !editor.contains(r.startContainer) || !editor.contains(r.endContainer)) {
      if (t.range) return false;
      r = doc.createRange();
      r.selectNodeContents(editor);
    }
    sel.removeAllRanges();
    sel.addRange(r);
    return true;
  };
  // what the editor should read after: the text around the selection (as the DOM has it) with the answer between
  let expected = text;
  if (t.range) {
    const around = (start: boolean) => {
      const r = doc.createRange();
      r.selectNodeContents(editor);
      if (start) r.setEnd(t.range!.startContainer, t.range!.startOffset);
      else r.setStart(t.range!.endContainer, t.range!.endOffset);
      return r.toString();
    };
    try {
      expected = around(true) + text + around(false);
    } catch {
      return false;
    }
  }
  const took = async () => {
    await new Promise((res) => setTimeout(res, 60));
    return same(t.range ? (editor.textContent ?? '') : editorText(editor), expected);
  };
  if (!select()) return false;
  // Draft takes the new selection from the selectionchange that follows (a later task): a paste sent before
  // it lands goes where Draft's old selection was, and X's state no longer matches what's on screen
  await settled(doc);
  const dt = new DataTransfer();
  dt.setData('text/plain', text);
  editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  // no execCommand fallback: it edits the DOM behind Draft's back, and the draft can't be edited after
  return took();
}

/** After a selectionchange (or 150 ms without one) and a frame, for the editor to take a new selection. */
function settled(doc: Document): Promise<void> {
  return new Promise((res) => {
    const go = () => {
      clearTimeout(timer);
      doc.removeEventListener('selectionchange', go);
      setTimeout(res, 30);
    };
    doc.addEventListener('selectionchange', go);
    const timer = setTimeout(go, 150);
  });
}

// ---- the word diff shown in the panel ----

type Part = { kind: 'same' | 'add' | 'del'; text: string };

/** Word-level changes (spaces kept with their words); past ~250k comparisons, the new text as one addition. */
export function wordDiff(a: string, b: string): Part[] {
  const A = a.split(/(\s+)/).filter(Boolean);
  const B = b.split(/(\s+)/).filter(Boolean);
  if (A.length * B.length > 250_000) return [{ kind: 'add', text: b }];
  const L: number[][] = Array.from({ length: A.length + 1 }, () => new Array<number>(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) L[i]![j] = A[i] === B[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const out: Part[] = [];
  const push = (kind: Part['kind'], text: string) => {
    const last = out[out.length - 1];
    if (last?.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) push('same', A[i++]!), j++;
    else if (L[i + 1]![j]! >= L[i]![j + 1]!) push('del', A[i++]!);
    else push('add', B[j++]!);
  }
  while (i < A.length) push('del', A[i++]!);
  while (j < B.length) push('add', B[j++]!);
  return out;
}

// ---- the panel ----

const CSS = `
:host { all: initial; }
.panel { position: fixed; z-index: 2147483000; width: min(440px, calc(100vw - 24px)); box-sizing: border-box; font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 8px 28px rgba(0,0,0,.25); padding: 12px; }
.top { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
.mode { border: 1px solid var(--line); background: transparent; color: var(--fg); border-radius: 999px; padding: 4px 12px; font: inherit; font-weight: 600; cursor: pointer; }
.mode[aria-pressed="true"] { background: var(--fg); color: var(--bg); border-color: var(--fg); }
.x { margin-left: auto; border: 0; background: transparent; color: var(--dim); font-size: 18px; cursor: pointer; padding: 2px 6px; }
.src { color: var(--dim); font-size: 12px; margin: 0 0 8px; }
.out { white-space: pre-wrap; word-break: break-word; max-height: 40vh; overflow: auto; padding: 8px; border-radius: 10px; background: var(--soft); min-height: 2.8em; }
.add { background: rgba(0,186,124,.22); border-radius: 3px; }
.del { color: var(--dim); text-decoration: line-through; }
.meta { display: flex; justify-content: space-between; color: var(--dim); font-size: 12px; margin: 6px 2px; gap: 8px; }
.warn { color: #f4900c; }
.err { color: #f4212e; }
.row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; flex-wrap: wrap; }
.btn { border: 1px solid var(--line); background: transparent; color: var(--fg); border-radius: 999px; padding: 6px 14px; font: inherit; font-weight: 700; cursor: pointer; }
.btn.primary { background: #f26822; border-color: #f26822; color: #fff; }
.btn:disabled { opacity: .5; cursor: default; }
.dots::after { content: '…'; animation: d 1s steps(3) infinite; }
@keyframes d { from { opacity: .3 } to { opacity: 1 } }
`;

const PEN =
  '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor"><path d="M14.06 3.94a2.5 2.5 0 0 1 3.54 0l2.46 2.46a2.5 2.5 0 0 1 0 3.54L9.12 20.88a1 1 0 0 1-.47.26l-4.4 1.1a1 1 0 0 1-1.21-1.21l1.1-4.4a1 1 0 0 1 .26-.47L14.06 3.94zm2.13 1.41a.5.5 0 0 0-.71 0l-1.3 1.3 3.17 3.17 1.3-1.3a.5.5 0 0 0 0-.71l-2.46-2.46zM15.94 11.23l-3.17-3.17-6.8 6.8-.74 2.94 2.94-.74 6.8-6.8z"/><path d="M19 15l.6 1.4L21 17l-1.4.6L19 19l-.6-1.4L17 17l1.4-.6L19 15z"/></svg>';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}

const darkPage = () => {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(document.body).backgroundColor);
  return m ? Number(m[1]) + Number(m[2]) + Number(m[3]) < 384 : false;
};

interface PanelDeps {
  ask: (mode: WriteMode, text: string) => Promise<WriteResult>;
  cancel: () => void;
  source: keyof typeof SOURCE_LABEL;
}

let openPanel: { close(): void } | null = null;

function showPanel(anchor: Element, t: WriteTarget, deps: PanelDeps) {
  openPanel?.close();
  const host = el('div', { 'data-xmradar': 'write-panel' });
  const root = host.attachShadow({ mode: 'closed' });
  const dark = darkPage();
  const style = el('style', {}, CSS + `.panel{--bg:${dark ? '#000' : '#fff'};--fg:${dark ? '#e7e9ea' : '#0f1419'};--dim:${dark ? '#71767b' : '#536471'};--line:${dark ? '#2f3336' : '#cfd9de'};--soft:${dark ? '#16181c' : '#f7f9f9'}}`);
  const panel = el('div', { class: 'panel', role: 'dialog', 'aria-label': 'Writing help (XMRadar)' });
  const top = el('div', { class: 'top' });
  const modeBtns = MODES.map(({ mode, label }) => {
    const b = el('button', { class: 'mode', type: 'button', 'aria-pressed': 'false' }, label);
    b.addEventListener('click', () => void run(mode));
    top.append(b);
    return { mode, b };
  });
  const x = el('button', { class: 'x', type: 'button', 'aria-label': 'Close' }, '×');
  top.append(x);
  const src = el('p', { class: 'src' }, `${t.range ? 'The selected text' : 'Your draft'} · ${SOURCE_LABEL[deps.source]}`);
  const out = el('div', { class: 'out', 'aria-live': 'polite' });
  const meta = el('div', { class: 'meta' });
  const note = el('span');
  const count = el('span');
  meta.append(note, count);
  const row = el('div', { class: 'row' });
  const keep = el('button', { class: 'btn', type: 'button' }, 'Keep mine');
  const copy = el('button', { class: 'btn', type: 'button' }, 'Copy');
  const replace = el('button', { class: 'btn primary', type: 'button' }, 'Replace');
  row.append(keep, copy, replace);
  panel.append(top, src, out, meta, row);
  root.append(style, panel);
  document.body.append(host);

  const place = () => {
    const a = anchor.getBoundingClientRect();
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    panel.style.left = `${Math.max(12, Math.min(a.left - 8, innerWidth - w - 12))}px`;
    const below = a.bottom + 8;
    panel.style.top = `${below + h < innerHeight - 8 ? below : Math.max(8, a.top - h - 8)}px`;
  };

  let result = '';
  let seq = 0;
  let confirmChange = false;
  const setButtons = (busy: boolean) => {
    replace.disabled = busy || !result;
    copy.disabled = busy || !result;
  };
  async function run(mode: WriteMode) {
    const id = ++seq;
    result = '';
    confirmChange = false;
    replace.textContent = 'Replace';
    for (const m of modeBtns) m.b.setAttribute('aria-pressed', String(m.mode === mode));
    out.replaceChildren(el('span', { class: 'dots' }, 'Asking'));
    note.textContent = '';
    note.className = '';
    count.textContent = '';
    setButtons(true);
    place();
    busy = true;
    const res = await deps.ask(mode, t.text).catch((e: unknown) => ({ status: 'failed', reason: String((e as Error)?.message ?? e) }) as WriteResult);
    if (id !== seq || !host.isConnected) return;
    busy = false;
    if (res.status !== 'ok') {
      out.replaceChildren(el('span', { class: 'err' }, res.reason));
      setButtons(false);
      return place();
    }
    result = res.text;
    if (same(result, t.text)) {
      out.textContent = result;
      note.textContent = 'No changes needed';
    } else {
      out.replaceChildren(...wordDiff(t.text, result).map((p) => (p.kind === 'same' ? document.createTextNode(p.text) : el('span', { class: p.kind }, p.text))));
      const lost = lostEntities(t.text, result, mode);
      if (lost.length) {
        note.textContent = `The AI dropped ${lost.slice(0, 3).join(', ')}${lost.length > 3 ? '…' : ''}`;
        note.className = 'warn';
      }
    }
    const n = xLength(t.range ? t.draft.replace(t.text, result) : result);
    count.textContent = n > 280 ? `${n} characters: a long post` : `${n} / 280`;
    setButtons(false);
    place();
  }

  let busy = false;
  const close = () => {
    seq++;
    if (busy) deps.cancel();
    host.remove();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onOutside, true);
    removeEventListener('resize', place);
    if (openPanel === handle) openPanel = null;
    t.editor.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  const onOutside = (e: PointerEvent) => {
    if (!e.composedPath().includes(host) && !e.composedPath().includes(anchor)) close();
  };
  x.addEventListener('click', close);
  keep.addEventListener('click', close);
  copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(result).then(
      () => (note.textContent = 'Copied'),
      () => (note.textContent = "Couldn't copy"),
    );
  });
  replace.addEventListener('click', async () => {
    if (!result) return;
    if (!confirmChange && !same(editorText(t.editor), t.draft)) {
      confirmChange = true;
      replace.textContent = 'Replace anyway';
      note.textContent = 'Your draft changed since you asked.';
      note.className = 'warn';
      return;
    }
    replace.disabled = true;
    const ok = await putBack(t, result).catch(() => false);
    if (ok) return close();
    await navigator.clipboard.writeText(result).catch(() => {});
    note.textContent = "Couldn't put it in: it's copied, paste it with Ctrl/⌘ V";
    note.className = 'err';
    replace.disabled = false;
  });
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onOutside, true);
  addEventListener('resize', place);
  const handle = { close };
  openPanel = handle;
  void run('proofread');
}

// ---- the buttons ----

export interface WriteDeps {
  ready: () => Promise<{ ready: boolean; source: keyof typeof SOURCE_LABEL }>;
  ask: (mode: WriteMode, text: string) => Promise<WriteResult>;
  cancel?: () => void;
  watch: (cb: () => void) => () => void;
}

const defaultDeps: WriteDeps = {
  ready: () => sendToBackground({ type: 'ai-write-ready' }),
  ask: (mode, text) => sendToBackground({ type: 'ai-write', mode, text }),
  cancel: () => void sendToBackground({ type: 'ai-write-cancel' }).catch(() => {}),
  // a key added or removed in Options (the page never touches the key): asked again when the tab shows again
  watch: (cb) => {
    const unwatch = aiTagsItem.watch(() => cb());
    const onShow = () => document.visibilityState === 'visible' && cb();
    document.addEventListener('visibilitychange', onShow);
    return () => (unwatch(), document.removeEventListener('visibilitychange', onShow));
  },
};

/** The pen next to X's emoji button, in every composer toolbar, while writing help is set up and on. */
export function startWriting(ctx: { onInvalidated(cb: () => void): void }, deps: WriteDeps = defaultDeps, doc: Document = document) {
  let source: keyof typeof SOURCE_LABEL = 'local';
  let on = false;
  let observer: MutationObserver | null = null;
  let lastFocused: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onFocus = (e: FocusEvent) => {
    const t = e.target instanceof Element ? e.target.closest<HTMLElement>(EDITOR) : null;
    if (t) lastFocused = t;
  };

  const addTo = (toolbar: Element) => {
    if (toolbar.querySelector(`.${WRITE_BUTTON}`)) return;
    const editors = editorsFor(toolbar);
    if (!editors.length) return;
    const list = toolbar.querySelector('[role="tablist"]') ?? toolbar.querySelector('nav')?.firstElementChild ?? null;
    const item = el('div', { role: 'presentation', class: WRITE_BUTTON, style: 'display:flex;align-items:center;justify-content:center;width:36px;min-width:36px;height:36px' });
    const btn = el('button', {
      type: 'button',
      'aria-label': 'Writing help: proofread, shorten or translate with your AI (XMRadar)',
      title: 'Proofread · Shorten · English (XMRadar, your AI)',
      style: 'all:unset;cursor:pointer;display:flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:999px;color:rgb(29,155,240)',
    });
    btn.innerHTML = PEN;
    // X's own icons' colour (theme and accent), from a button that's enabled: a disabled one (location, a
    // full poll) is drawn faded, and the pen would look disabled too
    const enabled = 'button[aria-label]:not([disabled]):not([aria-disabled="true"]) svg';
    const theirs = toolbar.querySelector(enabled.replace('button[aria-label]', 'button[aria-label="Add emoji"]')) ?? toolbar.querySelector(enabled);
    if (theirs) btn.style.color = getComputedStyle(theirs).color;
    let target: WriteTarget | null = null;
    // keep the editor's selection: the button never takes focus
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      target = captureTarget(editorsFor(toolbar), lastFocused, doc);
    });
    btn.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      e.preventDefault();
      e.stopPropagation();
      const t = target ?? captureTarget(editorsFor(toolbar), lastFocused, doc);
      target = null;
      if (!t || !t.text.trim()) return void flash(btn, 'Write something first');
      if (t.text.length > WRITE_MAX_CHARS) return void flash(btn, `Too long for writing help: select up to ${WRITE_MAX_CHARS.toLocaleString('en')} characters`);
      showPanel(btn, t, { ask: deps.ask, cancel: deps.cancel ?? (() => {}), source });
    });
    item.append(btn);
    const emoji = list && [...list.children].find((c) => c.querySelector('[aria-label="Add emoji"], [aria-haspopup="menu"]'));
    if (emoji) emoji.after(item);
    else if (list) list.append(item);
    else toolbar.prepend(item);
  };

  const scan = () => {
    timer = undefined;
    if (!on) return;
    for (const tb of doc.querySelectorAll('[data-testid="toolBar"]')) addTo(tb);
  };
  const schedule = () => {
    timer ??= setTimeout(scan, 250);
  };
  const removeAll = () => {
    for (const b of doc.querySelectorAll(`.${WRITE_BUTTON}`)) b.remove();
    openPanel?.close();
  };
  const refresh = async () => {
    // the background briefly unreachable: keep things as they are until the next change
    const r = await deps.ready().catch(() => ({ ready: on, source }));
    source = r.source;
    if (r.ready === on) return;
    on = r.ready;
    if (on) {
      observer = new MutationObserver(schedule);
      observer.observe(doc.body, { childList: true, subtree: true });
      doc.addEventListener('focusin', onFocus, true);
      scan();
    } else {
      observer?.disconnect();
      observer = null;
      doc.removeEventListener('focusin', onFocus, true);
      removeAll();
    }
  };
  void refresh();
  const unwatch = deps.watch(() => void refresh());
  ctx.onInvalidated(() => {
    unwatch();
    observer?.disconnect();
    clearTimeout(timer);
    doc.removeEventListener('focusin', onFocus, true);
    removeAll();
  });
}

/** A short note under the button, gone after a few seconds. */
function flash(btn: HTMLElement, text: string) {
  const a = btn.getBoundingClientRect();
  const tip = el('div', {
    role: 'status',
    style: `position:fixed;z-index:2147483000;left:${Math.max(8, a.left - 8)}px;top:${a.bottom + 6}px;max-width:300px;padding:6px 10px;border-radius:8px;background:#0f1419;color:#fff;font:13px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.3)`,
  }, text);
  document.body.append(tip);
  setTimeout(() => tip.remove(), 2500);
}
