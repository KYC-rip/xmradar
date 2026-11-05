/**
 * The `browser` global for the Ripley X bundle. XMRadar's X features reach their background with
 * `browser.runtime.sendMessage`; here that is Ripley Terminal's `xapp_bridge`, which hands the request to
 * RipleyOS and returns its answer (`{ ok, data }` / `{ ok: false, error }`, as the background does).
 * Ripley answers only its allow-list (resolve-handles, xap-totals, xap-post-totals, xmrbio-resolve,
 * xmr-price) and `status`; anything else comes back as an error.
 */
type Invoke = (cmd: string, args: Record<string, unknown>) => Promise<unknown>;

declare const __XMRADAR_VERSION__: string;
export const VERSION = typeof __XMRADAR_VERSION__ === 'string' ? __XMRADAR_VERSION__ : 'dev';

let invoke: Invoke | null = null;

/** Ripley Terminal's IPC, taken once it exists (it is installed before X's own scripts run). */
export function findInvoke(): Invoke | null {
  if (invoke) return invoke;
  const i = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__?.invoke;
  if (typeof i === 'function') invoke = i.bind((window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__) as Invoke;
  return invoke;
}

async function sendMessage(req: unknown): Promise<unknown> {
  const i = findInvoke();
  if (!i) return { ok: false, error: 'Ripley isn’t reachable from this page' };
  const answer = await i('xapp_bridge', { request: JSON.stringify(req) });
  return typeof answer === 'string' ? JSON.parse(answer) : answer;
}

const noopEvent = { addListener() {}, removeListener() {}, hasListener: () => false };

export const browser = {
  runtime: {
    id: 'xmradar-ripley',
    sendMessage,
    getManifest: () => ({ version: VERSION, name: 'XMRadar' }),
    getURL: (path: string) => path,
    onMessage: noopEvent,
  },
};

(globalThis as unknown as { browser: typeof browser }).browser = browser;
