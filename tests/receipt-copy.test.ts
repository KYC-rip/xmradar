import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { startReceipts } from '../src/entrypoints/content/receipt';

const send = vi.hoisted(() => vi.fn());
const renders = vi.hoisted(() => [] as { entries: { lines: { level: string; text: string }[] }[]; extra: { level: string; text: string }[] }[]);
vi.mock('../src/messaging', async (orig) => ({ ...(await orig<typeof import('../src/messaging')>()), sendToBackground: send }));
vi.mock('../src/entrypoints/content/receipt-card', async (orig) => ({
  ...(await orig<typeof import('../src/entrypoints/content/receipt-card')>()),
  mountReceiptCard: () => ({ render: (entries: never, extra: never) => renders.push({ entries, extra }), remove: () => {} }),
}));

const v2 = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/nkip01/v2.json'), 'utf8'));
const receipt = { ...v2.cases[0].receipt, deposit_address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' };
const OTHER = '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy';

describe('copy check and page lines (content script)', () => {
  it('the card gets the address lines, the event line, and a copy warning', async () => {
    fakeBrowser.reset();
    send.mockResolvedValue({ receipt, lines: [{ level: 'ok', text: 'Signed by example.swap' }], saved: true });
    document.body.innerHTML = `<script type="application/nkip01+json">${JSON.stringify(receipt)}</script><p>Deposit: ${receipt.deposit_address}</p>`;
    const off: (() => void)[] = [];
    startReceipts({ addEventListener: (t: EventTarget, e: string, h: EventListener) => t.addEventListener(e, h), onInvalidated: (cb: () => void) => off.push(cb) } as never);
    await vi.waitFor(() => expect(renders.length).toBeGreaterThan(0));
    const lines = renders.at(-1)!.entries[0]!.lines.map((l) => l.text);
    expect(lines[0]).toBe('Signed by example.swap');
    expect(lines.some((t) => t.startsWith('Deposit address matches'))).toBe(true);
    expect(lines.some((t) => t.startsWith('No event id shown'))).toBe(true);
    const sel = vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => OTHER } as Selection);
    document.dispatchEvent(new Event('copy'));
    sel.mockRestore();
    expect(renders.at(-1)!.extra).toEqual([{ level: 'warn', text: expect.stringContaining("didn't sign") }]);
    for (const cb of off) cb();
  });
});
