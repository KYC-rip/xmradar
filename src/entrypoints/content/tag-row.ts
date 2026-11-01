import type { SuggestResult } from '../../ai/tags';
import { cleanTag, MAX_TAGS } from '../../nostr/tags';
import { h } from './dom';

/** asks for tags besides `have` (the row's and the text's) */
export type Suggest = (have: string[]) => Promise<SuggestResult>;
/** `auto`: ask as the composer opens; `autoAdd`: the answer goes straight into the tags; `saveAuto`: the row's Auto switch */
export interface SuggestMode {
  auto?: boolean;
  autoAdd?: boolean;
  /** saves the Auto choice (resolves when saved, rejects when not); absent: no switch */
  saveAuto?: (on: boolean) => Promise<unknown>;
}

export interface TagRowOptions {
  /** the tags the composer opens with (the text's hashtags, then the user's defaults) */
  initial: string[];
  /** asks the model; absent when suggestions are off or not set up */
  suggest?: Suggest;
  /** the user's default tags: with `autoAdd` on, one the post never mentions makes room for the model's */
  defaults?: string[];
  /** the post's text, to tell whether it mentions a default tag */
  text?: () => string;
  /** a local model: the button says so */
  local?: boolean;
  /** only a real click may send the post to a model (the shadow root is open to the page); tests pass their own */
  trusted?: (e: Event) => boolean;
  /** the hashtags written in the text: they count toward the limit too */
  textTags?: () => string[];
}

/**
 * The composer's Tags row (PLAN-TAGS): chips with ×, an input that adds on Enter or comma, and, when set up,
 * Suggest: the model's tags come back as suggestions the user adds one by one or all at once, or, with
 * `autoAdd`, go straight into the tags. A tag the user removed never comes back by itself, and a tag the
 * user touched is never removed; default tags the model drops stay one click away.
 */
export function tagRow(opts: TagRowOptions) {
  const trusted = opts.trusted ?? ((e: Event) => e.isTrusted);
  const tags: string[] = [];
  for (const t of opts.initial) {
    const c = cleanTag(t);
    if (c && !tags.includes(c) && tags.length < MAX_TAGS) tags.push(c);
  }
  const defaults = new Set((opts.defaults ?? []).map((t) => cleanTag(t)).filter((t): t is string => !!t));
  let readOnly = false;
  let suggestions: string[] = [];
  let suggest = opts.suggest;
  let local = opts.local;
  let autoAdd = false;
  // the user changed the tags (then nothing is taken away), the tags they took away, the text changed mid-request
  let touched = false;
  const removed = new Set<string>();
  let textChanged = false;
  // the Auto switch: its state, a save on its way, and "turned off while asking" (that answer only suggests)
  let autoState = false;
  let saving = false;
  let offWhileAsking = false;
  let saveAuto: SuggestMode['saveAuto'];

  const chips = h('span', { class: 'tag-chips' });
  const input = h('input', { type: 'text', class: 'tag-input', attrs: { 'aria-label': 'Add a tag', placeholder: 'Add tag' } });
  const note = h('div', { class: 'tag-note', attrs: { role: 'status', 'aria-live': 'polite' } });
  const warn = h('div', { class: 'tag-warn', attrs: { role: 'status', 'aria-live': 'polite' } });
  const offered = h('div', { class: 'tag-suggestions hidden' });
  const suggestBtn = h('button', { type: 'button', class: 'link' });
  // a button, not a checkbox: no change event a page could fire, and nothing toggles without our handler
  const autoBtn = h('button', { type: 'button', class: 'tag-auto hidden', attrs: { role: 'switch', 'aria-checked': 'false', title: 'Suggest as soon as the composer opens' } });
  const label = () => {
    suggestBtn.textContent = local ? 'Suggest (local model)' : 'Suggest tags';
    suggestBtn.classList.toggle('hidden', !suggest);
    autoBtn.textContent = local ? 'Auto' : 'Auto (sends each copy to the provider)';
    autoBtn.classList.toggle('hidden', !suggest || !saveAuto);
  };
  label();

  const render = () => {
    chips.replaceChildren(
      ...tags.map((t) => {
        const x = h('button', { type: 'button', class: 'tag-x', textContent: '×', disabled: readOnly, attrs: { 'aria-label': `Remove #${t}` } });
        x.addEventListener('click', () => remove(t, true));
        return h('span', { class: 'tag-chip' }, `#${t}`, x);
      }),
    );
    input.disabled = readOnly || tags.length >= MAX_TAGS;
    input.placeholder = tags.length >= MAX_TAGS ? `Up to ${MAX_TAGS} tags` : 'Add tag';
    const left = suggestions.filter((t) => !tags.includes(t));
    offered.replaceChildren(
      ...left.map((t) => {
        const b = h('button', { type: 'button', class: 'tag-offer', textContent: `+ ${t}`, disabled: readOnly || tags.length >= MAX_TAGS });
        b.addEventListener('click', () => add(t, true));
        return b;
      }),
    );
    if (left.length > 1) {
      const all = h('button', { type: 'button', class: 'link', textContent: 'Add all', disabled: readOnly || tags.length >= MAX_TAGS });
      all.addEventListener('click', () => left.forEach((t) => add(t, true)));
      offered.append(all);
    }
    offered.classList.toggle('hidden', !left.length);
    suggestBtn.disabled = readOnly || inFlight;
    autoBtn.setAttribute('aria-checked', String(autoState));
    autoBtn.disabled = readOnly || saving;
    const count = new Set([...tags, ...(opts.textTags?.() ?? [])]).size;
    warn.textContent =
      count > MAX_TAGS ? `${count} tags with the text's hashtags. More than ${MAX_TAGS} looks like spam, and ROS hides it from people who don't follow you.` : '';
  };

  function add(raw: string, byUser: boolean): boolean {
    const t = cleanTag(raw);
    if (!t || readOnly) return false;
    if (byUser) {
      touched = true;
      removed.delete(t);
    }
    if (!tags.includes(t) && tags.length < MAX_TAGS) tags.push(t);
    render();
    return true;
  }
  function remove(t: string, byUser: boolean) {
    if (readOnly || !tags.includes(t)) return;
    if (byUser) {
      touched = true;
      removed.add(t);
    }
    tags.splice(tags.indexOf(t), 1);
    render();
  }

  const commit = () => {
    const text = input.value.trim();
    if (!text) return;
    if (add(text, true)) {
      input.value = '';
      note.textContent = '';
    } else note.textContent = 'A tag is letters, digits, _ or -, with at least one letter.';
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      e.stopPropagation();
      commit();
    } else if (e.key === 'Backspace' && !input.value && tags.length && !readOnly) remove(tags[tags.length - 1]!, true);
  });
  input.addEventListener('blur', commit);
  input.addEventListener('input', () => (note.textContent = ''));

  let inFlight = false;
  /** the model's tags, as suggestions or (autoAdd, and the text unchanged meanwhile) into the tags */
  const apply = (picks: string[]) => {
    if (!autoAdd || textChanged || readOnly || offWhileAsking) {
      suggestions = picks;
      note.textContent = picks.every((t) => tags.includes(t)) ? 'No new tags suggested.' : '';
      return;
    }
    const before = [...tags];
    // a tag the user took away never comes back by itself (it can still be offered)
    const addable = picks.filter((t) => !removed.has(t));
    if (!touched) {
      // untouched: a default the post never mentions makes room (a small model can't judge them: it keeps them all)
      const text = opts.text?.() ?? '';
      const keep = tags.filter((t) => !defaults.has(t) || picks.includes(t) || mentions(text, t));
      tags.splice(0, tags.length, ...[...new Set([...keep, ...addable])].slice(0, MAX_TAGS));
    } else for (const t of addable) if (!tags.includes(t) && tags.length < MAX_TAGS) tags.push(t);
    suggestions = [...new Set([...before, ...picks])].filter((t) => !tags.includes(t));
    note.textContent = '';
  };
  /** the word anywhere in the text, as a hashtag or not (`self-custody` also as "self custody") */
  const mentions = (text: string, t: string) =>
    new RegExp(`(?<![\\p{L}\\p{N}_])${t.replace(/[-_]/g, '[-_ ]?')}(?![\\p{L}\\p{N}_])`, 'iu').test(text);
  const ask = async () => {
    if (!suggest || inFlight || readOnly) return;
    inFlight = true;
    textChanged = false;
    offWhileAsking = false;
    note.textContent = local ? 'Asking your local model…' : 'Asking the provider…';
    render();
    try {
      const res = await suggest([...new Set([...tags, ...(opts.textTags?.() ?? [])])]);
      if (res.status === 'ok') apply(res.tags);
      else note.textContent = res.reason;
    } catch (err) {
      note.textContent = (err as Error).message;
    } finally {
      inFlight = false;
      render();
    }
  };
  suggestBtn.addEventListener('click', (e) => {
    if (trusted(e)) void ask();
  });
  autoBtn.addEventListener('click', async (e) => {
    if (!trusted(e) || !saveAuto || readOnly || saving) return;
    const on = !autoState;
    autoState = on;
    if (!on && inFlight) offWhileAsking = true;
    saving = true;
    render();
    try {
      await saveAuto(on);
    } catch (err) {
      autoState = !on;
      const why = (err as Error)?.message ?? '';
      note.textContent = /settings changed/i.test(why) ? why : "Couldn't save the Auto switch";
      return;
    } finally {
      saving = false;
      render();
    }
    // still on, still editable, still on the page: ask for this composer too
    if (on && autoState && !readOnly && el.isConnected) void ask();
  });

  const el = h(
    'div',
    { class: 'tags' },
    h('div', { class: 'tag-line' }, h('span', { class: 'tag-label', textContent: 'Tags' }), chips, input, suggestBtn, autoBtn),
    offered,
    note,
    warn,
  );
  render();
  return {
    el,
    tags: () => [...tags],
    /** Suggest appears once the background says the settings are complete; `auto` asks right away */
    setSuggest: (fn: Suggest, isLocal?: boolean, mode: SuggestMode = {}) => {
      suggest = fn;
      local = isLocal;
      autoAdd = !!mode.autoAdd;
      autoState = !!mode.auto;
      saveAuto = mode.saveAuto;
      label();
      render();
      if (mode.auto) void ask();
    },
    /** the text changed: count its hashtags again (and an answer on its way is only a suggestion now) */
    refresh: () => {
      textChanged = true;
      render();
    },
    setReadOnly: (v: boolean) => {
      readOnly = v;
      render();
    },
  };
}
