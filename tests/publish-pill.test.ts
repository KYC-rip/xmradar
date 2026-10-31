// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { composerDock, createPill, pillView, type ComposerInstance, type PillState } from '../src/entrypoints/content/publish-pill';

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

describe('several copies at once (PLAN-PARALLEL)', () => {
  type State = { busy?: boolean; finished?: boolean; expanded?: boolean };
  const instance = (st: State = {}) => {
    const i = {
      st,
      busy: () => !!st.busy,
      finished: () => !!st.finished,
      expanded: () => !!st.expanded,
      expand: vi.fn(() => void (st.expanded = true)),
      minimise: vi.fn(() => void (st.expanded = false)),
      close: vi.fn(),
      notice: vi.fn(),
      stack: vi.fn(),
    } satisfies ComposerInstance & { st: State };
    return i;
  };
  const open = (dock: ReturnType<typeof composerDock>, key: string, st: State = {}) => {
    expect(dock.claim(key)).toBe('open');
    const i = instance(st);
    dock.mounted(key, i);
    return i;
  };

  it('a copy publishing as a pill no longer blocks the next; pills stack oldest at the bottom', () => {
    const dock = composerDock();
    const a = open(dock, 'x:1', { busy: true });
    const b = open(dock, 'x:2', { busy: true });
    expect(a.close).not.toHaveBeenCalled();
    expect(a.stack).toHaveBeenLastCalledWith(0);
    expect(b.stack).toHaveBeenLastCalledWith(1);
  });
  it('an expanded draft goes back to its pill (kept, not closed) when another copy opens', () => {
    const dock = composerDock();
    const a = open(dock, 'x:1', { expanded: true });
    open(dock, 'x:2');
    expect(a.minimise).toHaveBeenCalled();
    expect(a.close).not.toHaveBeenCalled();
  });
  it('the same post: refused while mounting; brought back while open; reopened once published', () => {
    const dock = composerDock();
    expect(dock.claim('x:1')).toBe('open');
    expect(dock.claim('x:1')).toBe('refuse'); // double click before mount
    const a = instance();
    dock.mounted('x:1', a);
    const b = open(dock, 'x:2', { expanded: true });
    expect(dock.claim('x:1')).toBe('refuse');
    expect(b.minimise).toHaveBeenCalled();
    expect(a.expand).toHaveBeenCalled();
    expect(a.notice).toHaveBeenCalledWith('Already open');
    a.st.finished = true;
    expect(dock.claim('x:1')).toBe('open');
    expect(a.close).toHaveBeenCalled();
    dock.mounted('x:1', instance());
    expect(dock.size).toBe(2);
  });
  it('at most 5, mounting ones counted; a failed mount frees its place', () => {
    const dock = composerDock();
    for (let i = 0; i < 5; i++) expect(dock.claim(`x:${i}`)).toBe('open');
    expect(dock.claim('x:5')).toBe('refuse');
    dock.mounted('x:0', null);
    expect(dock.claim('x:5')).toBe('open');
  });
  it('at 5 with none finished: refused and the newest pill says so; a finished one makes room, oldest first', () => {
    const dock = composerDock();
    const all = [0, 1, 2, 3, 4].map((i) => open(dock, `x:${i}`, { busy: true }));
    expect(dock.claim('x:9')).toBe('refuse');
    expect(all[4]!.notice).toHaveBeenCalledWith('Up to 5 at a time: finish or close one');
    all[3]!.st.finished = true;
    all[1]!.st.finished = true;
    expect(dock.claim('x:9')).toBe('open');
    expect(all[1]!.close).toHaveBeenCalled();
    expect(all[3]!.close).not.toHaveBeenCalled();
  });
  it('opening one pill minimises the other expanded composer', () => {
    const dock = composerDock();
    const a = open(dock, 'x:1');
    const b = open(dock, 'x:2', { expanded: true });
    dock.focus(a);
    expect(b.minimise).toHaveBeenCalled();
    expect(a.minimise).not.toHaveBeenCalled();
  });
  it('an expanded composer takes no place: the pills close up, and again when it is minimised', () => {
    const dock = composerDock();
    const a = open(dock, 'x:1');
    const b = open(dock, 'x:2');
    const c = open(dock, 'x:3');
    a.st.expanded = true;
    dock.relayout();
    expect(b.stack).toHaveBeenLastCalledWith(0);
    expect(c.stack).toHaveBeenLastCalledWith(1);
    a.st.expanded = false;
    dock.relayout();
    expect(a.stack).toHaveBeenLastCalledWith(0);
    expect(c.stack).toHaveBeenLastCalledWith(2);
  });
  it('closing the middle pill re-stacks the rest; a repeated release changes nothing', () => {
    const dock = composerDock();
    const a = open(dock, 'x:1');
    const b = open(dock, 'x:2');
    const c = open(dock, 'x:3');
    dock.release(b);
    dock.release(b);
    expect(a.stack).toHaveBeenLastCalledWith(0);
    expect(c.stack).toHaveBeenLastCalledWith(1);
    expect(dock.size).toBe(2);
  });
});

