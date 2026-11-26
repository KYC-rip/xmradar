const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

async function readBoundedText(res: Response, max = 16_384): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return (await res.text().catch(() => '')).slice(0, max);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel().catch(() => {});
        throw new Error('Blossom response too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(out);
}

/** `timeoutMs`: 30 s by default; a video's scales with its size (PLAN-XVIDEO). */
export async function uploadBlob(server: string, bytes: ArrayBuffer, mime: string, sha256: string, authHeader: string, timeoutMs = 30_000): Promise<string> {
  const base = server.replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(`${base}/upload`);
  } catch {
    throw new Error('Invalid Blossom server URL');
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname))) {
    throw new Error('Blossom server must use HTTPS');
  }
  const attempt = async () => {
    const res = await fetch(parsed.href, {
      method: 'PUT',
      headers: { Authorization: authHeader, 'Content-Type': mime, 'X-SHA-256': sha256 },
      body: bytes,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 200 && res.status !== 201) {
      const reason = res.headers.get('X-Reason') ?? (await readBoundedText(res, 1024).catch(() => ''));
      throw new Error(`Blossom ${res.status}: ${reason.slice(0, 200)}`);
    }
    const desc = JSON.parse(await readBoundedText(res, 16_384)) as { url?: string; sha256?: string };
    if (!desc.url) throw new Error('Blossom response has no url');
    if (desc.sha256 && desc.sha256 !== sha256) throw new Error('Blossom stored a different hash');
    return desc.url;
  };
  try {
    return await attempt();
  } catch (e) {
    // one retry for transient failures (network, timeout, 5xx), not for rejections
    const transient = e instanceof TypeError || (e instanceof DOMException && e.name === 'TimeoutError') || (e instanceof Error && /Blossom 5\d\d/.test(e.message));
    if (!transient) throw e;
    await new Promise((r) => setTimeout(r, 500));
    return attempt();
  }
}
