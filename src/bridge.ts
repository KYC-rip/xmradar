/**
 * NIP-07 signers only inject `window.nostr` into the page's MAIN world, so signing has to be
 * proxied from there. There is NO secret channel between the isolated content script and the
 * MAIN world: page scripts can observe and forge these postMessage calls. The real security
 * boundary is the signer's own approval prompt. This bridge therefore exposes only
 * getPublicKey and signEvent for an allowlist of kinds, and the content script verifies
 * everything that comes back.
 */

export const BRIDGE_REQ = 's2n-bridge-req';
export const BRIDGE_RES = 's2n-bridge-res';

/**
 * Injected with scripting.executeScript({ world: 'MAIN', func: installBridge }).
 * Must be fully self-contained: no imports or outer-scope references.
 */
export function installBridge(): void {
  const w = window as unknown as { __s2nBridge?: boolean; nostr?: any };
  if (w.__s2nBridge) return;
  w.__s2nBridge = true;
  // notes, Blossom upload auth, long-form articles (NIP-23)
  const ALLOWED_KINDS = [1, 24242, 30023];

  const waitForSigner = async () => {
    for (let i = 0; i < 30 && !w.nostr; i++) await new Promise((r) => setTimeout(r, 100));
    if (!w.nostr) throw new Error('No NIP-07 signer found on this page (install Alby or nos2x, or unlock it)');
    return w.nostr;
  };

  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.data?.type !== 's2n-bridge-req') return;
    const { id, method, params } = e.data;
    const reply = (body: object) => window.postMessage({ type: 's2n-bridge-res', id, ...body }, '*');
    try {
      const nostr = await waitForSigner();
      if (method === 'getPublicKey') return reply({ result: await nostr.getPublicKey() });
      if (method === 'signEvent') {
        const t = params;
        if (!t || !ALLOWED_KINDS.includes(t.kind) || typeof t.content !== 'string' || !Array.isArray(t.tags) || typeof t.created_at !== 'number') {
          throw new Error('Event rejected by bridge');
        }
        return reply({ result: await nostr.signEvent({ kind: t.kind, content: t.content, tags: t.tags, created_at: t.created_at }) });
      }
      throw new Error(`Unknown bridge method ${method}`);
    } catch (err) {
      reply({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

let counter = 0;

export function callBridge<T>(method: 'getPublicKey' | 'signEvent', params?: unknown, timeoutMs = 120_000): Promise<T> {
  const id = `${Date.now()}-${++counter}-${Math.random().toString(36).slice(2)}`;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error(`Signer did not respond (${method})`));
    }, timeoutMs);
    function onMessage(e: MessageEvent) {
      if (e.source !== window || e.data?.type !== BRIDGE_RES || e.data.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      if (e.data.error) reject(new Error(e.data.error));
      else resolve(e.data.result as T);
    }
    window.addEventListener('message', onMessage);
    window.postMessage({ type: BRIDGE_REQ, id, method, params }, '*');
  });
}
