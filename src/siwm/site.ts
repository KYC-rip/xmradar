import { getDomain } from 'tldts';

/** Same-site answers for Sign in with Monero (PLAN-SIWM); background only, the Public Suffix List is large. */

/** host without port, brackets or trailing dot; a bare IPv6 address (several colons) keeps its colons */
function bareHost(h: string): string {
  const x = h.toLowerCase();
  const v6 = /^\[([^\]]*)\](?::\d+)?$/.exec(x);
  if (v6) return v6[1]!;
  return ((x.match(/:/g) ?? []).length > 1 ? x : x.replace(/:\d+$/, '')).replace(/\.$/, '');
}

/** Same registrable domain (Public Suffix List, private section too); ports ignored. A host without one (an IP, localhost) must match exactly. */
export function sameSite(a: string, b: string): boolean {
  const x = bareHost(a);
  const y = bareHost(b);
  if (!x || !y) return false;
  const opts = { allowPrivateDomains: true };
  const dx = getDomain(x, opts);
  const dy = getDomain(y, opts);
  return dx && dy ? dx === dy : x === y;
}
