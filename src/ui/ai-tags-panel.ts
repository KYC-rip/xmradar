import { ANTHROPIC_MODEL, findLocalModels, localRoot, OLLAMA_REFUSED, SAMPLE_TEXT, suggestTags, validBaseUrl } from '../ai/tags';
import { cleanTag, MAX_TAGS } from '../nostr/tags';
import { aiKeyItem, aiTagsItem, DEFAULT_AI_TAGS, hashtagLineOn, patchAiTags, patchSettings, settingsItem, type AiSource, type AiTagSettings } from '../settings';
import { setStatus } from './dom';

type FetchFn = typeof fetch;
const byId = <T extends HTMLElement>(root: ParentNode, id: string) => root.querySelector<T>(`#${id}`)!;
const OPENAI_BASE = 'https://api.openai.com/v1';

/** "monero, #Privacy, monero" → ["monero", "privacy"]; null when one part isn't a tag. */
export function parseTagList(text: string): string[] | null {
  const out: string[] = [];
  for (const part of text.split(',')) {
    if (!part.trim()) continue;
    const t = cleanTag(part);
    if (!t) return null;
    if (!out.includes(t)) out.push(t);
  }
  return out.slice(0, MAX_TAGS);
}

/** Options → Posting: default tags and the #hashtag line (PLAN-TAGS). */
export function mountTagsField(root: ParentNode) {
  const input = byId<HTMLInputElement>(root, 'default-tags');
  const line = byId<HTMLInputElement>(root, 'hashtag-line');
  const saved = byId(root, 'tags-saved');
  input.disabled = line.disabled = true;
  const flash = () => {
    setStatus(saved, 'Saved', 'ok');
    setTimeout(() => setStatus(saved, ''), 1500);
  };
  input.addEventListener('blur', async () => {
    const tags = parseTagList(input.value);
    if (!tags) return setStatus(saved, 'A tag is letters, digits, _ or -, with at least one letter.', 'error');
    input.value = tags.join(', ');
    await patchSettings({ defaultTags: tags });
    flash();
  });
  line.addEventListener('change', async () => {
    await patchSettings({ hashtagLine: line.checked });
    flash();
  });
  return settingsItem.getValue().then((s) => {
    input.value = (s.defaultTags ?? []).join(', ');
    line.checked = hashtagLineOn(s);
    input.disabled = line.disabled = false;
  });
}

/**
 * Options → Tag suggestions: a local model first, or a provider with the user's key. Everything saves as it
 * changes; the key goes to its own `local:` item. The page asks the model itself for Test and Find (an
 * extension page, with the same network reach as the background).
 */
export function mountAiTagsPanel(root: ParentNode, fetchFn: FetchFn = (...a) => fetch(...a)) {
  const on = byId<HTMLInputElement>(root, 'ai-on');
  const body = byId(root, 'ai-body');
  const radios = [...root.querySelectorAll<HTMLInputElement>('input[name="ai-source"]')];
  const localBox = byId(root, 'ai-local');
  const keyBox = byId(root, 'ai-key-box');
  const localUrl = byId<HTMLInputElement>(root, 'ai-local-url');
  const provider = byId<HTMLSelectElement>(root, 'ai-provider');
  const base = byId<HTMLInputElement>(root, 'ai-base');
  const key = byId<HTMLInputElement>(root, 'ai-key');
  const show = byId<HTMLButtonElement>(root, 'ai-key-show');
  const model = byId<HTMLInputElement>(root, 'ai-model');
  const models = byId<HTMLDataListElement>(root, 'ai-models');
  const status = byId(root, 'ai-status');
  const find = byId<HTMLButtonElement>(root, 'ai-find');
  const test = byId<HTMLButtonElement>(root, 'ai-test');
  const auto = byId<HTMLInputElement>(root, 'ai-auto');
  const autoKey = byId(root, 'ai-auto-key');
  const autoAdd = byId<HTMLInputElement>(root, 'ai-auto-add');
  // the setup steps allow only this extension's own address (a Firefox install has its own UUID)
  for (const o of root.querySelectorAll('.ext-origin')) o.textContent = location.origin;
  let s: AiTagSettings = DEFAULT_AI_TAGS;
  // the base URL of the other source, kept while the user switches back and forth
  let localBase = DEFAULT_AI_TAGS.baseUrl;
  let keyBase = OPENAI_BASE;
  // and the model of each source: a local model's name means nothing to a provider
  const modelOf: Record<AiSource, string> = { local: '', openai: '', anthropic: ANTHROPIC_MODEL };
  const switchTo = (source: AiSource) => {
    model.value = modelOf[source];
    void save({ source, baseUrl: source === 'local' ? localBase : keyBase, model: modelOf[source] });
  };

  const render = () => {
    on.checked = s.on;
    body.hidden = !s.on;
    const local = s.source === 'local';
    for (const r of radios) r.checked = r.value === (local ? 'local' : 'key');
    localBox.hidden = !local;
    keyBox.hidden = local;
    base.hidden = s.source !== 'openai';
    auto.checked = !!s.auto;
    autoAdd.checked = !!s.autoAdd;
    autoKey.hidden = local || !s.auto;
  };
  const save = async (patch: Partial<AiTagSettings>) => {
    // a result from the other source would be stale
    if (patch.source && patch.source !== s.source) setStatus(status, '');
    s = { ...s, ...patch };
    render();
    await patchAiTags(patch);
  };
  const setOptions = (names: string[]) => models.replaceChildren(...names.map((n) => Object.assign(document.createElement('option'), { value: n })));

  on.addEventListener('change', () => void save({ on: on.checked }));
  auto.addEventListener('change', () => void save({ auto: auto.checked }));
  autoAdd.addEventListener('change', () => void save({ autoAdd: autoAdd.checked }));
  for (const r of radios)
    r.addEventListener('change', () => {
      if (r.checked) switchTo(r.value === 'local' ? 'local' : provider.value === 'anthropic' ? 'anthropic' : 'openai');
    });
  provider.addEventListener('change', () => switchTo(provider.value === 'anthropic' ? 'anthropic' : 'openai'));
  const urlField = (input: HTMLInputElement, source: 'local' | 'openai', rule: string) =>
    input.addEventListener('blur', () => {
      const v = source === 'local' ? localRoot(input.value) : input.value.trim().replace(/\/+$/, '');
      if (!validBaseUrl(source, v)) return setStatus(status, rule, 'error');
      setStatus(status, '');
      input.value = v;
      if (source === 'local') localBase = v;
      else keyBase = v;
      void save({ baseUrl: v });
    });
  urlField(localUrl, 'local', 'A local server is http://localhost, 127.0.0.1 or [::1], with any port.');
  urlField(base, 'openai', 'The API base URL must start with https://.');
  model.addEventListener('change', () => {
    modelOf[s.source] = model.value.trim();
    void save({ model: modelOf[s.source] });
  });
  key.addEventListener('change', () => void aiKeyItem.setValue(key.value.trim()));
  show.addEventListener('click', () => {
    key.type = key.type === 'password' ? 'text' : 'password';
    show.textContent = key.type === 'password' ? 'Show' : 'Hide';
  });

  find.addEventListener('click', async () => {
    find.disabled = true;
    setStatus(status, 'Looking for Ollama and LM Studio…');
    try {
      const servers = [...new Set([localRoot(localUrl.value), localBase, 'http://localhost:11434', 'http://localhost:1234'])].filter((u) => validBaseUrl('local', u));
      const all = await findLocalModels(fetchFn, servers);
      const found = all.filter((f) => f.models.length);
      if (!found.length)
        return setStatus(status, all.some((f) => f.refused) ? OLLAMA_REFUSED : 'No local model found. Is Ollama or LM Studio running?', 'error');
      const first = found[0]!;
      localUrl.value = localBase = first.baseUrl;
      setOptions(first.models);
      const patch: Partial<AiTagSettings> = { baseUrl: first.baseUrl };
      if (!first.models.includes(model.value.trim())) model.value = modelOf.local = patch.model = first.models[0]!;
      await save(patch);
      setStatus(status, `Found ${first.models.length} ${first.models.length === 1 ? 'model' : 'models'} at ${first.baseUrl}.`, 'ok');
    } finally {
      find.disabled = false;
    }
  });

  test.addEventListener('click', async () => {
    test.disabled = true;
    setStatus(status, 'Asking with a sample sentence…');
    try {
      const res = await suggestTags({ ...s, on: true, model: model.value.trim() }, key.value, SAMPLE_TEXT, fetchFn);
      if (res.status === 'ok') setStatus(status, `Works: ${res.tags.map((t) => `#${t}`).join(' ')}`, 'ok');
      else setStatus(status, res.reason, 'error');
    } finally {
      test.disabled = false;
    }
  });

  on.disabled = true;
  return Promise.all([aiTagsItem.getValue(), aiKeyItem.getValue()]).then(([saved, k]) => {
    s = { ...DEFAULT_AI_TAGS, ...saved };
    if (s.model) modelOf[s.source] = s.model;
    if (s.source === 'local') localBase = localRoot(s.baseUrl);
    else if (s.source === 'openai') keyBase = s.baseUrl;
    localUrl.value = localBase;
    base.value = keyBase;
    provider.value = s.source === 'anthropic' ? 'anthropic' : 'openai';
    model.value = modelOf[s.source];
    key.value = k;
    on.disabled = false;
    render();
  });
}
