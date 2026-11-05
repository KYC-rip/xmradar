import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContentScriptContext } from 'wxt/utils/content-script-context';
import { fitCopy, MAX_COPY_BYTES, startShare, type ShareCopy } from '../src/ripley/share';
import { applyState } from '../src/ripley/storage';

// as in the Ripley build: XMRadar's storage is the shim Ripley pushes into
vi.mock('wxt/utils/storage', async () => import('../src/ripley/storage'));

// "Copy to Nostr" inside Ripley (ripley-os plans/x-app-xmradar.md, phase 3 P1)
const raw = readFileSync(join(process.cwd(), 'tests/fixtures/x-share-menu.html'), 'utf8');
const ID = '2113662765525282909';
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
const post = (text: string, images = 0) => ({ site: 'x', text, images: Array.from({ length: images }, (_, i) => ({ url: `https://pbs.twimg.com/media/${i}.jpg` })), sourceUrl: `https://x.com/a/status/${ID}` });

describe('fitCopy', () => {
  it('a short post goes whole', () => {
    const r = fitCopy(ID, post('gm'));
    expect(r).toEqual({ type: 'share-copy', statusId: ID, post: { text: 'gm', images: [], sourceUrl: `https://x.com/a/status/${ID}` } });
  });
  it('a long post is cut to fit the bridge, whole characters, and says so', () => {
    const r = fitCopy(ID, post('ɱ😀'.repeat(15_000), 9));
    expect(bytes(r)).toBeLessThanOrEqual(MAX_COPY_BYTES);
    expect(r.truncated).toBe(true);
    expect(r.post.images).toHaveLength(4);
    // no half emoji at the end
    expect([...r.post.text].every((c) => c === 'ɱ' || c === '😀')).toBe(true);
    // as long as it can be
    expect(bytes(fitCopy(ID, post(r.post.text + 'ɱ😀')).post)).toBeGreaterThan(0);
    expect(bytes({ ...r, post: { ...r.post, text: r.post.text + '😀😀' } })).toBeGreaterThan(MAX_COPY_BYTES);
  });
});

describe('the share-menu item in Ripley', () => {
  let ctx: ContentScriptContext | null = null;
  afterEach(() => {
    ctx?.abort('test');
    ctx = null;
    document.body.replaceChildren();
    document.getElementById('layers')?.remove();
  });

  function setup() {
    const doc = new DOMParser().parseFromString(raw, 'text/html');
    const menu = doc.querySelector('#layers > div')!;
    menu.remove();
    document.body.replaceChildren(...[...doc.body.childNodes].map((n) => document.importNode(n, true)));
    const share = document.querySelector<HTMLButtonElement>('article button[aria-haspopup="menu"]:not([data-testid])')!;
    const openMenu = () => {
      share.setAttribute('aria-expanded', 'true');
      document.getElementById('layers')!.append(document.importNode(menu, true));
    };
    return { share, openMenu };
  }
  const trustedClick = (el: Element) => {
    const e = new MouseEvent('click', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'isTrusted', { value: true });
    el.dispatchEvent(e);
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('a trusted share click, then the item → one share-copy for that post; nothing is published here', async () => {
    applyState({ 'sync:settings': { shareMenuX: true } });
    const { share, openMenu } = setup();
    const sent: ShareCopy[] = [];
    ctx = new ContentScriptContext('t');
    startShare(ctx, async (r) => void sent.push(r));
    await settle();
    trustedClick(share);
    openMenu();
    await settle();
    const item = document.querySelector('[data-xmradar="copy-to-nostr"]')!;
    expect(item).toBeTruthy();
    trustedClick(item);
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'share-copy', statusId: ID });
    expect(sent[0]!.post.sourceUrl).toContain(`/status/${ID}`);
    expect(bytes(sent[0])).toBeLessThanOrEqual(MAX_COPY_BYTES);
  });

  it('an untrusted click on the item sends nothing; switched off there is no item', async () => {
    applyState({ 'sync:settings': { shareMenuX: true } });
    const { share, openMenu } = setup();
    const send = vi.fn(async () => null);
    ctx = new ContentScriptContext('t');
    startShare(ctx, send);
    await settle();
    trustedClick(share);
    openMenu();
    await settle();
    document.querySelector('[data-xmradar="copy-to-nostr"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    expect(send).not.toHaveBeenCalled();
    applyState({ 'sync:settings': { shareMenuX: false } });
    document.getElementById('layers')!.replaceChildren();
    share.setAttribute('aria-expanded', 'false');
    trustedClick(share);
    openMenu();
    await settle();
    expect(document.querySelector('[data-xmradar="copy-to-nostr"]')).toBeNull();
  });
});
