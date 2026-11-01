// @vitest-environment happy-dom
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { setAuto, suggestFor, tagsReady } from '../src/ai/requests';
import { aiReady, findLocalModels, MAX_PROMPT_CHARS, OLLAMA_REFUSED, parseTagReply, suggestTags, tagRequest, validBaseUrl } from '../src/ai/tags';
import { tagRow } from '../src/entrypoints/content/tag-row';
import { buildArticle, buildNote } from '../src/nostr/event';
import { cleanTag, eventTags, hashtagsOf, MAX_TAGS, missingHashtagLine } from '../src/nostr/tags';
import { aiKeyItem, aiTagsItem, autoAddOn, autoOn, settingsItem, type AiTagSettings } from '../src/settings';
import { mountAiTagsPanel, parseTagList } from '../src/ui/ai-tags-panel';

const KEY = 'sk-secret-key-123';
const local: AiTagSettings = { on: true, source: 'local', baseUrl: 'http://localhost:11434', model: 'llama3.2' };
const openai: AiTagSettings = { on: true, source: 'openai', baseUrl: 'https://api.openai.com/v1/', model: 'gpt-x' };
const anthropic: AiTagSettings = { on: true, source: 'anthropic', baseUrl: '', model: 'claude-haiku-5-5' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const chat = (content: string) => json({ choices: [{ message: { content } }] });

describe('tag names', () => {
  it('cleanTag: no #, no spaces, lowercase, a letter required', () => {
    expect(cleanTag('#Monero')).toBe('monero');
    expect(cleanTag('bitcoin cash')).toBe('bitcoincash');
    expect(cleanTag('self-custody')).toBe('self-custody');
    expect(cleanTag('2026')).toBeNull();
    expect(cleanTag('a.b')).toBeNull();
    expect(cleanTag('<script>')).toBeNull();
    expect(cleanTag('x'.repeat(51))).toBeNull();
    expect(cleanTag('-x')).toBeNull();
  });
  it('hashtagsOf: a link ends at punctuation; www links count as links', () => {
    expect(hashtagsOf('see https://x.com/a,#monero')).toEqual(['monero']);
    expect(hashtagsOf('see (https://x.com/a)#monero')).toEqual(['monero']);
    expect(hashtagsOf('www.example.com/?q=1-#frag and #nostr')).toEqual(['nostr']);
    expect(hashtagsOf('https://x.com/?q=1-#frag')).toEqual([]);
  });
  it('hashtagsOf: in order, deduped, unicode, not numbers, not URL fragments', () => {
    expect(hashtagsOf('Big day for #Monero and #privacy. Again #monero!')).toEqual(['monero', 'privacy']);
    expect(hashtagsOf('#モネロ is here')).toEqual(['モネロ']);
    expect(hashtagsOf('we are #1 in #2026')).toEqual([]);
    expect(hashtagsOf('read https://example.com/page#section and #nostr')).toEqual(['nostr']);
    expect(hashtagsOf('a&#39;b x#y #ok-')).toEqual(['ok']);
  });
  it('missingHashtagLine and eventTags', () => {
    expect(missingHashtagLine('about #monero', ['monero', 'privacy', 'xmr'])).toBe('#privacy #xmr');
    expect(eventTags(['Monero', '#monero', 'bad tag!', ...Array.from({ length: 20 }, (_, i) => `t${i}`)])).toHaveLength(MAX_TAGS);
    expect(eventTags(['Monero'])).toEqual([['t', 'monero']]);
  });
});

describe('events', () => {
  it('a note gets t tags and a hashtag line for tags missing from the text', () => {
    const ev = buildNote({ text: 'Hello #monero', images: [], tags: ['monero', 'privacy'], hashtagLine: true, now: 1 });
    expect(ev.tags).toEqual([
      ['t', 'monero'],
      ['t', 'privacy'],
      ['client', 'XMRadar'],
    ]);
    expect(ev.content).toBe('Hello #monero\n\n#privacy');
  });
  it('without the switch the text is left alone', () => {
    const ev = buildNote({ text: 'Hello', images: [], tags: ['privacy'], now: 1 });
    expect(ev.content).toBe('Hello');
    expect(ev.tags).toContainEqual(['t', 'privacy']);
  });
  it('an article gets t tags; its text never changes', () => {
    const ev = buildArticle({ tweetId: '1', title: 'T', summary: '', markdown: 'Body', images: [], sourceUrl: 'https://x.com/a/status/1', publishedAt: 0, tags: ['monero'], now: 1 });
    expect(ev.tags).toContainEqual(['t', 'monero']);
    expect(ev.content).toBe('Body');
  });
});

describe('composer Tags row', () => {
  const press = (input: HTMLInputElement, key: string) => input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  const chipsOf = (el: HTMLElement) => [...el.querySelectorAll('.tag-chip')].map((c) => c.firstChild!.textContent);

  it('starts with the given tags, adds on Enter or comma, keeps bad input, Backspace removes', () => {
    const row = tagRow({ initial: ['Monero', 'monero', 'nostr'] });
    const input = row.el.querySelector('input')!;
    expect(row.tags()).toEqual(['monero', 'nostr']);
    input.value = 'Privacy';
    press(input, 'Enter');
    input.value = 'bitcoin cash';
    press(input, ',');
    expect(row.tags()).toEqual(['monero', 'nostr', 'privacy', 'bitcoincash']);
    input.value = 'no!';
    press(input, 'Enter');
    expect(input.value).toBe('no!');
    expect(row.el.querySelector('.tag-note')!.textContent).toContain('at least one letter');
    input.value = '';
    press(input, 'Backspace');
    expect(chipsOf(row.el)).toEqual(['#monero', '#nostr', '#privacy']);
  });
  it('caps at MAX_TAGS (5) and is read-only while publishing', () => {
    const row = tagRow({ initial: Array.from({ length: 12 }, (_, i) => `t${i}`) });
    expect(row.tags()).toHaveLength(MAX_TAGS);
    expect(row.el.querySelector('input')!.disabled).toBe(true);
    row.setReadOnly(true);
    (row.el.querySelector('.tag-x') as HTMLButtonElement).click();
    expect(row.tags()).toHaveLength(MAX_TAGS);
  });
  it('warns past 5 tags, counting the hashtags left in the text', () => {
    let text = ['monero', 'xmr', 'privacy', 'lightning'];
    const row = tagRow({ initial: ['monero', 'nostr', 'bitcoin'], textTags: () => text });
    const warn = row.el.querySelector('.tag-warn')!;
    expect(MAX_TAGS).toBe(5);
    expect(warn.textContent).toContain('6 tags');
    expect(warn.textContent).toContain('ROS hides it');
    text = ['monero'];
    row.refresh();
    expect(warn.textContent).toBe('');
  });
  it('Suggest is hidden until set up, and a synthetic click sends nothing', async () => {
    const suggest = vi.fn(async () => ({ status: 'ok' as const, tags: ['privacy'] }));
    const row = tagRow({ initial: [] });
    const btn = [...row.el.querySelectorAll('button')].find((b) => /Suggest/.test(b.textContent!))!;
    expect(btn.classList.contains('hidden')).toBe(true);
    row.setSuggest(suggest, true);
    expect(btn.classList.contains('hidden')).toBe(false);
    expect(btn.textContent).toBe('Suggest (local model)');
    btn.click();
    await Promise.resolve();
    expect(suggest).not.toHaveBeenCalled();
  });
  it('a real click shows suggestions; they enter the tags only when added', async () => {
    let resolve!: (v: { status: 'ok'; tags: string[] }) => void;
    const suggest = vi.fn(() => new Promise<{ status: 'ok'; tags: string[] }>((r) => (resolve = r)));
    const row = tagRow({ initial: ['monero'], suggest, trusted: () => true });
    const btn = [...row.el.querySelectorAll('button')].find((b) => /Suggest/.test(b.textContent!))!;
    btn.click();
    expect(btn.disabled).toBe(true);
    btn.click();
    expect(suggest).toHaveBeenCalledTimes(1);
    resolve({ status: 'ok', tags: ['monero', 'privacy', 'xmr'] });
    await vi.waitFor(() => expect(row.el.querySelectorAll('.tag-offer')).toHaveLength(2));
    expect(row.tags()).toEqual(['monero']);
    (row.el.querySelector('.tag-offer') as HTMLButtonElement).click();
    expect(row.tags()).toEqual(['monero', 'privacy']);
    row.setSuggest(async () => ({ status: 'ok', tags: ['a1', 'b2', 'c3'] }));
    btn.click();
    await vi.waitFor(() => expect(row.el.querySelectorAll('.tag-offer')).toHaveLength(3));
    [...row.el.querySelectorAll('button')].find((b) => b.textContent === 'Add all')!.click();
    expect(row.tags()).toEqual(['monero', 'privacy', 'a1', 'b2', 'c3']);
  });
  it('a failed suggestion shows its reason', async () => {
    const row = tagRow({ initial: [], suggest: async () => ({ status: 'failed', reason: 'Key rejected' }), trusted: () => true });
    [...row.el.querySelectorAll('button')].find((b) => /Suggest/.test(b.textContent!))!.click();
    await vi.waitFor(() => expect(row.el.querySelector('.tag-note')!.textContent).toBe('Key rejected'));
  });
});

describe('AI requests', () => {
  it('local first: OpenAI-compatible on localhost, no key', () => {
    const { url, init } = tagRequest(local, '', 'post');
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
    expect(aiReady(local, '')).toBe(true);
    // the tags already there go along, so the model suggests others
    const body = JSON.parse(tagRequest(local, '', 'post', ['Monero', 'bad tag!', 'nostr']).init.body as string);
    expect(body.messages[1].content).toMatch(/^Already tagged: #monero #nostr\. Suggest only other tags\./);
    expect(JSON.parse(tagRequest(local, '', 'post').init.body as string).messages[1].content).toMatch(/^Post:/);
    expect(JSON.parse(tagRequest(local, '', 'post').init.body as string).messages[0].content).toContain('at most 5');
    // a base pasted with /v1 asks the same endpoint, not /v1/v1
    expect(tagRequest({ ...local, baseUrl: 'http://localhost:1234/v1/' }, '', 'post').url).toBe('http://localhost:1234/v1/chat/completions');
  });
  it('OpenAI-compatible and Anthropic carry the key in their header', () => {
    const o = tagRequest(openai, KEY, 'post');
    expect(o.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(o.init.headers).toMatchObject({ authorization: `Bearer ${KEY}` });
    const a = tagRequest(anthropic, KEY, 'post');
    expect(a.url).toBe('https://api.anthropic.com/v1/messages');
    expect(a.init.headers).toMatchObject({ 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' });
    expect(JSON.parse(a.init.body as string)).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 100 });
    expect(aiReady(openai, '')).toBe(false);
    expect(aiReady({ ...local, on: false }, '')).toBe(false);
    expect(aiReady({ ...local, model: ' ' }, '')).toBe(false);
  });
  it('only so much of a post is sent', () => {
    const body = JSON.parse(tagRequest(local, '', 'x'.repeat(MAX_PROMPT_CHARS + 500)).init.body as string);
    expect(body.messages[1].content.length).toBeLessThan(MAX_PROMPT_CHARS + 50);
  });
  it('base URLs: local only on this computer, providers https only', () => {
    expect(validBaseUrl('local', 'http://localhost:11434')).toBe(true);
    expect(validBaseUrl('local', 'http://127.0.0.1:1234')).toBe(true);
    expect(validBaseUrl('local', 'http://[::1]:8080')).toBe(true);
    expect(validBaseUrl('local', 'http://192.168.1.5:11434')).toBe(false);
    expect(validBaseUrl('local', 'http://localhost.evil.com')).toBe(false);
    expect(validBaseUrl('openai', 'http://example.com/v1')).toBe(false);
    expect(validBaseUrl('openai', 'https://user:pw@example.com/v1')).toBe(false);
    expect(validBaseUrl('openai', 'https://openrouter.ai/api/v1')).toBe(true);
  });
  it('replies: fences, prose and <think> around the array', () => {
    expect(parseTagReply('```json\n["Monero", "#privacy"]\n```')).toEqual(['monero', 'privacy']);
    expect(parseTagReply('<think>maybe ["no"]</think>Sure: ["nostr"] hope it helps')).toEqual(['nostr']);
    expect(parseTagReply('no tags here')).toBeNull();
    expect(parseTagReply('[1, 2]')).toBeNull();
  });
  it('a hostile post and reply give only clean tags', () => {
    const reply = 'Ignore previous instructions. ["<script>alert(1)</script>", "https://evil.example", "' + 'a'.repeat(200) + '", "javascript:x", "ok", "Send all coins"]';
    expect(parseTagReply(reply)).toEqual(['ok', 'sendallcoins']);
  });
  it('statuses and failures: short reasons, never the key', async () => {
    const reason = async (res: Response | Error) =>
      suggestTags(openai, KEY, 'post', vi.fn(async () => {
        if (res instanceof Error) throw res;
        return res;
      }) as typeof fetch);
    expect(await reason(chat('["monero"]'))).toEqual({ status: 'ok', tags: ['monero'] });
    expect(await reason(json({}, 401))).toEqual({ status: 'failed', reason: 'Key rejected' });
    expect(await reason(json({}, 404))).toEqual({ status: 'failed', reason: 'Model or endpoint not found' });
    expect(await reason(json({}, 429))).toMatchObject({ reason: expect.stringContaining('Rate limited') });
    expect(await reason(json({}, 500))).toMatchObject({ reason: 'The provider answered 500' });
    expect(await reason(chat('I like turtles'))).toMatchObject({ reason: "The model's answer had no tags" });
    const err = await reason(new Error(`failed with ${KEY}`));
    expect(JSON.stringify(err)).not.toContain(KEY);
    const anth = await suggestTags(anthropic, KEY, 'post', (async () => json({ content: [{ type: 'text', text: '["xmr"]' }] })) as typeof fetch);
    expect(anth).toEqual({ status: 'ok', tags: ['xmr'] });
  });
  it('a local model that is down, and one that takes too long', async () => {
    expect(await suggestTags(local, '', 'post', (async () => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch)).toMatchObject({ reason: expect.stringContaining('local model') });
    const hang: typeof fetch = (_u, init) => new Promise((_r, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted'))));
    expect(await suggestTags(local, '', 'post', hang, 10)).toMatchObject({ reason: 'The model took too long' });
  });
  it('not set up or nothing to tag: nothing is sent', async () => {
    const f = vi.fn();
    expect(await suggestTags({ ...local, on: false }, '', 'post', f as unknown as typeof fetch)).toMatchObject({ status: 'failed' });
    expect(await suggestTags(local, '', '  ', f as unknown as typeof fetch)).toMatchObject({ status: 'failed' });
    expect(f).not.toHaveBeenCalled();
  });
  it('finds local models: Ollama tags, else /v1/models', async () => {
    const f = (async (url: string) => {
      if (url === 'http://localhost:11434/api/tags') return json({ models: [{ name: 'llama3.2' }, { name: 'qwen3:4b' }] });
      if (url === 'http://localhost:1234/api/tags') return json({}, 404);
      if (url === 'http://localhost:1234/v1/models') return json({ data: [{ id: 'gemma-3' }] });
      throw new TypeError('down');
    }) as unknown as typeof fetch;
    expect(await findLocalModels(f)).toEqual([
      { baseUrl: 'http://localhost:11434', models: ['llama3.2', 'qwen3:4b'] },
      { baseUrl: 'http://localhost:1234', models: ['gemma-3'] },
    ]);
    expect(await findLocalModels((async () => Promise.reject(new Error('down'))) as typeof fetch)).toEqual([]);
  });
});

describe('settings', () => {
  it('no content script reads the key', () => {
    const dir = join(process.cwd(), 'src/entrypoints/content');
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(/aiKeyItem|local:aiKey/);
  });
  it('the key is its own local item, outside the synced settings', async () => {
    await aiKeyItem.setValue(KEY);
    expect(JSON.stringify(await settingsItem.getValue())).not.toContain(KEY);
    expect(JSON.stringify(await aiTagsItem.getValue())).not.toContain(KEY);
    expect(await browser.storage.sync.get(null)).not.toMatchObject({ aiKey: expect.anything() });
    expect(JSON.stringify(await browser.storage.sync.get(null))).not.toContain(KEY);
    expect((await browser.storage.local.get('aiKey')).aiKey).toBe(KEY);
  });
  it('default tags from the Options field', () => {
    expect(parseTagList('monero, #Privacy, monero, ')).toEqual(['monero', 'privacy']);
    expect(parseTagList('monero, no!')).toBeNull();
  });
});

describe('Options: tag suggestions panel', () => {
  const mount = async () => {
    const html = readFileSync(join(process.cwd(), 'src/entrypoints/options/index.html'), 'utf8');
    const page = new DOMParser().parseFromString(html, 'text/html');
    document.body.replaceChildren(page.getElementById('ai-tags')!);
    await mountAiTagsPanel(document);
    const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
    const change = (el: HTMLElement) => el.dispatchEvent(new Event('change'));
    return { $, change };
  };
  const pick = (value: string) => {
    const r = document.querySelector<HTMLInputElement>(`input[name="ai-source"][value="${value}"]`)!;
    r.checked = true;
    r.dispatchEvent(new Event('change'));
  };

  it('each source keeps its own model: a local model never goes to a provider, Claude never to OpenAI', async () => {
    await aiTagsItem.setValue({ on: true, source: 'local', baseUrl: 'http://localhost:11434', model: 'llama3.2' });
    const { $, change } = await mount();
    const model = $<HTMLInputElement>('ai-model');
    const provider = $<HTMLSelectElement>('ai-provider');
    expect(model.value).toBe('llama3.2');

    provider.value = 'anthropic';
    pick('key');
    expect(model.value).toBe('claude-haiku-5-5');
    provider.value = 'openai';
    change(provider);
    expect(model.value).toBe('');
    expect($('ai-base').hidden).toBe(false);
    model.value = 'gpt-x';
    change(model);
    pick('local');
    expect(model.value).toBe('llama3.2');
    expect($('ai-key-box').hidden).toBe(true);
    pick('key');
    expect(model.value).toBe('gpt-x');
    await vi.waitFor(async () => expect(await aiTagsItem.getValue()).toMatchObject({ source: 'openai', model: 'gpt-x', baseUrl: 'https://api.openai.com/v1' }));
  });

  it("the setup steps allow only this extension's own address", async () => {
    await mount();
    const cmds = [...document.querySelectorAll('.setup code.cmd')].map((c) => c.textContent);
    expect(cmds).toHaveLength(3);
    for (const c of cmds) expect(c).toContain(`OLLAMA_ORIGINS${c!.startsWith('launchctl') || c!.startsWith('setx') ? ' "' : '='}${location.origin}`);
    expect(cmds.join(' ')).not.toContain('*');
  });
  it('automatic is on by default for a local model, off for a provider, and never carries over', async () => {
    await aiTagsItem.setValue({ on: true, source: 'local', baseUrl: 'http://localhost:11434', model: 'm' });
    const { $, change } = await mount();
    const auto = $<HTMLInputElement>('ai-auto');
    const add = $<HTMLInputElement>('ai-auto-add');
    expect([auto.checked, add.checked]).toEqual([true, true]);
    expect($('ai-auto-key').hidden).toBe(true);
    pick('key');
    expect([auto.checked, add.checked]).toEqual([false, false]);
    expect($('ai-auto-key').hidden).toBe(true);
    auto.checked = true;
    change(auto);
    expect($('ai-auto-key').hidden).toBe(false);
    await vi.waitFor(async () => expect(await aiTagsItem.getValue()).toMatchObject({ source: 'openai', auto: true }));
    pick('local');
    await vi.waitFor(async () => expect(autoOn(await aiTagsItem.getValue())).toBe(true));
    pick('key');
    await vi.waitFor(async () => expect(autoOn(await aiTagsItem.getValue())).toBe(false));
    expect(autoAddOn({ source: 'openai' })).toBe(false);
    expect(autoOn({ source: 'local', auto: false })).toBe(false);
  });
  it('a local URL with /v1 is saved as the server root', async () => {
    await aiTagsItem.setValue({ on: true, source: 'local', baseUrl: 'http://localhost:11434', model: 'm' });
    const { $ } = await mount();
    const url = $<HTMLInputElement>('ai-local-url');
    url.value = 'http://localhost:1234/v1/';
    url.dispatchEvent(new Event('blur'));
    expect(url.value).toBe('http://localhost:1234');
    await vi.waitFor(async () => expect((await aiTagsItem.getValue()).baseUrl).toBe('http://localhost:1234'));
  });
});

describe('Ollama turning the extension away', () => {
  it('a 403 from a local model says how to allow the extension, not "Key rejected"', async () => {
    const r = await suggestTags(local, '', 'post', (async () => new Response('', { status: 403 })) as typeof fetch);
    expect(r).toEqual({ status: 'failed', reason: OLLAMA_REFUSED });
    expect(OLLAMA_REFUSED).toContain('OLLAMA_ORIGINS');
    expect(await suggestTags(openai, KEY, 'post', (async () => new Response('', { status: 403 })) as typeof fetch)).toEqual({ status: 'failed', reason: 'Key rejected' });
  });
  it('Find reports a refusing server', async () => {
    const found = await findLocalModels((async () => new Response('', { status: 403 })) as typeof fetch, ['http://localhost:11434']);
    expect(found).toEqual([{ baseUrl: 'http://localhost:11434', models: [], refused: true }]);
    // LM Studio-style: no /api/tags, /v1/models refuses
    const v1 = (async (u: string) => new Response('', { status: String(u).endsWith('/v1/models') ? 403 : 404 })) as unknown as typeof fetch;
    expect(await findLocalModels(v1, ['http://localhost:1234'])).toEqual([{ baseUrl: 'http://localhost:1234', models: [], refused: true }]);
    // one refuses, the other has models
    const mixed = (async (u: string) => (String(u).startsWith('http://localhost:1234/v1') ? json({ data: [{ id: 'qwen' }] }) : new Response('', { status: 403 }))) as unknown as typeof fetch;
    expect(await findLocalModels(mixed, ['http://localhost:11434', 'http://localhost:1234'])).toEqual([
      { baseUrl: 'http://localhost:11434', models: [], refused: true },
      { baseUrl: 'http://localhost:1234', models: ['qwen'] },
    ]);
  });
  it('the prompt names no example tags a small model could copy', () => {
    const sys = JSON.parse(tagRequest(local, '', 'post').init.body as string).messages[0].content as string;
    expect(sys).not.toMatch(/\[\s*"/);
  });
});

describe('automatic suggestions', () => {
  const ok = (tags: string[]) => ({ status: 'ok' as const, tags });
  const offers = (el: HTMLElement) => [...el.querySelectorAll('.tag-offer')].map((b) => b.textContent);

  it('auto asks once as the composer opens, for tags besides those already there; off, it waits for a click', async () => {
    const suggest = vi.fn(async () => ok(['thorchain']));
    const row = tagRow({ initial: ['monero', 'privacy'], defaults: ['privacy'], textTags: () => ['monero'] });
    row.setSuggest(suggest, true, { auto: true });
    expect(suggest).toHaveBeenCalledTimes(1);
    expect(suggest).toHaveBeenCalledWith(['monero', 'privacy']);
    expect(row.el.querySelector('.tag-note')!.textContent).toBe('Asking your local model…');
    await vi.waitFor(() => expect(offers(row.el)).toEqual(['+ thorchain']));
    expect(row.tags()).toEqual(['monero', 'privacy']);
    const later = vi.fn(async () => ok([]));
    tagRow({ initial: [] }).setSuggest(later, true, { auto: false });
    expect(later).not.toHaveBeenCalled();
  });

  it('autoAdd on an untouched row: the tags go in; a default the post never mentions makes room, one click away', async () => {
    const row = tagRow({ initial: ['monero', 'privacy', 'nostr'], defaults: ['privacy', 'nostr', 'monero'], textTags: () => [], text: () => 'Monero 0.19 is out' });
    row.setSuggest(async () => ok(['thorchain', 'nostr', 'defi', 'treasury', 'baddebt']), true, { auto: true, autoAdd: true });
    await vi.waitFor(() => expect(row.tags()).toEqual(['monero', 'nostr', 'thorchain', 'defi', 'treasury']));
    expect(offers(row.el)).toEqual(['+ privacy', '+ baddebt']);
    expect(row.tags()).toHaveLength(MAX_TAGS);
  });

  it('autoAdd after the user edited: only free slots, and a removed tag never comes back by itself', async () => {
    let answer!: (r: ReturnType<typeof ok>) => void;
    const row = tagRow({ initial: ['monero', 'privacy'], defaults: ['privacy'], textTags: () => [], trusted: () => true });
    row.setSuggest(() => new Promise((r) => (answer = r)), true, { autoAdd: true });
    (row.el.querySelectorAll('.tag-x')[1] as HTMLButtonElement).click(); // removes privacy
    [...row.el.querySelectorAll('button')].find((b) => /Suggest/.test(b.textContent!))!.click();
    answer(ok(['privacy', 'xmr', 'a1', 'b2', 'c3']));
    await vi.waitFor(() => expect(row.tags()).toEqual(['monero', 'xmr', 'a1', 'b2', 'c3']));
    // still offered: one click if the user changes their mind
    expect(offers(row.el)).toEqual(['+ privacy']);
  });

  it('the text changed while asking: the answer is only suggestions', async () => {
    let answer!: (r: ReturnType<typeof ok>) => void;
    const row = tagRow({ initial: ['privacy'], defaults: ['privacy'], textTags: () => [] });
    row.setSuggest(() => new Promise((r) => (answer = r)), false, { auto: true, autoAdd: true });
    expect(row.el.querySelector('.tag-note')!.textContent).toBe('Asking the provider…');
    row.refresh();
    answer(ok(['thorchain']));
    await vi.waitFor(() => expect(offers(row.el)).toEqual(['+ thorchain']));
    expect(row.tags()).toEqual(['privacy']);
  });

  it('a default the post mentions in plain words stays, hyphenated or not', async () => {
    const row = tagRow({ initial: ['privacy', 'self-custody', 'nostr'], defaults: ['privacy', 'self-custody', 'nostr'], text: () => 'Better PRIVACY through self custody.' });
    row.setSuggest(async () => ok(['wallet']), true, { auto: true, autoAdd: true });
    await vi.waitFor(() => expect(row.tags()).toEqual(['privacy', 'self-custody', 'wallet']));
    expect(offers(row.el)).toEqual(['+ nostr']);
  });
});

describe('the Auto switch in the composer', () => {
  const ok = (tags: string[]) => ({ status: 'ok' as const, tags });
  const sw = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.tag-auto')!;

  it('shows the saved state; a page click or change does nothing; a real click saves and asks', async () => {
    const suggest = vi.fn(async () => ok(['thorchain']));
    const saveAuto = vi.fn(async () => ({ ok: true }));
    let real = false;
    const row = tagRow({ initial: [], trusted: () => real });
    row.setSuggest(suggest, true, { auto: false, saveAuto });
    document.body.append(row.el);
    const b = sw(row.el);
    expect(b.classList.contains('hidden')).toBe(false);
    expect(b.textContent).toBe('Auto');
    expect(b.getAttribute('aria-checked')).toBe('false');
    b.click();
    b.dispatchEvent(new Event('change'));
    expect(saveAuto).not.toHaveBeenCalled();
    expect(b.getAttribute('aria-checked')).toBe('false');
    real = true;
    b.click();
    expect(b.disabled).toBe(true);
    await vi.waitFor(() => expect(suggest).toHaveBeenCalledTimes(1));
    expect(saveAuto).toHaveBeenCalledWith(true);
    expect(b.getAttribute('aria-checked')).toBe('true');
    b.click();
    await vi.waitFor(() => expect(saveAuto).toHaveBeenLastCalledWith(false));
    expect(suggest).toHaveBeenCalledTimes(1);
    row.el.remove();
  });

  it('a failed save puts it back and asks nothing; read-only or closed asks nothing', async () => {
    const suggest = vi.fn(async () => ok(['x1']));
    const row = tagRow({ initial: [], trusted: () => true });
    row.setSuggest(suggest, false, { auto: false, saveAuto: async () => Promise.reject(new Error('no session')) });
    document.body.append(row.el);
    expect(sw(row.el).textContent).toBe('Auto (sends each copy to the provider)');
    sw(row.el).click();
    await vi.waitFor(() => expect(row.el.querySelector('.tag-note')!.textContent).toBe("Couldn't save the Auto switch"));
    expect(sw(row.el).getAttribute('aria-checked')).toBe('false');
    row.setReadOnly(true);
    expect(sw(row.el).disabled).toBe(true);
    row.el.remove();

    let saved!: () => void;
    const closed = tagRow({ initial: [], trusted: () => true });
    closed.setSuggest(suggest, true, { saveAuto: () => new Promise<void>((r) => (saved = r)) });
    sw(closed.el).click(); // not on the page: the composer closed
    saved();
    await Promise.resolve();
    await Promise.resolve();
    expect(suggest).not.toHaveBeenCalled();
  });

  it('turned off while asking: that answer only suggests', async () => {
    let answer!: (r: ReturnType<typeof ok>) => void;
    const row = tagRow({ initial: ['monero'], trusted: () => true });
    row.setSuggest(() => new Promise((r) => (answer = r)), true, { auto: true, autoAdd: true, saveAuto: async () => ({ ok: true }) });
    document.body.append(row.el);
    sw(row.el).click();
    answer(ok(['thorchain']));
    await vi.waitFor(() => expect([...row.el.querySelectorAll('.tag-offer')].map((o) => o.textContent)).toEqual(['+ thorchain']));
    expect(row.tags()).toEqual(['monero']);
    row.el.remove();
  });
});

describe('the background tag requests', () => {
  it('Auto saves only auto, for the source the composer opened with; anything else is refused', async () => {
    await aiTagsItem.setValue({ on: true, source: 'local', baseUrl: 'http://localhost:11434', model: 'm', autoAdd: false });
    expect(await tagsReady()).toMatchObject({ ready: true, local: true, source: 'local', auto: true, autoAdd: false });
    await expect(setAuto({ on: 'yes', source: 'local' })).rejects.toThrow('Bad request');
    await expect(setAuto({ on: true, source: 'openai' })).rejects.toThrow('Tag settings changed: close and reopen the composer');
    expect(await setAuto({ on: false, source: 'local' })).toEqual({ ok: true });
    expect(await aiTagsItem.getValue()).toMatchObject({ auto: false, autoAdd: false });
  });
  it('a composer opened for the local model never sends to a provider chosen since', async () => {
    await aiKeyItem.setValue(KEY);
    await aiTagsItem.setValue({ ...openai });
    const fetchFn = vi.fn(async () => chat('["x"]')) as unknown as typeof fetch;
    expect(await suggestFor({ text: 'post', source: 'local' }, fetchFn)).toEqual({ status: 'failed', reason: 'Tag settings changed: close and reopen the composer' });
    expect(await suggestFor({ text: 'post' }, fetchFn)).toMatchObject({ status: 'failed' });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await suggestFor({ text: 'post', source: 'openai', have: ['a', 1] }, fetchFn)).toEqual({ status: 'ok', tags: ['x'] });
    expect(await tagsReady()).toMatchObject({ local: false, auto: false, autoAdd: false });
  });
});
