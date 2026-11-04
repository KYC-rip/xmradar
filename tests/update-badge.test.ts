import { describe, expect, it } from 'vitest';
import { setGlobalBadge, setTabBadge, updateBadge, UPDATE_BADGE_COLOR, type BadgeAction } from '../src/update/badge';

// PLAN-UPDATEBADGE
const state = (latest: string | null) => ({ attemptAt: 1, latest, notified: null });

describe('updateBadge', () => {
  it('↑ only when a valid newer version is held and the check is on', () => {
    expect(updateBadge(state('0.6.11'), '0.6.10', true)).toEqual({ text: '↑', color: UPDATE_BADGE_COLOR, title: 'XMRadar: version 0.6.11 is out' });
    expect(updateBadge(state('0.6.11'), '0.6.10', false)).toBeNull();
    expect(updateBadge(state('0.6.10'), '0.6.10', true)).toBeNull();
    expect(updateBadge(state('0.6.9'), '0.6.10', true)).toBeNull();
    expect(updateBadge(state('nope'), '0.6.10', true)).toBeNull();
    expect(updateBadge(null, '0.6.10', true)).toBeNull();
  });
});

// a fake action that resolves badges like the browsers: a tab's own text wins, null falls back to global
function fakeAction() {
  const g = { text: '', color: '', title: 'XMRadar' };
  const tabs = new Map<number, { text?: string | null; color?: string }>();
  const action: BadgeAction = {
    setBadgeText: async ({ tabId, text }) => {
      if (tabId === undefined) g.text = text ?? '';
      else tabs.set(tabId, { ...tabs.get(tabId), text });
    },
    setBadgeBackgroundColor: async ({ tabId, color }) => {
      if (tabId === undefined) g.color = color;
      else tabs.set(tabId, { ...tabs.get(tabId), color });
    },
    setTitle: async ({ title }) => void (g.title = title),
  };
  const shown = (tabId: number) => {
    const t = tabs.get(tabId);
    const text = t?.text == null ? g.text : t.text;
    return { text, color: t?.color ?? g.color };
  };
  return { action, shown, g };
}

describe('the icon badge', () => {
  it('a tab’s warning wins; when it goes, the ↑ shows on the update colour, not the old red', async () => {
    const f = fakeAction();
    await setGlobalBadge(f.action, updateBadge(state('0.6.11'), '0.6.10', true));
    await setTabBadge(f.action, 7, { text: '!', color: '#d93025' });
    expect(f.shown(7)).toEqual({ text: '!', color: '#d93025' });
    expect(f.shown(8)).toEqual({ text: '↑', color: UPDATE_BADGE_COLOR });
    await setTabBadge(f.action, 7, { text: '', color: '#000000' });
    expect(f.shown(7)).toEqual({ text: '↑', color: UPDATE_BADGE_COLOR });
    expect(f.g.title).toBe('XMRadar: version 0.6.11 is out');
  });
  it('switched off or up to date: no badge, the plain title', async () => {
    const f = fakeAction();
    await setGlobalBadge(f.action, updateBadge(state('0.6.11'), '0.6.10', true));
    await setGlobalBadge(f.action, updateBadge(state('0.6.11'), '0.6.10', false));
    expect(f.shown(1)).toEqual({ text: '', color: UPDATE_BADGE_COLOR });
    expect(f.g.title).toBe('XMRadar');
  });
});
