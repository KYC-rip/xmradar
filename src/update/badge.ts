import { updateFor, type UpdateState } from './check';

/**
 * The toolbar icon's own badge when a newer XMRadar is out (PLAN-UPDATEBADGE). It is the global badge, so
 * a tab with a receipt or site badge of its own still shows that one; null when off or up to date.
 */
export const UPDATE_BADGE_COLOR = '#1e7d34';

export function updateBadge(state: UpdateState | null | undefined, current: string, on: boolean): { text: string; color: string; title: string } | null {
  const version = on ? updateFor(state, current) : null;
  return version ? { text: '↑', color: UPDATE_BADGE_COLOR, title: `XMRadar: version ${version} is out` } : null;
}

/** The parts of `browser.action` the badges use. */
export interface BadgeAction {
  setBadgeText(d: { tabId?: number; text: string | null }): Promise<void>;
  setBadgeBackgroundColor(d: { tabId?: number; color: string }): Promise<void>;
  setTitle(d: { title: string }): Promise<void>;
}

/**
 * A tab's own badge, or none: then its text goes (`null`, not `''`, which would hide the global ↑ too) and
 * its colour becomes the update colour, so a warning's red or amber doesn't stay behind the ↑.
 */
export async function setTabBadge(action: BadgeAction, tabId: number, own: { text: string; color: string }) {
  await action.setBadgeText({ tabId, text: own.text || null }).catch(() => {});
  await action.setBadgeBackgroundColor({ tabId, color: own.text ? own.color : UPDATE_BADGE_COLOR }).catch(() => {});
}

/** The global badge and the icon's title. The ↑ is the only global badge, so its colour stays set while hidden. */
export async function setGlobalBadge(action: BadgeAction, b: ReturnType<typeof updateBadge>) {
  await action.setBadgeText({ text: b?.text ?? '' }).catch(() => {});
  await action.setBadgeBackgroundColor({ color: UPDATE_BADGE_COLOR }).catch(() => {});
  await action.setTitle({ title: b?.title ?? 'XMRadar' }).catch(() => {});
}
