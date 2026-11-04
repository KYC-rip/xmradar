import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_SYNCED, recordSynced, syncedLink, type SyncedPosts } from '../src/nostr/synced';
import { markPosts, SYNCED_TAG, topRightRow } from '../src/entrypoints/content/x-synced';

// PLAN-SYNCEDMARK
const NEVENT = 'nevent1qqsrhuxx8l9ex335q7he0f09aej04zpazpl0ne2cgukyawd24mayt8g2lcy6q';
const NADDR = 'naddr1qqxnzd3cxqmrzv3exgmr2wfeqgsxu35yyt0mwjjh8pcz4zprhxegz69t4wr9t74vk6zne58wzh0waycrqsqqqa28pccpzu';

describe('recordSynced', () => {
  it('keeps the newest entries up to the cap; the same post again moves forward', () => {
    let m: SyncedPosts = {};
    for (let i = 1; i <= 5; i++) m = recordSynced(m, String(i), { ref: NEVENT, kind: 'note', at: i }, 3);
    expect(Object.keys(m).sort()).toEqual(['3', '4', '5']);
    m = recordSynced(m, '3', { ref: NEVENT, kind: 'note', at: 9 }, 3);
    m = recordSynced(m, '6', { ref: NEVENT, kind: 'note', at: 10 }, 3);
    expect(Object.keys(m).sort()).toEqual(['3', '5', '6']);
    expect(MAX_SYNCED).toBe(1000);
  });
  it('ignores anything that isn’t a status id', () => {
    const m = recordSynced({}, '__proto__', { ref: NEVENT, kind: 'note', at: 1 });
    expect(Object.keys(m)).toEqual([]);
  });
});

describe('syncedLink', () => {
  it('notes open on ros.rip, articles on njump, as after publishing', () => {
    expect(syncedLink({ ref: NEVENT, kind: 'note', at: 1 })).toBe(`https://app.ros.rip/nostr/note/${NEVENT}`);
    expect(syncedLink({ ref: NADDR, kind: 'article', at: 1 })).toBe(`https://njump.me/${NADDR}`);
  });
  it('a ref that isn’t one, or of the wrong kind, gives no link', () => {
    for (const ref of ['nevent1', 'npub1abcdefgh', `${NEVENT}/x`, 'javascript:alert(1)', `${NEVENT}#a`]) expect(syncedLink({ ref, kind: 'note', at: 1 })).toBeNull();
    expect(syncedLink({ ref: NADDR, kind: 'note', at: 1 })).toBeNull();
    expect(syncedLink({ ref: NEVENT, kind: 'article', at: 1 })).toBeNull();
  });
});

describe('the mark on X', () => {
  // a tweet: its own time link, a quoted tweet with its own time link, and the top-right row (Grok, More)
  const tweet = (id: string, quoted = '999') => `
    <article data-testid="tweet" id="t${id}">
      <a href="/XBToshi/status/${id}"><time datetime="2026-11-04">8h</time></a>
      <div><div id="row${id}"><div><button aria-label="Grok actions"></button></div><div><div><button data-testid="caret"></button></div></div></div></div>
      <div role="link"><a href="/THORChain/status/${quoted}"><time>10h</time></a></div>
    </article>`;
  const setup = () => (document.body.innerHTML = tweet('1') + tweet('2'));
  const synced = (ids: string[]): SyncedPosts => Object.fromEntries(ids.map((id) => [id, { ref: NEVENT, kind: 'note' as const, at: 1 }]));
  const marks = () => [...document.querySelectorAll<HTMLElement>(SYNCED_TAG)];

  it('goes first in the top-right row, in front of Grok, on copied posts only', () => {
    setup();
    markPosts(document, synced(['1']));
    expect(marks().map((m) => m.dataset.status)).toEqual(['1']);
    const row = document.getElementById('row1')!;
    expect(row.firstElementChild!.localName).toBe(SYNCED_TAG);
    expect(row.children[1]!.querySelector('[aria-label="Grok actions"]')).not.toBeNull();
    const a = marks()[0]!.shadowRoot!.querySelector('a')!;
    expect(a.getAttribute('href')).toBe(`https://app.ros.rip/nostr/note/${NEVENT}`);
    expect(a.rel).toBe('noopener noreferrer');
    expect(a.textContent).toBe('Nostr ✓');
  });

  it('once per post across passes; a quoted post’s id doesn’t mark the post quoting it', () => {
    setup();
    markPosts(document, synced(['1', '999']));
    markPosts(document, synced(['1', '999']));
    expect(marks().map((m) => m.dataset.status)).toEqual(['1']);
    expect(topRightRow(document.getElementById('t2')!)).toBe(document.getElementById('row2'));
  });

  it('goes when the post is no longer in the map', () => {
    setup();
    markPosts(document, synced(['1', '2']));
    expect(marks().length).toBe(2);
    markPosts(document, synced(['2']));
    expect(marks().map((m) => m.dataset.status)).toEqual(['2']);
  });

  it('a post copied again gets the new copy’s mark; a stray mark elsewhere in the post goes', () => {
    setup();
    markPosts(document, synced(['1']));
    const NEVENT2 = NEVENT.slice(0, -4) + 'qqqq';
    markPosts(document, { '1': { ref: NEVENT2, kind: 'note', at: 2 } });
    expect(marks().length).toBe(1);
    expect(marks()[0]!.shadowRoot!.querySelector('a')!.getAttribute('href')).toContain(NEVENT2);
    // X moved our mark out of the row
    document.getElementById('t1')!.prepend(marks()[0]!);
    markPosts(document, { '1': { ref: NEVENT2, kind: 'note', at: 2 } });
    expect(marks().length).toBe(1);
    expect(document.getElementById('row1')!.firstElementChild!.localName).toBe(SYNCED_TAG);
  });

  it('a click on the mark doesn’t reach X’s handler for the post', () => {
    setup();
    markPosts(document, synced(['1']));
    let reached = false;
    document.getElementById('t1')!.addEventListener('click', () => (reached = true));
    const a = marks()[0]!.shadowRoot!.querySelector('a')!;
    a.addEventListener('click', (e) => e.preventDefault());
    a.click();
    expect(reached).toBe(false);
  });

  it('quote pictures hide it', () => {
    expect(readFileSync(join(process.cwd(), 'src/entrypoints/content/quote-shot.ts'), 'utf8')).toMatch(/OVERLAYS = '[^']*xmradar-synced/);
  });
});
