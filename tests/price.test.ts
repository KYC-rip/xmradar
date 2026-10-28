import { describe, expect, it } from 'vitest';
import { formatXmr } from '../src/xap/amount';
import { fetchXmrUsd, picoToUsd, PRICE_API, usdToPico } from '../src/xap/price';

const answer = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('XMR price', () => {
  it('reads our price endpoint, without cookies', async () => {
    let seen: [string, RequestInit | undefined] | null = null;
    const f = (async (url: string, init?: RequestInit) => {
      seen = [url, init];
      return new Response(JSON.stringify({ sym: 'XMR', usd: 615.56 }));
    }) as unknown as typeof fetch;
    expect(await fetchXmrUsd(f)).toBe(615.56);
    expect(seen![0]).toBe(PRICE_API);
    expect(seen![1]!.credentials).toBe('omit');
  });

  it('refuses errors and implausible prices', async () => {
    await expect(fetchXmrUsd(answer({ error: 'price unavailable' }, 502))).rejects.toThrow('502');
    for (const usd of [null, '615', 0, 0.5, Number.MAX_VALUE, -3]) await expect(fetchXmrUsd(answer({ usd }))).rejects.toThrow('Price unavailable');
    await expect(fetchXmrUsd(answer(null))).rejects.toThrow('Price unavailable');
  });

  it('dollars to XMR, rounded up to 0.0001 so a shortcut is never below its dollars', () => {
    expect(formatXmr(usdToPico(5, 500))).toBe('0.01');
    expect(formatXmr(usdToPico(1, 615.56))).toBe('0.0017');
    expect(formatXmr(usdToPico(1, 900_000))).toBe('0.0001');
    expect(picoToUsd(usdToPico(20, 500), 500)).toBe('$20.00');
  });
});
