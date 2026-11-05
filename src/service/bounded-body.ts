/** A response body, refused past `max` bytes while it's still arriving. */
export async function boundedBody(res: Response, max: number): Promise<Uint8Array> {
  if (Number(res.headers.get('content-length')) > max) throw new Error('Response too large');
  const reader = res.body?.getReader();
  if (!reader) throw new Error('No body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new Error('Response too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
