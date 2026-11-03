import '../../ui/base.css';
import './style.css';
import { chatPanel } from '../../chat/panel';
import type { Room } from '../../chat/rooms';
import type { SiteFeed } from '../../sites/feed';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// the same item the background keeps the xmr.club feed in
const siteFeedItem = storage.defineItem<SiteFeed | null>('local:siteFeed', { fallback: null });
const chatRoomItem = storage.defineItem<Room | null>('local:chatRoom', { fallback: null });

const panel = chatPanel({
  frame: $<HTMLIFrameElement>('chat'),
  title: $('room'),
  lobby: $<HTMLButtonElement>('lobby'),
  site: $<HTMLButtonElement>('site'),
  newTab: $<HTMLAnchorElement>('new-tab'),
  room: { get: () => chatRoomItem.getValue(), set: (r) => chatRoomItem.setValue(r) },
  // read here only, to offer this site's room; it goes nowhere
  activeUrl: async () => (await browser.tabs.query({ active: true, currentWindow: true }))[0]?.url,
  feed: () => siteFeedItem.getValue(),
});

const refresh = () => void panel.refresh();
browser.tabs.onActivated.addListener(refresh);
browser.tabs.onUpdated.addListener((_id, change, tab) => {
  if (tab.active && change.url) refresh();
});
browser.windows.onFocusChanged.addListener(refresh);
siteFeedItem.watch(refresh);
