import type { SiteFeed } from '../sites/feed';
import { chatUrl, LOBBY_ROOM, roomFor, validSlug, type Room } from './rooms';

/** The sandbox the chat runs in: its own scripts and storage, no top navigation, no modals. */
export const CHAT_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups';

export interface PanelDeps {
  frame: HTMLIFrameElement;
  /** "#lobby · Lobby" */
  title: HTMLElement;
  lobby: HTMLButtonElement;
  site: HTMLButtonElement;
  newTab: HTMLAnchorElement;
  room: { get(): Promise<unknown>; set(r: Room): Promise<void> };
  activeUrl(): Promise<string | undefined>;
  feed(): Promise<SiteFeed | null>;
}

const storedRoom = (v: unknown): Room =>
  typeof v === 'object' && v && validSlug((v as Room).slug) && typeof (v as Room).label === 'string' ? { slug: (v as Room).slug, label: (v as Room).label } : LOBBY_ROOM;

/**
 * The panel (PLAN-CHATPANEL). The frame changes room only on a click; the active tab and the site feed
 * only show or hide the button for this site's room. The chat gets nothing but the room in its URL:
 * no messages either way.
 */
export function chatPanel(d: PanelDeps) {
  let current: Room = LOBBY_ROOM;
  let offered: Room | null = null;
  let asked = 0;

  const paint = () => {
    d.title.textContent = `#${current.slug} · ${current.label}`;
    d.newTab.href = chatUrl(current.slug, false);
    d.lobby.disabled = current.slug === LOBBY_ROOM.slug;
    d.site.hidden = !offered || offered.slug === current.slug;
    d.site.textContent = offered ? `${offered.label} room` : '';
  };
  const go = (r: Room) => {
    current = r;
    d.frame.src = chatUrl(r.slug);
    paint();
    // remembering the room is a convenience; the frame is already there
    d.room.set(r).catch(() => {});
  };

  /** which room the active tab could join; the newest ask wins */
  const refresh = async () => {
    const n = ++asked;
    const [url, feed] = await Promise.all([d.activeUrl().catch(() => undefined), d.feed().catch(() => null)]);
    if (n !== asked) return;
    offered = roomFor(url, feed);
    paint();
  };

  d.frame.setAttribute('sandbox', CHAT_SANDBOX);
  d.frame.referrerPolicy = 'no-referrer';
  d.lobby.addEventListener('click', () => go(LOBBY_ROOM));
  d.site.addEventListener('click', () => offered && go(offered));

  const ready = d.room
    .get()
    .catch(() => null)
    .then((v) => {
      current = storedRoom(v);
      d.frame.src = chatUrl(current.slug);
      paint();
      return refresh();
    });
  return { refresh, ready };
}
