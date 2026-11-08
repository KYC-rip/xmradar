import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanReply, cutShort, entitiesOf, lostEntities, outputTokens, writeGate, writeWith, writingRequest, xLength } from '../src/ai/writing';
import { captureTarget, editorsFor, putBack, startWriting, wordDiff, WRITE_BUTTON } from '../src/entrypoints/content/x-write';
import type { AiTagSettings } from '../src/settings';

// PLAN-XPROOFREAD
const LOCAL: AiTagSettings = { on: true, source: 'local', baseUrl: 'http://localhost:11434', model: 'qwen3' };
const ANTH: AiTagSettings = { on: true, source: 'anthropic', baseUrl: '', model: 'claude-haiku-5-5' };
const OPENAI: AiTagSettings = { on: true, source: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-x' };
const body = (r: { init: RequestInit }) => JSON.parse(String(r.init.body));

describe('the request', () => {
  it('local: no key, the chat endpoint, the mode prompt, no cookies or redirects', () => {
    const r = writingRequest(LOCAL, 'secret', 'proofread', 'helo wrld');
    expect(r.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(r.init).toMatchObject({ credentials: 'omit', redirect: 'error' });
    expect(JSON.stringify(r.init.headers)).not.toContain('secret');
    const b = body(r);
    expect(b.messages[0].content).toMatch(/proofread/i);
    expect(b.messages[0].content).toMatch(/not instructions/);
    expect(b.messages[1].content).toContain('helo wrld');
  });
  it('Anthropic and OpenAI-compatible: the key in their headers; each mode its own prompt', () => {
    const a = writingRequest(ANTH, 'k1', 'english', 'hola');
    expect((a.init.headers as Record<string, string>)['x-api-key']).toBe('k1');
    expect(body(a).system).toMatch(/translate/i);
    const o = writingRequest(OPENAI, 'k2', 'shorten', 'x');
    expect(o.url).toBe('https://api.openai.com/v1/chat/completions');
    expect((o.init.headers as Record<string, string>).authorization).toBe('Bearer k2');
    expect(body(o).messages[0].content).toMatch(/280/);
  });
  it('room for the answer grows with the text, capped', () => {
    expect(outputTokens('a'.repeat(100))).toBe(250);
    expect(outputTokens('a'.repeat(10_000))).toBe(3_000);
  });
});

describe('the answer', () => {
  it('without think blocks, fences, wrapping quotes and a lead-in', () => {
    expect(cleanReply('<think>hm</think>\nHello world')).toBe('Hello world');
    expect(cleanReply('```\nHello world\n```')).toBe('Hello world');
    expect(cleanReply('"Hello world"', 'helo wrld')).toBe('Hello world');
    expect(cleanReply('"Hello world"', '"helo wrld"')).toBe('"Hello world"');
    expect(cleanReply("Here's the corrected post:\n\nHello world")).toBe('Hello world');
    expect(cleanReply('Hello: world\nsecond')).toBe('Hello: world\nsecond');
    expect(cleanReply('Here is the corrected post:\n```\nHello world\n```')).toBe('Hello world');
  });
  it('cut short at the token limit is caught', () => {
    expect(cutShort('anthropic', { stop_reason: 'max_tokens' })).toBe(true);
    expect(cutShort('local', { choices: [{ finish_reason: 'length' }] })).toBe(true);
    expect(cutShort('openai', { choices: [{ finish_reason: 'stop' }] })).toBe(false);
  });
  it('asks, and says plainly what went wrong', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Hello world.' }, finish_reason: 'stop' }] })));
    expect(await writeWith(LOCAL, '', 'proofread', 'helo wrld', new AbortController().signal, ok as unknown as typeof fetch)).toEqual({ status: 'ok', text: 'Hello world.' });
    expect(await writeWith({ ...LOCAL, on: false }, '', 'proofread', 'x', new AbortController().signal, ok as unknown as typeof fetch)).toMatchObject({ status: 'failed' });
    expect(await writeWith(LOCAL, '', 'proofread', 'x'.repeat(4_001), new AbortController().signal, ok as unknown as typeof fetch)).toMatchObject({ status: 'failed', reason: expect.stringMatching(/too long/i) });
    expect(await writeWith(LOCAL, '', 'rewrite' as never, 'x', new AbortController().signal, ok as unknown as typeof fetch)).toMatchObject({ status: 'failed' });
    const refused = (async () => new Response('', { status: 403 })) as typeof fetch;
    expect(await writeWith(LOCAL, '', 'proofread', 'x', new AbortController().signal, refused)).toMatchObject({ reason: expect.stringMatching(/OLLAMA_ORIGINS/) });
    const cut = (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Hel' }, finish_reason: 'length' }] }))) as typeof fetch;
    expect(await writeWith(LOCAL, '', 'proofread', 'x', new AbortController().signal, cut)).toMatchObject({ reason: expect.stringMatching(/cut short/) });
  });
  it('a newer request cancels the older one', async () => {
    const ctrl = new AbortController();
    const slow = ((_u: string, init: RequestInit) => new Promise((_, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted'))))) as typeof fetch;
    const p = writeWith(LOCAL, '', 'proofread', 'x', ctrl.signal, slow);
    ctrl.abort();
    expect(await p).toEqual({ status: 'failed', reason: 'Cancelled' });
  });
});

describe('the per-tab gate', () => {
  it('a new request cancels the old at once and starts 2 s after it; cancel and a closed tab abort', async () => {
    let t = 0;
    const waits: number[] = [];
    const g = writeGate(2_000, () => t, async (ms) => void waits.push(ms));
    const a = await g.start(1);
    t = 500;
    const b = await g.start(1);
    expect(a.aborted).toBe(true);
    expect(b.aborted).toBe(false);
    expect(waits).toEqual([1_500]);
    expect((await g.start(2)).aborted).toBe(false);
    g.cancel(1);
    expect(b.aborted).toBe(true);
    t = 10_000;
    const c = await g.start(1);
    g.closed(1);
    expect(c.aborted).toBe(true);
  });
});

describe('entities and the count', () => {
  it('mentions, tags, cashtags and links, normalized; a #tag inside a link is not one', () => {
    expect(entitiesOf('hi @Alice #XMR $xmr see https://Example.com/a/ and x.com#frag')).toEqual(['https://example.com/a', '@alice', '#xmr', '$xmr']);
    expect(entitiesOf('https://a.example/#top')).toEqual(['https://a.example/#top']);
    expect(entitiesOf('only $5 for $XMR')).toEqual(['$xmr']);
  });
  it('what got lost; Shorten may drop hashtags', () => {
    expect(lostEntities('gm @alice #xmr https://a.example', 'gm #xmr https://a.example/', 'proofread')).toEqual(['@alice']);
    expect(lostEntities('gm #xmr', 'gm', 'shorten')).toEqual([]);
    expect(lostEntities('gm #xmr', 'gm', 'proofread')).toEqual(['#xmr']);
  });
  it("X's count: links 23, CJK and emoji 2", () => {
    expect(xLength('hello')).toBe(5);
    expect(xLength('see https://example.com/a/very/long/path')).toBe(4 + 23);
    expect(xLength('日本')).toBe(4);
    expect(xLength('ok 👍')).toBe(5);
  });
});

describe('the word diff', () => {
  it('marks what went and what came', () => {
    expect(wordDiff('helo wrld today', 'hello world today')).toEqual([
      { kind: 'del', text: 'helo' },
      { kind: 'add', text: 'hello' },
      { kind: 'same', text: ' ' },
      { kind: 'del', text: 'wrld' },
      { kind: 'add', text: 'world' },
      { kind: 'same', text: ' today' },
    ]);
  });
});

// a stand-in for X's Draft editor: a paste replaces the selection with the pasted text
function fakeComposer(text: string, opts: { pasteWorks?: boolean } = {}) {
  document.body.innerHTML = `<div class="composer"><div data-testid="tweetTextarea_0" contenteditable="true"><div><span>${text}</span></div></div>
    <div data-testid="toolBar"><nav><div role="tablist"><div role="presentation"><button aria-label="Add emoji" aria-haspopup="menu"><svg></svg></button></div><div role="presentation"><button aria-label="Schedule post"><svg></svg></button></div></div></nav></div></div>`;
  const editor = document.querySelector<HTMLElement>('[data-testid="tweetTextarea_0"]')!;
  Object.defineProperty(editor, 'innerText', { get: () => editor.textContent ?? '' });
  if (opts.pasteWorks !== false)
    editor.addEventListener('paste', (e) => {
      const pasted = (e as ClipboardEvent).clipboardData!.getData('text/plain');
      const r = document.getSelection()!.getRangeAt(0);
      r.deleteContents();
      r.insertNode(document.createTextNode(pasted));
      e.preventDefault();
    });
  return { editor, toolbar: document.querySelector('[data-testid="toolBar"]')! };
}

describe('the draft', () => {
  afterEach(() => (document.body.innerHTML = ''));
  it("finds the composer's editor from its toolbar", () => {
    const { editor, toolbar } = fakeComposer('hi');
    expect(editorsFor(toolbar)).toEqual([editor]);
    document.body.innerHTML = '<div data-testid="toolBar"></div>';
    expect(editorsFor(document.querySelector('[data-testid="toolBar"]')!)).toEqual([]);
  });
  it('the whole draft, or only the selected words', () => {
    const { editor } = fakeComposer('helo wrld today');
    expect(captureTarget([editor], null)).toMatchObject({ editor, range: null, text: 'helo wrld today' });
    const r = document.createRange();
    const node = editor.querySelector('span')!.firstChild!;
    r.setStart(node, 0);
    r.setEnd(node, 9);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(r);
    expect(captureTarget([editor], null)).toMatchObject({ text: 'helo wrld', draft: 'helo wrld today' });
  });
  it('puts the answer back as a paste: the whole draft, or the selection only', async () => {
    const { editor } = fakeComposer('helo wrld today');
    expect(await putBack(captureTarget([editor], null)!, 'hello world today')).toBe(true);
    expect(editor.textContent).toBe('hello world today');
    const { editor: e2 } = fakeComposer('helo wrld today');
    const node = e2.querySelector('span')!.firstChild!;
    const r = document.createRange();
    r.setStart(node, 0);
    r.setEnd(node, 9);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(r);
    const t = captureTarget([e2], null)!;
    expect(await putBack(t, 'hello world')).toBe(true);
    expect(e2.textContent).toBe('hello world today');
  });
  it('a selected word that also appears earlier: the selected one is replaced and checked', async () => {
    const { editor } = fakeComposer('gm gm gm');
    const node = editor.querySelector('span')!.firstChild!;
    const r = document.createRange();
    r.setStart(node, 6);
    r.setEnd(node, 8);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(r);
    expect(await putBack(captureTarget([editor], null)!, 'GM')).toBe(true);
    expect(editor.textContent).toBe('gm gm GM');
  });
  it('pastes once the editor has the selection: on its selectionchange, without waiting out the 150 ms', async () => {
    const { editor } = fakeComposer('helo');
    const t = captureTarget([editor], null)!;
    const start = Date.now();
    const done = putBack(t, 'hello');
    document.dispatchEvent(new Event('selectionchange'));
    expect(await done).toBe(true);
    expect(Date.now() - start).toBeLessThan(150 + 30 + 60);
  });
  it('an editor that ignores the paste: false (no insertText fallback), for the copy fallback', async () => {
    const { editor } = fakeComposer('helo', { pasteWorks: false });
    const exec = vi.fn(() => true);
    document.execCommand = exec;
    expect(await putBack(captureTarget([editor], null)!, 'hello')).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('the button', () => {
  afterEach(() => (document.body.innerHTML = ''));
  const ctx = () => ({ onInvalidated: () => {} });
  it('next to the emoji button, once, only when ready; gone when switched off', async () => {
    fakeComposer('hi');
    let ready = true;
    let notify = () => {};
    startWriting(ctx(), { ready: async () => ({ ready, source: 'local' }), ask: vi.fn(), watch: (cb) => ((notify = cb), () => {}) });
    await vi.waitFor(() => expect(document.querySelectorAll(`.${WRITE_BUTTON}`)).toHaveLength(1));
    const items = [...document.querySelector('[role="tablist"]')!.children];
    expect(items[1]!.classList.contains(WRITE_BUTTON)).toBe(true);
    ready = false;
    notify();
    await vi.waitFor(() => expect(document.querySelectorAll(`.${WRITE_BUTTON}`)).toHaveLength(0));
  });
  it('not without an editor, and not when not ready', async () => {
    document.body.innerHTML = '<div data-testid="toolBar"><nav><div role="tablist"></div></nav></div>';
    startWriting(ctx(), { ready: async () => ({ ready: true, source: 'local' }), ask: vi.fn(), watch: () => () => {} });
    fakeComposer('hi');
    const off = document.createElement('div');
    document.body.append(off);
    await new Promise((r) => setTimeout(r, 300));
    // the composer added after start is found (observer), the bare toolbar never
    expect(document.querySelectorAll(`.${WRITE_BUTTON}`)).toHaveLength(1);
  });
});
