/**
 * Guards for what an issuer's manifest and the page decide (PLAN-NKIP01 §2, §11): the relays a
 * later public-record check may contact, the host a receipt is bound to, and the adopter list's
 * order paths for the missing-receipt warning.
 */

/**
 * A manifest relay is contacted only if it is a public `wss://` host on the default port. Names are
 * checked as written: a public name that resolves to a private address isn't caught (an extension
 * can't resolve DNS first), as for image fetches.
 */
export function safeRelay(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'wss:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  // a trailing dot names the same host (`localhost.`), so it's dropped before the checks
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!h.includes('.') && !h.includes(':')) return false; // localhost and other single-label names
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (h.includes(':')) {
    // IPv6 literal: loopback, unspecified, link-local, unique-local and v4-mapped are all refused
    return !/^(::1?|fe[89ab][0-9a-f]?:|f[cd][0-9a-f]{0,2}:|::ffff:)/.test(h);
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!v4) return true;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  // loopback, private, link-local, CGNAT, "this network", multicast and reserved
  return !(a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224);
}

/**
 * Level 1 binding (§2): the receipt's issuer must be the top-level page's exact host, or the page is
 * `www.` plus the issuer. No public-suffix logic: `evil.kyc.rip` never passes for `kyc.rip`.
 */
export function issuerMatchesPage(issuer: string, pageUrl: string): boolean {
  let host: string;
  try {
    const u = new URL(pageUrl);
    if (u.protocol !== 'https:') return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === issuer || host === `www.${issuer}`;
}

/**
 * An adopter's order path (§11): literal segments, `:id` for one `[A-Za-z0-9_-]+` segment, and a final
 * `*` for any remainder. Query and hash never count; trailing slashes don't either.
 */
export function orderPathMatches(pattern: string, pathname: string): boolean {
  const split = (p: string) => p.replace(/\/+$/, '').split('/').filter(Boolean);
  const want = split(pattern);
  const have = split(pathname);
  if (!want.length) return false; // "/" alone would match every page
  for (const [i, seg] of want.entries()) {
    // a final * needs at least one more segment: `/swap/*` is an order page under /swap, not /swap itself
    if (seg === '*' && i === want.length - 1) return have.length >= want.length;
    const got = have[i];
    if (got === undefined) return false;
    if (seg === ':id' ? !/^[A-Za-z0-9_-]+$/.test(got) : seg !== got) return false;
  }
  return have.length === want.length;
}
