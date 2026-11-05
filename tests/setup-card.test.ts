import { describe, expect, it } from 'vitest';
import { npubEncode } from 'nostr-tools/nip19';
import { cardAllowed, findProofTweet, handleFromNav, SNOOZE_MS } from '../src/entrypoints/content/x-setup-card';
import { wizardSteps } from '../src/entrypoints/setup/steps';
import { identitySteps } from '../src/identity/steps';
import type { SetupStatus } from '../src/messaging';

// PLAN-XOREACH
const NPUB = npubEncode('b'.repeat(64));
const OTHER = npubEncode('c'.repeat(64));
const post = (author: string, id: string, text: string) =>
  `<article data-testid="tweet"><div data-testid="User-Name"><a href="/${author}">${author}</a></div><a href="/${author}/status/${id}"><time>now</time></a><div data-testid="tweetText">${text}</div></article>`;

describe('the setup card', () => {
  it('shows only with xo on, not dismissed and not snoozed', () => {
    const now = 1_000_000;
    expect(cardAllowed(true, {}, now)).toBe(true);
    expect(cardAllowed(false, {}, now)).toBe(false);
    expect(cardAllowed(true, { dismissed: true }, now)).toBe(false);
    expect(cardAllowed(true, { snoozedUntil: now + SNOOZE_MS }, now)).toBe(false);
    expect(cardAllowed(true, { snoozedUntil: now - 1 }, now)).toBe(true);
  });
  it('reads the signed-in handle from X’s Profile link, or none', () => {
    document.body.innerHTML = '<nav><a data-testid="AppTabBar_Profile_Link" href="/XBToshi">Profile</a></nav>';
    expect(handleFromNav(document)).toBe('XBToshi');
    document.body.innerHTML = '<nav><a data-testid="AppTabBar_Profile_Link" href="/not a handle">Profile</a></nav>';
    expect(handleFromNav(document)).toBeNull();
    document.body.innerHTML = '';
    expect(handleFromNav(document)).toBeNull();
  });
});

describe('the proof tweet spotter', () => {
  it('finds the user’s own post with the npub as a whole word', () => {
    document.body.innerHTML = post('someone', '1', `Verifying that I control the following Nostr public key: ${NPUB}`) + post('Me', '2', `Verifying that I control the following Nostr public key: ${NPUB}\n\ntry it on: XMRadar.app`);
    expect(findProofTweet(document, 'me', NPUB)).toBe('2');
  });
  it('not another key, not a longer word, not another author', () => {
    document.body.innerHTML = post('me', '3', `key: ${OTHER}`) + post('me', '4', `key: ${NPUB}x`) + post('you', '5', `key: ${NPUB}`);
    expect(findProofTweet(document, 'me', NPUB)).toBeNull();
  });
});

describe('the setup page’s three steps', () => {
  const status = (address: boolean, link: boolean): SetupStatus =>
    ({
      pubkey: 'b'.repeat(64),
      relays: [],
      unreadable: [],
      address: address ? { address: '4' + 'A'.repeat(94), check: { ok: true, type: 'standard' } } : null,
      link: link ? { handle: 'me', tweetUrl: 'https://x.com/me/status/1', proof: { status: 'verified' } } : null,
      xmrbio: null,
    }) as unknown as SetupStatus;
  const states = (npub: string | null, handle: string | null, st: SetupStatus | null) => wizardSteps(identitySteps({ npub, handle, status: st })).map((s) => s.state);
  it('no key: the key step is next', () => {
    expect(states(null, null, null)).toEqual(['current', 'todo', 'todo']);
  });
  it('a key, no handle or address: step 2 is next', () => {
    expect(states(NPUB, null, status(false, false))).toEqual(['done', 'current', 'todo']);
  });
  it('step 2 needs both the handle and the address', () => {
    expect(states(NPUB, 'me', status(false, false))).toEqual(['done', 'current', 'todo']);
    expect(states(NPUB, null, status(true, false))).toEqual(['done', 'current', 'todo']);
    expect(states(NPUB, 'me', status(true, false))).toEqual(['done', 'done', 'current']);
  });
  it('all done', () => {
    expect(states(NPUB, 'me', status(true, true))).toEqual(['done', 'done', 'done']);
  });
});
