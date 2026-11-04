/** The user's own xos by post (PLAN-MONEROLIKE): the newest MAX_SENT, so the record doesn't grow for ever. */
export interface SentXo {
  id: string;
  at: number;
  author?: string;
}

export const MAX_SENT = 2000;

export function rememberSent(map: Record<string, SentXo>, post: string, entry: SentXo, max = MAX_SENT): Record<string, SentXo> {
  const next = { ...map, [post]: entry };
  const posts = Object.keys(next);
  if (posts.length > max) for (const p of posts.sort((a, b) => next[a]!.at - next[b]!.at).slice(0, posts.length - max)) delete next[p];
  return next;
}
