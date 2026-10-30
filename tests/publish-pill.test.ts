// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { composerSlot, createPill, pillView, type ComposerInstance, type PillState } from '../src/entrypoints/content/publish-pill';

const ok = (relay: string) => ({ relay, ok: true, message: '' });
const timeout = (relay: string) => ({ relay, ok: false, message: 'timeout' });
const blocked = (relay: string) => ({ relay, ok: false, message: 'blocked: no' });
const published = (results: ReturnType<typeof ok>[]): PillState => ({
  kind: 'published',
  results,
  link: { href: 'https://app.ros.rip/nostr/note/nevent1x', label: 'View on ros.rip' },
  ref: 'nevent1x',
  copyLabel: 'Copy nevent',
});

describe('what the pill says', () => {
  it('each step before the relays answer', () => {
    expect(pillView({ kind: 'draft' }, 'note')).toEqual({ text: 'Draft not published', tone: 'info', retry: 0 });
    expect(pillView({ kind: 'uploading', index: 2, count: 3 }, 'note').text).toBe('Uploading image 2 of 3…');
    expect(pillView({ kind: 'uploading', index: 1, count: 1 }, 'note').text).toBe('Uploading image…');
    expect(pillView({ kind: 'signing' }, 'note').text).toBe('Waiting for signer…');
    expect(pillView({ kind: 'publishing' }, 'note').text).toBe('Publishing…');
    expect(pillView({ kind: 'retrying', count: 1 }, 'note')).toEqual({ text: 'Retrying 1 relay…', tone: 'info', retry: 0 });
    expect(pillView({ kind: 'retrying', count: 2 }, 'note').text).toBe('Retrying 2 relays…');
  });
  it('published everywhere: no Retry, View and Copy', () => {
    const v = pillView(published([ok('a'), ok('b')]), 'note');
    expect(v).toMatchObject({ text: 'Published to 2 relays', tone: 'ok', retry: 0, view: { label: 'View on ros.rip' }, copy: { ref: 'nevent1x', label: 'Copy nevent' } });
    expect(pillView(published([ok('a')]), 'note').text).toBe('Published to 1 relay');
  });
  it('published to some: Retry counts only failures worth retrying', () => {
    const v = pillView(published([ok('a'), timeout('b'), blocked('c')]), 'note');
    expect(v.text).toBe('Published to 1 of 3 relays');
    expect(v.retry).toBe(1);
  });
  it('accepted nowhere: note or article, Retry only when a failure can be retried', () => {
    expect(pillView({ kind: 'rejected', results: [timeout('a'), blocked('b')] }, 'note')).toEqual({ text: 'No relay accepted the note', tone: 'error', retry: 1 });
    expect(pillView({ kind: 'rejected', results: [blocked('a')] }, 'article')).toEqual({ text: 'No relay accepted the article', tone: 'error', retry: 0 });
  });
  it('an error shows its message', () => {
    expect(pillView({ kind: 'error', message: 'Signer refused' }, 'note')).toEqual({ text: 'Signer refused', tone: 'error', retry: 0 });
  });
});

describe('the pill', () => {
  afterEach(() => vi.useRealTimers());
  const handlers = () => ({ retry: vi.fn(), open: vi.fn(), dismiss: vi.fn() });
  const buttons = (el: HTMLElement) => [...el.querySelectorAll('.pill-actions > *')].map((b) => b.getAttribute('aria-label') ?? b.textContent);

  it('shows the status and the buttons that apply, which call their handlers', () => {
    const hs = handlers();
    const pill = createPill(hs);
    pill.update(pillView(published([ok('a'), timeout('b')]), 'note'));
    expect(pill.el.querySelector('.pill-text')!.textContent).toBe('Published to 1 of 2 relays');
    expect(pill.el.dataset.tone).toBe('ok');
    expect(buttons(pill.el)).toEqual(['Retry 1', 'View', 'Copy', 'Open', 'Dismiss']);
    const link = pill.el.querySelector('a')!;
    expect([link.href, link.target, link.rel]).toEqual(['https://app.ros.rip/nostr/note/nevent1x', '_blank', 'noopener']);
    for (const b of pill.el.querySelectorAll('button')) b.click();
    expect([hs.retry, hs.open, hs.dismiss].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
  });
  it('an update replaces the content; a message is text, never markup', () => {
    const pill = createPill(handlers());
    pill.update(pillView({ kind: 'signing' }, 'note'));
    expect(buttons(pill.el)).toEqual(['Open', 'Dismiss']);
    pill.update(pillView({ kind: 'error', message: '<b>bad</b>' }, 'note'));
    expect(pill.el.querySelector('.pill-text')!.textContent).toBe('<b>bad</b>');
    expect(pill.el.querySelector('b')).toBeNull();
    expect(pill.el.dataset.tone).toBe('error');
  });
  it('a notice shows for a while, then the status comes back', () => {
    vi.useFakeTimers();
    const pill = createPill(handlers());
    pill.update(pillView({ kind: 'publishing' }, 'note'));
    pill.notice('Still publishing the last post');
    expect(pill.el.querySelector('.pill-text')!.textContent).toBe('Still publishing the last post');
    vi.advanceTimersByTime(3000);
    expect(pill.el.querySelector('.pill-text')!.textContent).toBe('Publishing…');
  });
});

describe('one composer per page', () => {
  const instance = (s: Partial<{ busy: boolean; finished: boolean; expanded: boolean }> = {}) => {
    const i = { busy: () => !!s.busy, finished: () => !!s.finished, expanded: () => !!s.expanded, expand: vi.fn(), close: vi.fn(), notice: vi.fn() } satisfies ComposerInstance;
    return i;
  };

  it('none yet: opens, and nothing else opens while it mounts', () => {
    const slot = composerSlot();
    expect(slot.claim()).toBe('open');
    expect(slot.claim()).toBe('refuse');
    slot.mounted(null);
    expect(slot.claim()).toBe('open');
  });
  it('one expanded: a new copy is refused', () => {
    const slot = composerSlot();
    slot.claim();
    const a = instance({ expanded: true });
    slot.mounted(a);
    expect(slot.claim()).toBe('refuse');
    expect(a.close).not.toHaveBeenCalled();
  });
  it('one publishing as a pill: refused, and the pill says why', () => {
    const slot = composerSlot();
    slot.claim();
    const a = instance({ busy: true });
    slot.mounted(a);
    expect(slot.claim()).toBe('refuse');
    expect(a.notice).toHaveBeenCalledWith('Still publishing the last post');
    expect(a.close).not.toHaveBeenCalled();
  });
  it('a published one with nothing left to retry makes way', () => {
    const slot = composerSlot();
    slot.claim();
    const a = instance({ finished: true });
    slot.mounted(a);
    expect(slot.claim()).toBe('open');
    expect(a.close).toHaveBeenCalled();
  });
  it('a draft, a failed one or one with relays left to retry comes back instead of being lost', () => {
    const slot = composerSlot();
    slot.claim();
    const a = instance();
    slot.mounted(a);
    expect(slot.claim()).toBe('refuse');
    expect(a.expand).toHaveBeenCalled();
    expect(a.notice).toHaveBeenCalledWith('Finish or close this one first');
    expect(a.close).not.toHaveBeenCalled();
  });
  it('dismissed while publishing: released at once, so a new copy opens; a late release of it changes nothing', () => {
    const slot = composerSlot();
    slot.claim();
    const a = instance({ busy: true });
    slot.mounted(a);
    slot.release(a);
    expect(slot.claim()).toBe('open');
    const b = instance({ expanded: true });
    slot.mounted(b);
    // a finishes and removes itself
    slot.release(a);
    expect(slot.current).toBe(b);
  });
});
