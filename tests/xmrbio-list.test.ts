import { describe, expect, it } from 'vitest';
import { listButtonText, listKey, listOutcome, listPlan, registerContent, registerTemplate, tweetIdOf } from '../src/identity/xmrbio-list';
import { statusLines } from '../src/identity/status';
import type { SetupStatus } from '../src/messaging';

// PLAN-XMRBIOLIST
const ADDR = '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';

describe('the xmr.bio listing request', () => {
  it('is the exact event xmr.bio checks: kind 27235, its content, one tag naming the tweet', () => {
    expect(registerTemplate('alice', ADDR, '123', 1)).toEqual({ kind: 27235, created_at: 1, content: `xmr.bio:alice list ${ADDR}`, tags: [['i', 'twitter:alice', '123']] });
    expect(registerContent('alice', ADDR)).toBe(`xmr.bio:alice list ${ADDR}`);
  });
  it('the tweet id comes from the proof tweet’s link', () => {
    expect(tweetIdOf('https://x.com/alice/status/1234567890')).toBe('1234567890');
    expect(tweetIdOf('https://twitter.com/alice/status/42?s=20')).toBe('42');
    expect(tweetIdOf('https://x.com/alice')).toBeNull();
  });
  it('one record per handle, key and address', () => {
    expect(listKey('Alice', 'ab', ADDR)).toBe(`alice|ab|${ADDR}`);
  });
  it('xmr.bio’s answer: listed, already there, or the reason it failed', () => {
    expect(listOutcome(200, { success: true })).toMatchObject({ status: 'listed' });
    expect(listOutcome(409, { success: false, error: 'x', reason: 'exists' })).toMatchObject({ status: 'exists' });
    expect(listOutcome(409, { success: false, error: 'x', reason: 'exists-unlisted' })).toMatchObject({ status: 'exists-unlisted' });
    expect(listOutcome(403, { success: false, error: 'Proof tweet: tweet is by another account' })).toMatchObject({ status: 'failed', error: 'Proof tweet: tweet is by another account' });
    expect(listOutcome(502, null)).toMatchObject({ status: 'failed', error: 'HTTP 502' });
  });
  it('a failed last try shows on the xmr.bio line', () => {
    const s = { pubkey: 'ab', relays: [], unreadable: [], address: null, link: null, xmrbio: { found: false }, listing: { status: 'failed', at: 0, error: 'X did not answer' } } as SetupStatus;
    expect(statusLines(s, 'alice').map((l) => l.text)).toContain("xmr.bio: @alice isn't listed there; the last try failed (X did not answer)");
  });
  it('already there: shown as such, never as "not listed"', () => {
    const base = { pubkey: 'ab', relays: [], unreadable: [], address: null, link: null, xmrbio: { found: false } } as unknown as SetupStatus;
    expect(statusLines({ ...base, listing: { status: 'exists', at: 0 } }, 'alice').map((l) => l.text)).toContain('xmr.bio: @alice is already there; manage it on xmr.bio');
    expect(statusLines({ ...base, listing: { status: 'exists-unlisted', at: 0 } }, 'alice').map((l) => l.text)).toContain('xmr.bio: @alice is already there, unlisted; manage it on xmr.bio');
  });
});

const CHECK = { ok: true, type: 'standard' } as const;
const ready = {
  pubkey: 'ab',
  address: { address: ADDR, check: CHECK },
  link: { tweetUrl: 'https://x.com/alice/status/123', proof: { status: 'verified' } },
  xmrbio: { found: false as boolean | 'error' },
};
const auto = { explicit: false, pref: 'on' as const, records: {} };

describe('when XMRadar lists on its own', () => {
  it('a verified link, a valid address and xmr.bio not knowing the handle: sends once', () => {
    expect(listPlan(ready, 'Alice', auto)).toEqual({ send: true, key: listKey('alice', 'ab', ADDR), handle: 'alice', address: ADDR, tweetId: '123' });
    const records = { [listKey('alice', 'ab', ADDR)]: { status: 'failed' as const, at: 1, error: 'x' } };
    expect(listPlan(ready, 'alice', { ...auto, records })).toEqual({ send: false, had: records[listKey('alice', 'ab', ADDR)] });
  });
  it('unticked: never on its own; the button still sends', () => {
    expect(listPlan(ready, 'alice', { ...auto, pref: 'off' }).send).toBe(false);
    expect(listPlan(ready, 'alice', { ...auto, pref: 'off', explicit: true }).send).toBe(true);
  });
  it('the button retries an earlier record, and tries when xmr.bio couldn’t be asked', () => {
    const records = { [listKey('alice', 'ab', ADDR)]: { status: 'listed' as const, at: 1 } };
    expect(listPlan(ready, 'alice', { ...auto, explicit: true, records }).send).toBe(true);
    const err = { ...ready, xmrbio: { found: 'error' as const } };
    expect(listPlan(err, 'alice', auto).send).toBe(false);
    expect(listPlan(err, 'alice', { ...auto, explicit: true }).send).toBe(true);
  });
  it('nothing is sent without every piece, even by the button', () => {
    const explicit = { ...auto, explicit: true };
    expect(listPlan({ ...ready, xmrbio: { found: true } }, 'alice', explicit).send).toBe(false);
    expect(listPlan({ ...ready, address: null }, 'alice', explicit).send).toBe(false);
    expect(listPlan({ ...ready, address: { address: ADDR, check: { ok: true, type: 'integrated' } } }, 'alice', explicit).send).toBe(false);
    expect(listPlan({ ...ready, address: { address: ADDR, check: { ok: false } } }, 'alice', explicit).send).toBe(false);
    expect(listPlan({ ...ready, link: { ...ready.link, proof: { status: 'failed' } } }, 'alice', explicit).send).toBe(false);
    expect(listPlan({ ...ready, link: { tweetUrl: 'https://x.com/alice', proof: { status: 'verified' } } }, 'alice', explicit).send).toBe(false);
  });
  it('another key or address is a new record', () => {
    const records = { [listKey('alice', 'ab', ADDR)]: { status: 'listed' as const, at: 1 } };
    expect(listPlan({ ...ready, pubkey: 'cd' }, 'alice', { ...auto, records }).send).toBe(true);
  });
});

describe('the button’s answer', () => {
  const NOW = 1_000_000_000;
  const st = (over: object) => ({ xmrbio: { found: false }, listing: null, link: { proof: { status: 'verified' } }, address: { check: CHECK }, ...over }) as Parameters<typeof listButtonText>[0];
  const just = (status: string, error?: string) => ({ status, at: NOW - 1000, ...(error ? { error } : {}) });
  const old = (status: string) => ({ status, at: NOW - 86_400_000 });
  const text = (over: object) => listButtonText(st(over), 'alice', NOW);
  it('xmr.bio’s answer just now, while /resolve doesn’t show it yet', () => {
    expect(text({ listing: just('listed') })).toMatch(/^Listed: xmr\.bio\/alice/);
    expect(text({ listing: just('exists') })).toBe('Already on xmr.bio; manage it there.');
    expect(text({ listing: just('exists-unlisted') })).toMatch(/unlisted/);
    expect(text({ listing: just('failed', 'X did not answer') })).toBe('Not listed: X did not answer');
  });
  it('the current state wins over an old record', () => {
    // listed, then deleted on xmr.bio: never "Listed"; the button can list again
    expect(text({ listing: old('listed') })).toBe("xmr.bio doesn't have @alice now (deleted there?). Press again to list it.");
    expect(text({ listing: old('exists') })).toMatch(/Press again/);
    // listed, then unlisted
    expect(text({ listing: old('listed'), xmrbio: { found: true, linked: true, listed: false } })).toMatch(/^On xmr\.bio, but not in the directory/);
    // a 409 back then, the profile unlisted now
    expect(text({ listing: old('exists'), xmrbio: { found: true, linked: true, listed: false } })).toMatch(/not in the directory/);
    // listed, then taken over by another key
    expect(text({ listing: just('listed'), xmrbio: { found: true, linked: false, listed: true } })).toBe('Already on xmr.bio, with another key; manage it there.');
    // just listed, but now unlisted and another key's: still another key's
    expect(text({ listing: just('listed'), xmrbio: { found: true, linked: false, listed: false } })).toBe('Already on xmr.bio, with another key; manage it there.');
    // unlisted back then, listed again now
    expect(text({ listing: old('exists-unlisted'), xmrbio: { found: true, linked: true, listed: true } })).toMatch(/^Already on xmr\.bio, linked to this key\. Its badge shows for every XMRadar user\./);
  });
  it('just listed and found, before the directory has it', () => {
    expect(text({ listing: just('listed'), xmrbio: { found: true, linked: true, listed: false } })).toMatch(/^Listed: .*next directory download/);
    expect(text({ listing: just('listed'), xmrbio: { found: true, linked: true } })).toMatch(/^Listed: .*once it holds the directory/);
  });
  it('what’s missing first, then xmr.bio being unreachable', () => {
    expect(text({ link: null })).toBe('Link your X account first (step 4).');
    expect(text({ address: null })).toMatch(/step 3/);
    expect(text({ xmrbio: { found: 'error', reason: 'timeout' } })).toBe("Couldn't reach xmr.bio (timeout).");
    expect(text({})).toBe('Not listed.');
  });
});

describe('the badge line', () => {
  const found = (listed?: boolean) =>
    ({ pubkey: 'ab', relays: [], unreadable: [], address: null, link: null, xmrbio: { found: true, address: ADDR, check: { ok: true, type: 'standard' }, linked: true, ...(listed === undefined ? {} : { listed }) } }) as unknown as SetupStatus;
  it('an unlisted profile gives no xmr.bio badge', () => {
    const lines = statusLines(found(false), 'alice').map((l) => l.text);
    expect(lines.some((t) => t.startsWith('Badge: from xmr.bio'))).toBe(false);
    expect(lines).toContain("xmr.bio: @alice isn't in the directory XMRadar holds (unlisted, or listed since its last download)");
  });
  it('listed: shown to every XMRadar user; unknown: said so', () => {
    expect(statusLines(found(true), 'alice').map((l) => l.text)).toContain('Badge: from xmr.bio’s directory, shown to every XMRadar user.');
    // no copy held: no promise, only what the badge depends on
    expect(statusLines(found(), 'alice').map((l) => l.text)).toContain('Badge: from xmr.bio’s directory if @alice is listed there (XMRadar holds no copy of it to check yet).');
  });
});
