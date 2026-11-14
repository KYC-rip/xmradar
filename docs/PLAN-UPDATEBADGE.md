# PLAN-UPDATEBADGE: an update badge on the toolbar icon

## Why
The user wants the toolbar icon to show when a new XMRadar version is out. Today a new version shows a
notification once, a line in the menu and in Options → Updates (src/update/check.ts, `updateFor`).

## Facts
- The icon already carries per-tab badges from `badgeFor(tabState)` (src/sites/feed.ts): `!` red / amber,
  `?`, `new` (intern), a grade, `✓`; set with `setBadgeText({ tabId, text })`, cleared with `text: ''`
  (`applyBadge`, `dropTabState` in background.ts).
- Chrome and Firefox: a tab-specific badge wins over the global one; `text: null` for a tab removes the
  tab-specific value so the global one shows; `''` for a tab shows nothing.
- `updateFor(state, current)` = the newer valid version or null; `updateStateItem` holds the state;
  `updateCheckOn(settings)` is the switch.

## Changes
1. `src/update/badge.ts` (pure): `updateBadge(state, current, on)` → `{ text: '↑', color: '#1e7d34',
   title: 'XMRadar: version X is out' } | null` (null when off, none, or not newer).
2. Background `syncUpdateBadge()`: sets the **global** badge (no tabId) text/colour and the action title
   (`XMRadar` when none); run at start, when `updateStateItem` or settings change, and after a check.
3. Per-tab badges keep priority: `applyBadge` and `dropTabState` set `text: null` (not `''`) when the
   tab has nothing of its own, so the update badge shows there; tab warnings still replace it on their tab.
4. It goes away by itself once the installed version is the latest (the next start or check computes
   null), or when the update check is switched off. No separate dismiss.
5. Tests: updateBadge cases (off, none, older, equal, newer, invalid); applyBadge passes null for an empty
   tab state; the global badge set/cleared on state changes (fake browser).

## Out of scope
Badge text other than ↑; per-version dismiss.
