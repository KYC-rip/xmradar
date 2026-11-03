import { finalizeEvent, generateSecretKey, getPublicKey, type Event, type EventTemplate } from 'nostr-tools/pure';
import { describe, expect, it, vi } from 'vitest';
import {
  applyCheck,
  BASELINE_SECS,
  cleanName,
  freshInbox,
  INBOX_ALARM,
  inboxKeeper,
  MAX_ITEMS,
  namesFrom,
  noticeText,
  PER_TIPPER,
  shortNpub,
  sinceOf,
  SLACK_SECS,
  targetOf,
  type InboxDeps,
  type InboxItem,
  type InboxState,
} from '../src/xap/inbox';

const ADDR = '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';
const ADDR2 = '888tNkZrPN6JsEgekjMnABU4TBzc2Dt29EPAvkRxbANsAnjyPbb3iQ1YBRk1UXcdRsiKc9dhwMVgN5S9cQUiyoogDavup3H';
const meSk = generateSecretKey();
const ME = getPublicKey(meSk);
const aliceSk = generateSecretKey();
const ALICE = getPublicKey(aliceSk);
const bobSk = generateSecretKey();
const BOB = getPublicKey(bobSk);
const NOW = 1_800_000_000_000;
const NOW_S = NOW / 1000;
const POST = '2113662765525282909';
const NOTE = 'a'.repeat(64);

const sign = (sk: Uint8Array, t: Partial<EventTemplate>) => finalizeEvent({ kind: 9042, content: '', created_at: NOW_S - 600, tags: [], ...t } as EventTemplate, sk);
const tags = (opts: { to?: string; amount?: string; address?: string; target?: string[][] }) => [
  ['p', opts.to ?? ME],
  ...(opts.target ?? []),
  ['amount', opts.amount ?? '0.01'],
  ['unit', 'xmr'],
  ['address', opts.address ?? ADDR],
  ['v', 'nkip02/1'],
];
const receipt = (opts: { sk?: Uint8Array; to?: string; amount?: string; address?: string; target?: string[][]; ago?: number } = {}) =>
  sign(opts.sk ?? aliceSk, { tags: tags(opts), created_at: NOW_S - (opts.ago ?? 600) });
const onPost = [['i', `https://x.com/i/status/${POST}`], ['k', 'web']];
const done = (over: Partial<InboxState> = {}): InboxState => ({ ...freshInbox(ME), baseline: 'done', okAt: NOW - 30 * 60_000, ...over });
const run = (state: InboxState, events: Event[], now = NOW) => applyCheck(state, { me: ME, current: ADDR, events, now });

describe('targetOf', () => {
  it('names exactly one target: an X post, a note or the profile', () => {
    expect(targetOf({ tags: onPost })).toEqual({ kind: 'post', id: POST });
    expect(targetOf({ tags: [['e', NOTE]] })).toEqual({ kind: 'note', id: NOTE });
    expect(targetOf({ tags: [['p', ME]] })).toEqual({ kind: 'profile' });
  });
  it('drops mixed or malformed targets', () => {
    for (const t of [
      [['e', NOTE], ...onPost],
      [['i', `https://x.com/i/status/${POST}`]],
      [['i', `https://x.com/i/status/${POST}`], ['k', 'nostr']],
      [...onPost, ['i', 'https://x.com/i/status/1']],
      [['i', `https://twitter.com/i/status/${POST}`], ['k', 'web']],
      [['k', 'web']],
      [['e', NOTE], ['e', 'b'.repeat(64)]],
      [['e', 'nothex']],
    ])
      expect(targetOf({ tags: t })).toBeNull();
  });
});

describe('applyCheck', () => {
  it('lists and tells about a new Xap to the current address', () => {
    const r = receipt({ target: onPost });
    const { state, notify } = run(done(), [r]);
    expect(notify).toEqual([expect.objectContaining({ id: r.id, tipper: ALICE, amount: '0.01', target: { kind: 'post', id: POST }, state: 'claimed' })]);
    expect(state.items.map((i) => i.id)).toEqual([r.id]);
    expect(state).toMatchObject({ unread: 1, okAt: NOW, baseline: 'done' });
  });
  it('drops receipts to another key or address, self-tips, bad signatures, and ones outside the window', () => {
    const forged = { ...receipt(), sig: '0'.repeat(128) };
    const evs = [
      receipt({ to: BOB }),
      receipt({ address: ADDR2 }),
      receipt({ sk: meSk }),
      forged,
      receipt({ ago: -(11 * 60) }),
      receipt({ ago: Math.floor(NOW_S - sinceOf(done(), NOW)) + 10 }),
    ];
    const { state, notify } = run(done(), evs);
    expect(notify).toEqual([]);
    expect(state.items).toEqual([]);
  });
  it('the baseline lists everything and tells nothing; after it, new ones notify', () => {
    const old = receipt({ ago: 5 * 86_400 });
    const first = run(freshInbox(ME), [old]);
    expect(first.notify).toEqual([]);
    expect(first.state).toMatchObject({ baseline: 'done', unread: 0 });
    expect(first.state.items).toHaveLength(1);
    const later = receipt({ sk: bobSk });
    const second = run(first.state, [old, later], NOW + 30 * 60_000);
    expect(second.notify.map((i) => i.id)).toEqual([later.id]);
  });
  it('tells once per tipper and target a day, also after the list has moved on', () => {
    const a = receipt({ target: onPost, ago: 900 });
    let { state } = run(done(), [a]);
    // 60 others push the first out of the 50-line list
    const others = Array.from({ length: 60 }, (_, n) => receipt({ sk: generateSecretKey(), ago: 800 - n }));
    state = run(state, others, NOW + 60_000).state;
    expect(state.items.some((i) => i.id === a.id)).toBe(false);
    expect(state.items).toHaveLength(MAX_ITEMS);
    const again = receipt({ target: onPost, amount: '0.02', ago: 100 });
    const second = run(state, [again], NOW + 120_000);
    expect(second.notify).toEqual([]);
    expect(second.state.items[0]!.id).toBe(again.id);
    expect(second.state.unread).toBe(state.unread + 1);
    // a day later, the same tipper and post notify again
    const later = sign(aliceSk, { tags: tags({ target: onPost, amount: '0.03' }), created_at: NOW_S + 86_400 });
    expect(run(second.state, [later], NOW + 86_401_000).notify.map((i) => i.id)).toEqual([later.id]);
  });
  it('a replay of a seen receipt never notifies again while it can still come back', () => {
    const r = receipt();
    const { state } = run(done(), [r]);
    expect(run({ ...state, notified: [] }, [r], NOW + 60_000).notify).toEqual([]);
  });
  it('takes 20 per tipper per check and defers the rest to the next', () => {
    const many = Array.from({ length: PER_TIPPER + 5 }, (_, n) => receipt({ target: [['e', n.toString(16).padStart(64, '0')]], ago: 1000 - n }));
    const first = run(done(), many);
    expect(first.state.seen).toHaveLength(PER_TIPPER);
    const second = run(first.state, many, NOW + 60_000);
    expect(second.state.seen).toHaveLength(PER_TIPPER + 5);
  });
  it("prunes seen ids only once they're older than the window", () => {
    const state = done({ seen: [['x'.repeat(64), NOW_S - 10 * 86_400], ['y'.repeat(64), NOW_S - 600]] });
    expect(run(state, []).state.seen.map(([id]) => id[0])).toEqual(['y']);
  });
  it("marks a line verified by the user's own confirmation, unless withdrawn", () => {
    const r = receipt();
    const conf = finalizeEvent(
      { kind: 9044, content: '', created_at: NOW_S, tags: [['e', r.id], ['p', ALICE], ['amount', '0.01'], ['method', 'wallet-match'], ['t', 'f'.repeat(64)], ['v', 'nkip02/1']] },
      meSk,
    );
    expect(run(done(), [r, conf]).state.items[0]!.state).toBe('verified');
    const del = finalizeEvent({ kind: 5, content: '', created_at: NOW_S, tags: [['e', conf.id]] }, meSk);
    expect(run(done(), [r, conf, del]).state.items[0]!.state).toBe('claimed');
    // a confirmation arriving a check later turns the kept line verified
    const { state } = run(done(), [r]);
    expect(run(state, [r, conf], NOW + 60_000).state.items[0]!.state).toBe('verified');
  });
});

describe('sinceOf', () => {
  it('30 days back for the baseline, else 2 days before the last good check (never from receipt dates)', () => {
    expect(sinceOf(freshInbox(ME), NOW)).toBe(NOW_S - BASELINE_SECS);
    expect(sinceOf(done({ okAt: NOW - 3_600_000 }), NOW)).toBe(NOW_S - 3600 - SLACK_SECS);
  });
});

describe('names and text', () => {
  it('cleans a chosen name to one safe line of at most 24 graphemes', () => {
    const [RLO, ZWSP, LS, PS, NUL] = [0x202e, 0x200b, 0x2028, 0x2029, 0].map((c) => String.fromCodePoint(c));
    expect(cleanName(`  Al${RLO}ice${ZWSP}\n\tBob `)).toBe('Alice Bob');
    expect(cleanName(`a\nb${PS}c${LS}d${NUL}e`)).toBe('a b c d e');
    expect(cleanName(`${ZWSP}${RLO}`)).toBeUndefined();
    expect(cleanName(42)).toBeUndefined();
    const family = '👨‍👩‍👧‍👦';
    expect(cleanName(family.repeat(30))).toBe(`${family.repeat(24)}…`);
    expect(cleanName(`e${String.fromCodePoint(0x301)}`)).toBe(String.fromCodePoint(0xe9));
  });
  it("names come from each author's newest kind 0", () => {
    const k0 = (name: string, at: number) => finalizeEvent({ kind: 0, content: JSON.stringify({ display_name: name }), created_at: at, tags: [] }, aliceSk);
    expect(namesFrom([k0('Old', 1), k0(`New${String.fromCodePoint(0x202e)}`, 2)]).get(ALICE)).toBe('New');
  });
  const item = (over: Partial<InboxItem>): InboxItem => ({ id: '1', tipper: ALICE, amount: '0.01', target: { kind: 'post', id: POST }, at: 0, state: 'claimed', ...over });
  it('says "an X post", never "your post", and never carries a URL', () => {
    const text = noticeText([item({ name: 'Alice' })]);
    expect(text).toBe(`‘Alice’ (${shortNpub(ALICE)}) says they sent you 0.01 XMR for an X post.`);
    expect(text).not.toMatch(/https?:|x\.com|your post/);
    expect(noticeText([item({ target: { kind: 'profile' } })])).toBe(`${shortNpub(ALICE)} says they sent you 0.01 XMR for your profile.`);
  });
  it('sums several, by tipper', () => {
    expect(noticeText([item({ name: 'Alice' }), item({ id: '2', amount: '0.02', target: { kind: 'note', id: NOTE }, name: 'Alice' })])).toBe(
      `‘Alice’ (${shortNpub(ALICE)}) says they sent you 0.03 XMR in 2 Xaps.`,
    );
    const three = noticeText([item({ name: 'Alice' }), item({ id: '2', tipper: BOB, name: 'Bob' }), item({ id: '3', tipper: ME })]);
    expect(three).toBe(`3 new Xaps: ‘Alice’ (${shortNpub(ALICE)}), ‘Bob’ (${shortNpub(BOB)}) and 1 more say they sent you 0.03 XMR in total.`);
  });
});

describe('inboxKeeper', () => {
  function keeper(opts: { on?: boolean; pubkey?: string | null; address?: string | null; readable?: boolean; receipts?: Event[] } = {}) {
    const t = { on: opts.on ?? true, pubkey: opts.pubkey === undefined ? ME : opts.pubkey, now: NOW, address: opts.address === undefined ? ADDR : opts.address, readable: opts.readable ?? true, receipts: opts.receipts ?? [] };
    let held: InboxState | null = null;
    const alarms = new Map<string, { periodInMinutes?: number }>();
    const payto = () => (t.address ? [finalizeEvent({ kind: 10133, content: '', created_at: 1, tags: [['payto', 'xmr', t.address]] }, meSk)] : []);
    const deps: InboxDeps = {
      held: { getValue: async () => held, setValue: async (v) => void (held = v), removeValue: async () => void (held = null) },
      enabled: async () => t.on,
      pubkey: async () => t.pubkey,
      relays: async () => ['wss://a', 'wss://b'],
      read: vi.fn(async (relays: string[]) => (t.readable ? { events: t.receipts, readable: relays, unreadable: [] } : { events: [], readable: [], unreadable: relays })),
      query: vi.fn(async (_r, f) => (f.authors?.[0] === ME && f.kinds?.includes(10133) ? payto() : [])),
      alarms: {
        create: vi.fn(async (n: string, i: { periodInMinutes: number }) => void alarms.set(n, i)),
        clear: vi.fn(async (n: string) => alarms.delete(n)),
        get: async (n: string) => alarms.get(n),
      },
      notify: vi.fn(async () => {}),
      clearNotice: vi.fn(async () => {}),
      now: () => t.now,
    };
    return { k: inboxKeeper(deps), deps, t, alarms, held: () => held };
  }

  it('does nothing until both the switch and a key are there, and starts when the key appears', async () => {
    const s = keeper({ pubkey: null });
    await s.k.apply();
    expect(s.alarms.size).toBe(0);
    expect(s.deps.read).not.toHaveBeenCalled();
    s.t.pubkey = ME;
    await s.k.apply();
    expect(s.alarms.get(INBOX_ALARM)).toEqual({ periodInMinutes: 30 });
    expect(s.held()).toMatchObject({ pubkey: ME, baseline: 'done' });
  });
  it("keeps the alarm's countdown across starts", async () => {
    const s = keeper();
    await s.k.apply();
    (s.deps.alarms.create as ReturnType<typeof vi.fn>).mockClear();
    await s.k.apply();
    expect(s.deps.alarms.create).not.toHaveBeenCalled();
  });
  it('stays in its baseline while no relay answers or no address is published', async () => {
    const s = keeper({ readable: false });
    await s.k.apply();
    expect(s.held()).toMatchObject({ baseline: 'pending', error: 'No relay answered' });
    const u = keeper({ address: null, receipts: [receipt()] });
    await u.k.apply();
    expect(u.held()).toMatchObject({ baseline: 'pending', error: 'no-address' });
    // the address appears: that check is still the baseline, so the old receipt is listed, not told
    u.t.address = ADDR;
    u.t.now += 31 * 60_000;
    await u.k.check();
    expect(u.held()).toMatchObject({ baseline: 'done', unread: 0 });
    expect(u.held()!.items).toHaveLength(1);
    expect(u.deps.notify).not.toHaveBeenCalled();
  });
  it('notifies a new Xap after the baseline', async () => {
    const s = keeper();
    await s.k.apply();
    s.t.receipts = [receipt({ ago: 60 })];
    s.t.now += 30 * 60_000;
    await s.k.onAlarm(INBOX_ALARM);
    expect(s.deps.notify).toHaveBeenCalledWith(expect.stringContaining('says they sent you 0.01 XMR for your profile.'));
  });
  it('a key change during a check writes and tells nothing for the old key, and starts a new baseline', async () => {
    const s = keeper();
    await s.k.apply();
    s.t.receipts = [receipt({ ago: 60 })];
    s.t.now += 30 * 60_000;
    let release!: () => void;
    (s.deps.read as ReturnType<typeof vi.fn>).mockImplementationOnce(async (relays: string[]) => {
      await new Promise<void>((r) => (release = r));
      return { events: s.t.receipts, readable: relays, unreadable: [] };
    });
    const running = s.k.check();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const other = getPublicKey(generateSecretKey());
    s.t.pubkey = other;
    s.t.address = null;
    await s.k.apply();
    release();
    await running;
    expect(s.deps.notify).not.toHaveBeenCalled();
    expect(s.held()).toMatchObject({ pubkey: other, baseline: 'pending' });
  });
  it('switching off clears the alarm, the state and the notification', async () => {
    const s = keeper();
    await s.k.apply();
    s.t.on = false;
    await s.k.apply();
    expect(s.alarms.size).toBe(0);
    expect(s.held()).toBeNull();
    expect(s.deps.clearNotice).toHaveBeenCalled();
  });
  it('Check now waits a minute between checks; reading clears unread', async () => {
    const s = keeper();
    await s.k.apply();
    (s.deps.read as ReturnType<typeof vi.fn>).mockClear();
    s.t.now += 30_000;
    await s.k.checkNow();
    expect(s.deps.read).not.toHaveBeenCalled();
    s.t.now += 31_000;
    s.t.receipts = [receipt({ ago: 10 })];
    await s.k.checkNow();
    expect(s.held()!.unread).toBe(1);
    await s.k.markRead();
    expect(s.held()!.unread).toBe(0);
  });
});

describe('Xaps received list', () => {
  const base: InboxItem = { id: '1', tipper: ALICE, amount: '0.01', target: { kind: 'post', id: POST }, at: NOW_S, state: 'claimed' };
  it('shows a name as text, with the npub, and links a post only from its checked id', async () => {
    const { itemLine } = await import('../src/ui/xap-inbox-panel');
    const li = itemLine({ ...base, name: '<img src=x onerror=alert(1)>' });
    expect(li.querySelector('img')).toBeNull();
    expect(li.querySelector('.who')!.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(li.querySelector('.npub')!.textContent).toBe(shortNpub(ALICE));
    expect(li.querySelector('a')!.href).toBe(`https://x.com/i/status/${POST}`);
    expect(li.textContent).toContain('named by the tipper');
    expect(li.querySelector('.state')!.textContent).toBe('says they sent it');
    const profile = itemLine({ ...base, target: { kind: 'profile' }, state: 'verified' });
    expect(profile.querySelector('a')).toBeNull();
    expect(profile.querySelector('.who')!.textContent).toBe(shortNpub(ALICE));
    expect(profile.querySelector('.state.verified')!.textContent).toBe('verified');
  });
  it("says when it last checked, or why it can't", async () => {
    const { inboxStatus } = await import('../src/ui/xap-inbox-panel');
    expect(inboxStatus(null)).toBe('Not checked yet.');
    expect(inboxStatus(done({ checkedAt: NOW - 12 * 60_000 }), NOW)).toBe('Checked 12 minutes ago.');
    expect(inboxStatus(done({ checkedAt: NOW, error: 'no-address' }), NOW)).toMatch(/^Publish your Monero address/);
    expect(inboxStatus(done({ checkedAt: NOW - 60_000, error: 'No relay answered' }), NOW)).toBe('The last check failed (No relay answered), 1 minute ago.');
  });
});

describe('review fixes', () => {
  const confirm = (r: Event, t = 'f'.repeat(64), tipper = ALICE) =>
    finalizeEvent({ kind: 9044, content: '', created_at: NOW_S, tags: [['e', r.id], ['p', tipper], ['amount', '0.01'], ['method', 'wallet-match'], ['t', t], ['v', 'nkip02/1']] }, meSk);
  it('a confirmation arriving after the receipt left the window still verifies the listed line', () => {
    const r = receipt();
    const { state } = run(done(), [r]);
    // three days on, the query no longer returns the receipt; only the confirmation comes
    const later = run({ ...state, okAt: NOW + 3 * 86_400_000 - 30 * 60_000 }, [confirm(r)], NOW + 3 * 86_400_000);
    expect(later.state.items[0]).toMatchObject({ id: r.id, state: 'verified' });
  });
  it('one transfer verifies one receipt: the lowest id', () => {
    const [a, b] = [receipt({ ago: 500 }), receipt({ ago: 400, target: onPost })];
    const { state } = run(done(), [a, b, confirm(a), confirm(b)]);
    const low = a.id < b.id ? a.id : b.id;
    expect(state.items.filter((i) => i.state === 'verified').map((i) => i.id)).toEqual([low]);
  });
  it('the baseline takes every receipt, so none from before it notifies later', () => {
    const many = Array.from({ length: PER_TIPPER + 5 }, (_, n) => receipt({ target: [['e', n.toString(16).padStart(64, '0')]], ago: 1000 - n }));
    const base = run(freshInbox(ME), many);
    expect(base.state.seen).toHaveLength(PER_TIPPER + 5);
    expect(run(base.state, many, NOW + 30 * 60_000).notify).toEqual([]);
  });
  it('unread counts only the lines the list can show', () => {
    const lots = Array.from({ length: MAX_ITEMS + 10 }, (_, n) => receipt({ sk: generateSecretKey(), ago: 900 - n }));
    const { state, notify } = run(done(), lots);
    expect(state.items).toHaveLength(MAX_ITEMS);
    expect(state.unread).toBe(MAX_ITEMS);
    expect(notify).toHaveLength(MAX_ITEMS + 10);
  });
});
