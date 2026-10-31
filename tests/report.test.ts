// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { GuardAnswer } from '../src/sites/guard-rules';
import { REPORT_URL, reportBody, reportCopy, reportFlags, sendReport } from '../src/sites/report';
import { REPORT_TEXT, renderGuard, showReport } from '../src/ui/guard-view';

type Shown = Extract<GuardAnswer, { host: string; target: string }>;
const red = (over: Partial<Shown> = {}): Shown => ({
  kind: 'red',
  host: 'www.pegasussawp.com',
  url: 'https://www.pegasussawp.com/swap?x=1',
  why: 'typo',
  target: 'pegasusswap.com',
  name: 'PegasusSwap',
  siteId: 'pegasusswap',
  ...over,
});
const item = (v: string[] = []) => ({ v, async getValue() { return this.v; }, async setValue(x: string[]) { this.v = x; } });
const answer = (status: number) => vi.fn(async () => new Response(status === 202 ? '{}' : '{"error":"x"}', { status }));

describe('what a report sends', () => {
  it('exactly { host, imitates }: the bare host without www., the listing id from the feed', () => {
    expect(reportBody(red())).toEqual({ host: 'pegasussawp.com', imitates: 'pegasusswap' });
    expect(reportBody(red({ host: 'xn--trcador-bjg.app', why: 'homoglyph', siteId: 'trocador' }))).toEqual({ host: 'xn--trcador-bjg.app', imitates: 'trocador' });
  });
  it('nothing for an amber page, a copy xmr.club already lists, or a missing id', () => {
    expect(reportBody(red({ why: 'listed-phishing' }))).toBeNull();
    expect(reportBody({ ...red(), kind: 'same-name' } as GuardAnswer)).toBeNull();
    expect(reportBody({ ...red(), kind: 'name' } as GuardAnswer)).toBeNull();
    expect(reportBody(red({ siteId: '' }))).toBeNull();
    expect(reportBody({ kind: 'invalid' })).toBeNull();
  });
  it('the request: POST JSON, no cookies, no referrer, no redirects', async () => {
    const f = answer(202);
    expect(await sendReport({ host: 'pegasussawp.com', imitates: 'pegasusswap' }, f as never)).toBe('sent');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(REPORT_URL);
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', headers: { 'content-type': 'application/json' } });
    expect(JSON.parse(init.body as string)).toEqual({ host: 'pegasussawp.com', imitates: 'pegasusswap' });
  });
  it.each([
    [202, 'sent'],
    [429, 'limited'],
    [400, 'failed'],
    [413, 'failed'],
    [415, 'failed'],
    [500, 'failed'],
  ])('HTTP %i → %s', async (code, status) => expect(await sendReport({ host: 'a.example', imitates: 'x' }, answer(code) as never)).toBe(status));
  it('a network error or a timeout → failed', async () => {
    expect(await sendReport({ host: 'a.example', imitates: 'x' }, (async () => { throw new TypeError('offline'); }) as never)).toBe('failed');
    const hang = (_u: string, init: RequestInit) => new Promise<Response>((_r, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('timeout', 'TimeoutError'))));
    expect(await sendReport({ host: 'a.example', imitates: 'x' }, hang as never, 20)).toBe('failed');
  });
});

describe('one report per host, recorded only when xmr.club took it', () => {
  it('202 records it; the next click says already, without a request', async () => {
    const reported = item();
    const f = answer(202);
    expect(await reportCopy(red(), true, reported, f as never)).toBe('sent');
    expect(reported.v).toEqual(['pegasussawp.com']);
    expect(await reportCopy(red(), true, reported, f as never)).toBe('already');
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('limited or failed records nothing, so a retry sends again', async () => {
    const reported = item();
    expect(await reportCopy(red(), true, reported, answer(429) as never)).toBe('limited');
    expect(await reportCopy(red(), true, reported, answer(500) as never)).toBe('failed');
    expect(reported.v).toEqual([]);
    expect(await reportCopy(red(), true, reported, answer(202) as never)).toBe('sent');
  });
  it('two warning pages reporting one host at once: one request, the other says already', async () => {
    const reported = item();
    let release!: () => void;
    const f = vi.fn(() => new Promise<Response>((r) => (release = () => r(new Response('{}', { status: 202 })))));
    const one = reportCopy(red(), true, reported, f as never);
    const two = reportCopy(red(), true, reported, f as never);
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    release();
    expect(await one).toBe('sent');
    expect(await two).toBe('already');
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('two hosts at once: both recorded', async () => {
    const reported = item();
    await Promise.all([reportCopy(red(), true, reported, answer(202) as never), reportCopy(red({ host: 'trocadro.app', siteId: 'trocador' }), true, reported, answer(202) as never)]);
    expect(reported.v.sort()).toEqual(['pegasussawp.com', 'trocadro.app']);
  });
  it('a 202 stays sent even if keeping the record fails', async () => {
    const broken = { getValue: async () => [] as string[], setValue: async () => { throw new Error('quota'); } };
    expect(await reportCopy(red(), true, broken, answer(202) as never)).toBe('sent');
  });
  it('setting off, or nothing reportable: refused', async () => {
    await expect(reportCopy(red(), false, item(), answer(202) as never)).rejects.toThrow();
    await expect(reportCopy(red({ why: 'listed-phishing' }), true, item(), answer(202) as never)).rejects.toThrow();
  });
  it('the button flag: only red not-listed with the setting on; reported after a sent one', async () => {
    expect(await reportFlags(red(), true, item())).toEqual({ report: true, reported: false });
    expect(await reportFlags(red(), true, item(['pegasussawp.com']))).toEqual({ report: true, reported: true });
    expect(await reportFlags(red(), false, item())).toEqual({ report: false, reported: false });
    expect(await reportFlags(red({ why: 'listed-phishing' }), true, item())).toEqual({ report: false, reported: false });
    expect(await reportFlags({ ...red(), kind: 'same-name' } as GuardAnswer, true, item())).toEqual({ report: false, reported: false });
  });
});

describe('the Report button on the warning page', () => {
  const page = () => {
    document.body.innerHTML = readFileSync(join(process.cwd(), 'src/entrypoints/guard/index.html'), 'utf8').replace(/^[\s\S]*<body>|<\/body>[\s\S]*$/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
    return (id: string) => document.getElementById(id)!;
  };
  it('shown only when the background says so', () => {
    let $ = page();
    renderGuard(document, { ...red(), report: true }, () => {}, async () => 'sent');
    expect($('report-box').hidden).toBe(false);
    $ = page();
    renderGuard(document, red(), () => {}, async () => 'sent');
    expect($('report-box').hidden).toBe(true);
  });
  it('already reported from this browser: disabled with that text', () => {
    const $ = page();
    renderGuard(document, { ...red(), report: true, reported: true }, () => {}, async () => 'sent');
    expect(($('report') as HTMLButtonElement).disabled).toBe(true);
    expect($('report-status').textContent).toBe('Already reported from this browser.');
  });
  it('each outcome: sent and already end it; limited and failed let the user try again', () => {
    const $ = page();
    renderGuard(document, { ...red(), report: true }, () => {}, async () => 'sent');
    const btn = $('report') as HTMLButtonElement;
    for (const [s, disabled] of [['sent', true], ['already', true], ['limited', false], ['failed', false]] as const) {
      btn.disabled = true;
      showReport(btn, $('report-status'), s);
      expect($('report-status').textContent).toBe(REPORT_TEXT[s]);
      expect(btn.disabled, s).toBe(disabled);
    }
  });
  it('an untrusted click sends nothing', () => {
    const $ = page();
    const send = vi.fn(async () => 'sent' as const);
    renderGuard(document, { ...red(), report: true }, () => {}, send);
    $('report').click();
    expect(send).not.toHaveBeenCalled();
  });
});
