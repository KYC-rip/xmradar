/** Image URLs come from page DOM, so don't let a page point the extension at local or private hosts. */
export function assertFetchableImageUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Invalid image URL');
  }
  if (u.protocol === 'data:') {
    if (!/^data:image\//.test(raw)) throw new Error('Not an image data URL');
    return;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`Refusing to fetch ${u.protocol} URL`);
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (
    host === 'localhost' ||
    /\.(local|localhost|internal|lan|home\.arpa)$/.test(host) ||
    /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
    /^(::1?$|::ffff:|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:|fec0:)/.test(host)
  ) {
    throw new Error('Refusing to fetch an image from a local/private address');
  }
}
