const FPR_RE = /^[0-9A-F]{40}$/;

/** A spaced or lowercase v4 fingerprint as the feed and letters write it, normalised; null if it isn't one. */
export function normalizeFingerprint(fp: string): string | null {
  const f = fp.replace(/\s+/g, '').toUpperCase();
  return FPR_RE.test(f) ? f : null;
}
