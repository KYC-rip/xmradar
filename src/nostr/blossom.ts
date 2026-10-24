export async function uploadBlob(server: string, bytes: ArrayBuffer, mime: string, sha256: string, authHeader: string): Promise<string> {
  const base = server.replace(/\/+$/, '');
  const attempt = async () => {
    const res = await fetch(`${base}/upload`, {
      method: 'PUT',
      headers: { Authorization: authHeader, 'Content-Type': mime, 'X-SHA-256': sha256 },
      body: bytes,
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status !== 200 && res.status !== 201) {
      const reason = res.headers.get('X-Reason') ?? (await res.text().catch(() => ''));
      throw new Error(`Blossom ${res.status}: ${reason.slice(0, 200)}`);
    }
    const desc = (await res.json()) as { url?: string; sha256?: string };
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
