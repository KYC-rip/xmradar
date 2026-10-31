import { normalizeHost } from './feed';
import type { GuardAnswer } from './guard-rules';

/**
 * "Report this copy" (PLAN-NAMEPILL-REPORT, part B): on the user's click only, the bare host and the listing it
 * copies go to xmr.club's review queue. xmr.club stores no IP address or client data with a report.
 */
export const REPORT_URL = 'https://xmr.club/api/v1/report-impersonator';

export type ReportStatus = 'sent' | 'limited' | 'failed' | 'already';

/** What a red, not-yet-listed answer reports: exactly `{ host, imitates }`; null for anything else. */
export function reportBody(a: GuardAnswer): { host: string; imitates: string } | null {
  if (a.kind !== 'red' || a.why === 'listed-phishing' || !a.siteId) return null;
  return { host: normalizeHost(a.host), imitates: a.siteId };
}

/** Sends a report: 202 → sent, 429 → limited, anything else (400, 413, 415, 5xx, network, timeout) → failed. */
export async function sendReport(body: { host: string; imitates: string }, fetchFn: typeof fetch, timeoutMs = 10_000): Promise<Exclude<ReportStatus, 'already'>> {
  try {
    const res = await fetchFn(REPORT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: body.host, imitates: body.imitates }),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 202) return 'sent';
    if (res.status === 429) return 'limited';
    return 'failed';
  } catch {
    return 'failed';
  }
}

interface Item<T> {
  getValue(): Promise<T>;
  setValue(v: T): Promise<void>;
}

/** The Report button's state for an answer: shown (red, not listed, setting on) and whether it was sent already. */
export async function reportFlags(a: GuardAnswer, on: boolean, reported: Item<string[]>): Promise<{ report: boolean; reported: boolean }> {
  const body = reportBody(a);
  if (!on || !body) return { report: false, reported: false };
  return { report: true, reported: (await reported.getValue()).includes(body.host) };
}

// reports run one at a time, so two warning pages for one host can't both send it, and two hosts can't
// overwrite each other's record
let reporting: Promise<unknown> = Promise.resolve();

/** A click on Report: one per host per session, recorded only once xmr.club took it (202). */
export function reportCopy(a: GuardAnswer, on: boolean, reported: Item<string[]>, fetchFn: typeof fetch): Promise<ReportStatus> {
  const body = on ? reportBody(a) : null;
  if (!body) return Promise.reject(new Error('Nothing to report'));
  const run = async (): Promise<ReportStatus> => {
    if ((await reported.getValue()).includes(body.host)) return 'already';
    const status = await sendReport(body, fetchFn);
    // xmr.club took it: that stands even if keeping the note of it fails
    if (status === 'sent') await reported.setValue([...(await reported.getValue()), body.host].slice(-500)).catch(() => {});
    return status;
  };
  const p = reporting.then(run, run);
  reporting = p.catch(() => {});
  return p;
}
