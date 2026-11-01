import type { SuggestResult } from '../../ai/tags';
import { cleanTag, MAX_TAGS } from '../../nostr/tags';
import { h } from './dom';

export interface TagRowOptions {
  /** the tags the composer opens with (the text's hashtags, then the user's defaults) */
  initial: string[];
  /** asks the model; absent when suggestions are off or not set up */
  suggest?: () => Promise<SuggestResult>;
  /** a local model: the button says so */
  local?: boolean;
  /** only a real click may send the post to a model (the shadow root is open to the page); tests pass their own */
  trusted?: (e: Event) => boolean;
  /** the hashtags written in the text: they count toward the limit too */
  textTags?: () => string[];
}

/**
 * The composer's Tags row (PLAN-TAGS): chips with ×, an input that adds on Enter or comma, and, when set up,
 * Suggest: the model's tags come back as suggestions the user adds one by one or all at once.
 */
export function tagRow(opts: TagRowOptions) {
  const trusted = opts.trusted ?? ((e: Event) => e.isTrusted);
  const tags: string[] = [];
  for (const t of opts.initial) {
    const c = cleanTag(t);
    if (c && !tags.includes(c) && tags.length < MAX_TAGS) tags.push(c);
  }
  let readOnly = false;
  let suggestions: string[] = [];
  let suggest = opts.suggest;

  const chips = h('span', { class: 'tag-chips' });
  const input = h('input', { type: 'text', class: 'tag-input', attrs: { 'aria-label': 'Add a tag', placeholder: 'Add tag' } });
  const note = h('div', { class: 'tag-note', attrs: { role: 'status', 'aria-live': 'polite' } });
  const warn = h('div', { class: 'tag-warn', attrs: { role: 'status', 'aria-live': 'polite' } });
  const offered = h('div', { class: 'tag-suggestions hidden' });
  const suggestBtn = h('button', { type: 'button', class: 'link' });
  const label = (local?: boolean) => {
    suggestBtn.textContent = local ? 'Suggest (local model)' : 'Suggest tags';
    suggestBtn.classList.toggle('hidden', !suggest);
  };
  label(opts.local);

  const render = () => {
    chips.replaceChildren(
      ...tags.map((t) => {
        const x = h('button', { type: 'button', class: 'tag-x', textContent: '×', disabled: readOnly, attrs: { 'aria-label': `Remove #${t}` } });
        x.addEventListener('click', () => remove(t));
        return h('span', { class: 'tag-chip' }, `#${t}`, x);
      }),
    );
    input.disabled = readOnly || tags.length >= MAX_TAGS;
    input.placeholder = tags.length >= MAX_TAGS ? `Up to ${MAX_TAGS} tags` : 'Add tag';
    const left = suggestions.filter((t) => !tags.includes(t));
    offered.replaceChildren(
      ...left.map((t) => {
        const b = h('button', { type: 'button', class: 'tag-offer', textContent: `+ ${t}`, disabled: readOnly || tags.length >= MAX_TAGS });
        b.addEventListener('click', () => add(t));
        return b;
      }),
    );
    if (left.length > 1) {
      const all = h('button', { type: 'button', class: 'link', textContent: 'Add all', disabled: readOnly || tags.length >= MAX_TAGS });
      all.addEventListener('click', () => left.forEach(add));
      offered.append(all);
    }
    offered.classList.toggle('hidden', !left.length);
    suggestBtn.disabled = readOnly || inFlight;
    const count = new Set([...tags, ...(opts.textTags?.() ?? [])]).size;
    warn.textContent =
      count > MAX_TAGS ? `${count} tags with the text's hashtags. More than ${MAX_TAGS} looks like spam, and ROS hides it from people who don't follow you.` : '';
  };

  function add(raw: string): boolean {
    const t = cleanTag(raw);
    if (!t || readOnly) return false;
    if (!tags.includes(t) && tags.length < MAX_TAGS) tags.push(t);
    render();
    return true;
  }
  function remove(t: string) {
    if (readOnly) return;
    tags.splice(tags.indexOf(t), 1);
    render();
  }

  const commit = () => {
    const text = input.value.trim();
    if (!text) return;
    if (add(text)) {
      input.value = '';
      note.textContent = '';
    } else note.textContent = 'A tag is letters, digits, _ or -, with at least one letter.';
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      e.stopPropagation();
      commit();
    } else if (e.key === 'Backspace' && !input.value && tags.length && !readOnly) remove(tags[tags.length - 1]!);
  });
  input.addEventListener('blur', commit);
  input.addEventListener('input', () => (note.textContent = ''));

  let inFlight = false;
  suggestBtn.addEventListener('click', async (e) => {
    if (!suggest || inFlight || readOnly || !trusted(e)) return;
    inFlight = true;
    note.textContent = 'Asking…';
    render();
    try {
      const res = await suggest();
      if (res.status === 'ok') {
        suggestions = res.tags;
        note.textContent = res.tags.every((t) => tags.includes(t)) ? 'No new tags suggested.' : '';
      } else note.textContent = res.reason;
    } catch (err) {
      note.textContent = (err as Error).message;
    } finally {
      inFlight = false;
      render();
    }
  });

  const el = h(
    'div',
    { class: 'tags' },
    h('div', { class: 'tag-line' }, h('span', { class: 'tag-label', textContent: 'Tags' }), chips, input, suggestBtn),
    offered,
    note,
    warn,
  );
  render();
  return {
    el,
    tags: () => [...tags],
    /** Suggest appears once the background says the settings are complete */
    setSuggest: (fn: () => Promise<SuggestResult>, local?: boolean) => {
      suggest = fn;
      label(local);
    },
    /** the text changed: count its hashtags again */
    refresh: () => render(),
    setReadOnly: (v: boolean) => {
      readOnly = v;
      render();
    },
  };
}
