import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { checkLetter, letterAddresses, namesOrder, type LetterAddress } from '../src/log/check';
import { letterAddressLines, letterCopyWarning, PAGE_CHARS } from '../src/log/page';
import { verifyLetter } from '../src/log/pgp';
import type { SiteLog } from '../src/sites/feed';

const fx = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/log/letters.json'), 'utf8')) as { keys: Record<string, { fingerprint: string; key: string }>; letters: Record<string, string> };
const deps = { verifyLetter };
const PAYOUT = '45istt3RSruFAerMyAgX2WFtRSkLXGeyiJ7VyvWVm46hEmuZZa4rY5NHJBPyh5UyUpUDH6kvN8JAFgoUCoWTjKNp6D4RuTK';
const MISTEX_KEY = 'j/1x9v9Sv7n0BlSIbrW0IbsoAphfRrkF0pn9ObTRr7k=';
const pgp = (site: string): SiteLog => ({ format: 'pgp', url: null, fingerprint: fx.keys[site]!.fingerprint, publicKey: fx.keys[site]!.key });

describe('letterAddresses: the labelled addresses of each real letter', () => {
  it.each([
    // the USDT contract it names is a valid Tron address too, with no role
    ['bitcoinvn-BV97MXQZ.asc', [{ address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', role: 'token' }, { address: 'TDmAwaqvQms5G6XmgX3hDpiN44ejYY1ara', role: 'deposit' }, { address: PAYOUT, role: 'payout' }]],
    ['0trace-89839aca.asc', [{ address: 'bc1q0mnej0zw66mu59q7cnw32pc3lh8zuqrmxsac06', role: 'deposit' }, { address: PAYOUT, role: 'payout' }]],
    ['bitania-jbstqmqrr6.asc', [{ address: '33oxUEHe5VLTzZZZrdbuAvpVgnyCiPUi7p', role: 'deposit' }, { address: PAYOUT, role: 'payout' }]],
    ['sageswap-ded558e8.asc', [{ address: 'bc1q9a6k7z7wvzcvsy9tlrefl0kz67ma593spst9kv', role: 'deposit' }, { address: PAYOUT, role: 'payout' }]],
    ['stereoswap-STRRSXUE.asc', [{ address: 'bc1qmumua59vdrukll6segkjm2zh0zgp5fphrtgtx9', role: 'deposit' }, { address: PAYOUT, role: 'payout' }]],
  ])('%s', (file, want) => {
    expect(letterAddresses(fx.letters[file]!)).toEqual(want);
  });

  it('reads refund addresses and ignores prose', () => {
    expect(letterAddresses('Refund address: bc1q9a6k7z7wvzcvsy9tlrefl0kz67ma593spst9kv\nThe deposit address, destination address and amounts are covered.')).toEqual([{ address: 'bc1q9a6k7z7wvzcvsy9tlrefl0kz67ma593spst9kv', role: 'refund' }]);
    expect(letterAddresses('Signing fingerprint: 58585DB0F0C377F2A3CD7DE8F15B48DF3D11EF7A')).toEqual([]);
  });

  it('reads short labels and unlabelled addresses; tokens must be valid addresses', () => {
    expect(letterAddresses(`Deposit: bc1q9a6k7z7wvzcvsy9tlrefl0kz67ma593spst9kv\nPayout: ${PAYOUT}\nSend to 0x52908400098527886E0F7030069857D2E4169EE7 please`)).toEqual([
      { address: 'bc1q9a6k7z7wvzcvsy9tlrefl0kz67ma593spst9kv', role: 'deposit' },
      { address: PAYOUT, role: 'payout' },
      { address: '0x52908400098527886E0F7030069857D2E4169EE7', role: null },
    ]);
    // a labelled line still needs a valid address: a txid or a bad checksum is not one
    expect(letterAddresses('Deposit address: bc1q9a6k7z7wvzcvsy9tlrefl0kz67ma593spst9kx\nPayout txid: 4b2a1f9e8d7c6b5a4b2a1f9e8d7c6b5a4b2a1f9e8d7c6b5a4b2a1f9e8d7c6b5a')).toEqual([]);
    // one address in either case is one address, with the labelled role
    expect(letterAddresses(`See 0x52908400098527886e0f7030069857d2e4169ee7\nDeposit address: 0x52908400098527886E0F7030069857D2E4169EE7`)).toEqual([{ address: '0x52908400098527886E0F7030069857D2E4169EE7', role: 'deposit' }]);
    // a labelled mention wins over an earlier unlabelled one
    expect(letterAddresses(`We sent ${PAYOUT}\nPayout address: ${PAYOUT}`)).toEqual([{ address: PAYOUT, role: 'payout' }]);
  });
});

describe('namesOrder: a whole token only', () => {
  it('matches the id, not a longer one', () => {
    expect(namesOrder('Swap ID: STRRSXUE\n', 'STRRSXUE')).toBe(true);
    expect(namesOrder('order_short_id: "BV97MXQZ"', 'BV97MXQZ')).toBe(true);
    expect(namesOrder('Order: 89839aca-70b1-4f1b-bba3-bf35c2beb8db', '89839aca-70b1-4f1b-bba3-bf35c2beb8db')).toBe(true);
    expect(namesOrder('Swap ID: STRRSXUE2', 'STRRSXUE')).toBe(false);
    expect(namesOrder('Order: 89839aca-70b1-4f1b-bba3-bf35c2beb8db', '89839aca')).toBe(false);
    expect(namesOrder('x.y', 'x.y') && !namesOrder('xzy', 'x.y')).toBe(true);
  });
});

describe('checkLetter', () => {
  it.each([
    ['bitcoinvn', 'bitcoinvn-BV97MXQZ.asc', 'BV97MXQZ'],
    ['0trace', '0trace-89839aca.asc', '89839aca-70b1-4f1b-bba3-bf35c2beb8db'],
    ['bitania', 'bitania-jbstqmqrr6.asc', 'jbstqmqrr6'],
    ['sageswap', 'sageswap-ded558e8.asc', 'ded558e8-d489-46d0-97de-5b5f9fd8f4ae'],
    ['stereoswap', 'stereoswap-STRRSXUE.asc', 'STRRSXUE'],
  ])('%s: verified, for this order', async (site, file, orderId) => {
    const r = await checkLetter(fx.letters[file]!, { siteName: site, log: pgp(site), orderId }, deps);
    expect(r).toMatchObject({ format: 'pgp', verified: true, lines: [{ level: 'ok' }] });
    expect(r.lines[0]!.text).toContain(fx.keys[site]!.fingerprint.slice(-8));
    expect(r.signedText).toContain(orderId);
    expect(r.addresses.find((a) => a.role === 'deposit')).toBeTruthy();
  });

  it('warns when the letter is for another order', async () => {
    const r = await checkLetter(fx.letters['stereoswap-STRRSXUE.asc']!, { siteName: 'StereoSwap', log: pgp('stereoswap'), orderId: 'STRXXXXX' }, deps);
    expect(r).toMatchObject({ verified: false, addresses: [], signedText: '', lines: [{ level: 'warn' }] });
  });

  it('warns on a bad signature, cautions on a missing key, and says "not available" for no letter', async () => {
    const tampered = fx.letters['0trace-89839aca.asc']!.replace('bc1q0mnej0zw66mu59q7cnw32pc3lh8zuqrmxsac06', 'bc1q0mnej0zw66mu59q7cnw32pc3lh8zuqrmxsac07');
    expect(await checkLetter(tampered, { siteName: '0trace', log: pgp('0trace'), orderId: '89839aca-70b1-4f1b-bba3-bf35c2beb8db' }, deps)).toMatchObject({ verified: false, lines: [{ level: 'warn' }] });
    const noKey: SiteLog = { ...(pgp('0trace') as Extract<SiteLog, { format: 'pgp' }>), publicKey: null };
    const spy = vi.fn(verifyLetter);
    expect(await checkLetter(fx.letters['0trace-89839aca.asc']!, { siteName: '0trace', log: noKey, orderId: 'x1234' }, { verifyLetter: spy })).toMatchObject({ lines: [{ level: 'caution' }] });
    expect(spy).not.toHaveBeenCalled();
    expect(await checkLetter('<html>Not found</html>', { siteName: '0trace', log: pgp('0trace'), orderId: 'x1234' }, deps)).toMatchObject({ verified: false, lines: [{ level: 'off' }] });
    // the right letter checked against a key whose fingerprint isn't the listed one
    const swapped: SiteLog = { ...(pgp('0trace') as Extract<SiteLog, { format: 'pgp' }>), publicKey: fx.keys.bitania!.key };
    expect(await checkLetter(fx.letters['0trace-89839aca.asc']!, { siteName: '0trace', log: swapped, orderId: 'x1234' }, deps)).toMatchObject({ lines: [{ level: 'caution' }] });
  });

  it('refuses a multi-block file where a later block is for another order', async () => {
    const openpgp = await import('openpgp');
    const { privateKey, publicKey } = await openpgp.generateKey({ type: 'ecc', curve: 'ed25519Legacy', userIDs: [{ name: 't' }], format: 'object' });
    const sign = async (text: string) => (await openpgp.sign({ message: await openpgp.createCleartextMessage({ text }), signingKeys: privateKey as never })) as string;
    const log: SiteLog = { format: 'pgp', url: null, fingerprint: (publicKey as never as { getFingerprint(): string }).getFingerprint(), publicKey: (publicKey as never as { armor(): string }).armor() };
    const both = `${await sign('Swap ID: abcd1234\nStatement: created')}\n${await sign('Swap ID: zzzz9999\nStatement: sent')}`;
    expect(await checkLetter(both, { siteName: 'Bitania', log, orderId: 'abcd1234' }, deps)).toMatchObject({ verified: false, lines: [{ level: 'warn' }] });
    const same = `${await sign('Swap ID: abcd1234\nStatement: created')}\n${await sign('Swap ID: abcd1234\nStatement: sent')}`;
    expect(await checkLetter(same, { siteName: 'Bitania', log, orderId: 'abcd1234' }, deps)).toMatchObject({ verified: true });
  });

  it('MistProof: verified for this order, with its roles; another order or key warns', async () => {
    const log: SiteLog = { format: 'mistproof', url: null, ed25519Key: MISTEX_KEY };
    const real = fx.letters['mistex-DX-4W850L.json']!;
    expect(await checkLetter(real, { siteName: 'Mistex', log, orderId: 'DX-4W850L' }, deps)).toMatchObject({
      verified: true,
      addresses: [
        { address: 'bc1qy3xrhl57lw6fwllypel8adpmjra9yczchxy982', role: 'deposit' },
        { address: PAYOUT, role: 'payout' },
      ],
    });
    expect(await checkLetter(real, { siteName: 'Mistex', log, orderId: 'DX-OTHER1' }, deps)).toMatchObject({ verified: false, lines: [{ level: 'warn' }] });
    expect(await checkLetter('{"not":"a proof"}', { siteName: 'Mistex', log, orderId: 'DX-4W850L' }, deps)).toMatchObject({ verified: false, lines: [{ level: 'off' }] });
  });
});

describe('letterAddressLines: the page against a verified letter', () => {
  const signed: LetterAddress[] = [
    { address: 'bc1qmumua59vdrukll6segkjm2zh0zgp5fphrtgtx9', role: 'deposit' },
    { address: PAYOUT, role: 'payout' },
  ];
  const page = (html: string) => {
    document.body.innerHTML = html;
    return document;
  };

  it('ok when the full deposit address is shown', () => {
    expect(letterAddressLines(page(`<p>Deposit to <code>bc1qmumua59vdrukll6segkjm2zh0zgp5fphrtgtx9</code></p><p>${PAYOUT}</p>`), signed)).toEqual([{ level: 'ok', text: expect.stringContaining('the one in the signed letter') }]);
  });

  it('bech32 compares case-insensitively', () => {
    expect(letterAddressLines(page('<p>Deposit address: BC1QMUMUA59VDRUKLL6SEGKJM2ZH0ZGP5FPHRTGTX9</p>'), signed)).toMatchObject([{ level: 'ok' }]);
  });

  it('only a caution when the signed deposit is shown without a deposit label', () => {
    expect(letterAddressLines(page('<p>BC1QMUMUA59VDRUKLL6SEGKJM2ZH0ZGP5FPHRTGTX9</p>'), signed)).toMatchObject([{ level: 'caution', text: expect.stringContaining('not labelled') }]);
  });

  it('warns when the page swaps the signed roles', () => {
    const lines = letterAddressLines(page(`<div><p>Send to</p><code>${PAYOUT}</code></div><div><p>You receive at</p><code>bc1qmumua59vdrukll6segkjm2zh0zgp5fphrtgtx9</code></div>`), signed);
    expect(lines.map((l) => l.level)).toEqual(['warn', 'warn']);
    expect(lines.some((l) => l.level === 'ok')).toBe(false);
  });

  it('no ok when a shortened address fits nothing signed, even with the full deposit shown', () => {
    const lines = letterAddressLines(page('<p>Deposit address: bc1qmumua59vdrukll6segkjm2zh0zgp5fphrtgtx9</p><p>bc1q…zzzz</p>'), signed);
    expect(lines).toMatchObject([{ level: 'caution', text: expect.stringContaining('bc1q…zzzz') }]);
  });

  it('no ok when the page is too long to read whole', () => {
    const lines = letterAddressLines(page(`<p>Deposit address: bc1qmumua59vdrukll6segkjm2zh0zgp5fphrtgtx9</p><p>${'x'.repeat(PAGE_CHARS)}</p>`), signed);
    expect(lines).toMatchObject([{ level: 'caution', text: expect.stringContaining('too long') }]);
  });

  it('only a caution, with the full signed address, when the page shortens it (StereoSwap shows "bc1q...gtx9")', () => {
    const lines = letterAddressLines(page('<p>Deposit to Address</p><p>bc1q...gtx9</p>'), signed);
    expect(lines).toMatchObject([{ level: 'caution' }]);
    expect(lines[0]!.text).toContain('bc1qmumua59vdrukll6segkjm2zh0zgp5fphrtgtx9');
  });

  it('warns about a full BTC or XMR address the letter does not name', () => {
    const other = 'bc1q9a6k7z7wvzcvsy9tlrefl0kz67ma593spst9kv';
    const lines = letterAddressLines(page(`<p>Deposit to <code>${other}</code></p>`), signed);
    expect(lines[0]).toMatchObject({ level: 'warn' });
    expect(lines.some((l) => l.level === 'ok')).toBe(false);
  });

  it('cautions about a shortened address that fits nothing signed', () => {
    const lines = letterAddressLines(page('<p>bc1q...gtx9</p><p>bc1q…zzzz</p>'), signed);
    expect(lines.map((l) => l.level)).toEqual(['caution', 'caution']);
    expect(lines[0]!.text).toContain('bc1q…zzzz');
  });

  it('a shortened order id that starts like an address is not a stray address (0trace: 1c3571ba...0185)', () => {
    const html = `<p>ID: 1c3571ba...0185</p><p>Deposit to <code>bc1qmumua59vdrukll6segkjm2zh0zgp5fphrtgtx9</code></p>`;
    const orderId = '1c3571ba-cfac-42e0-bd85-db5be2f60185';
    expect(letterAddressLines(page(html), signed, [orderId])).toMatchObject([{ level: 'ok' }]);
    expect(letterAddressLines(page(html), signed).map((l) => l.level)).toContain('caution');
  });

  it('cautions when the deposit address is not on the page as text, naming the signed one', () => {
    const lines = letterAddressLines(page('<img alt="QR">'), signed);
    expect(lines).toMatchObject([{ level: 'caution' }]);
    expect(lines[0]!.text).toContain('bc1qmumua59vdrukll6segkjm2zh0zgp5fphrtgtx9');
  });

  it('ignores hidden text and scripts', () => {
    const other = 'bc1q9a6k7z7wvzcvsy9tlrefl0kz67ma593spst9kv';
    const lines = letterAddressLines(page(`<p hidden>${other}</p><script>var a="${other}"</script><p>Deposit address: bc1qmumua59vdrukll6segkjm2zh0zgp5fphrtgtx9</p>`), signed);
    expect(lines).toMatchObject([{ level: 'ok' }]);
  });

  it('a Tron deposit (BitcoinVN): matched as an exact token', () => {
    const tron: LetterAddress[] = [{ address: 'TDmAwaqvQms5G6XmgX3hDpiN44ejYY1ara', role: 'deposit' }];
    expect(letterAddressLines(page('<p>Deposit address: TDmAwaqvQms5G6XmgX3hDpiN44ejYY1ara</p>'), tron)).toMatchObject([{ level: 'ok' }]);
    expect(letterAddressLines(page('<p>TDmAwaqvQms5…ejYY1ara</p>'), tron)).toMatchObject([{ level: 'caution' }]);
    expect(letterAddressLines(page('<p>xTDmAwaqvQms5G6XmgX3hDpiN44ejYY1ara</p>'), tron)).toMatchObject([{ level: 'caution' }]);
    // BitcoinVN's page: the "…" is hidden, so the text reads prefix, space, suffix
    const split = letterAddressLines(page('<p>Single-use address</p><span>TDmAwaqvQms5</span><span hidden>…</span><span>ejYY1ara</span>'), tron);
    expect(split).toMatchObject([{ level: 'caution', text: expect.stringContaining('shortened') }]);
    // two words that don't fit it are no shortened address
    expect(letterAddressLines(page('<p>Single-use address</p><span>TDmAwaqvQms5 xxxxxxxx</span>'), tron)[0]!.text).toContain('not found');
  });

  it('warns about a Tron address the letter does not name, in the deposit slot', () => {
    const tron: LetterAddress[] = [{ address: 'TDmAwaqvQms5G6XmgX3hDpiN44ejYY1ara', role: 'deposit' }];
    const lines = letterAddressLines(page('<p>Deposit address: TAcWbsKJryUGAGqHSJWa8bhgZQJtkvCaGd</p>'), tron);
    expect(lines[0]).toMatchObject({ level: 'warn', text: expect.stringContaining('TAcWbsKJ') });
    expect(lines.some((l) => l.level === 'ok')).toBe(false);
  });

  it('warns when a signed address without a role (BitcoinVN’s token contract) sits in the deposit slot', () => {
    const vn: LetterAddress[] = [
      { address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', role: null },
      { address: 'TDmAwaqvQms5G6XmgX3hDpiN44ejYY1ara', role: 'deposit' },
    ];
    const lines = letterAddressLines(page('<p>Deposit address: TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t</p><div><p>Letter</p><p>Ours: TDmAwaqvQms5G6XmgX3hDpiN44ejYY1ara and the deposit</p></div>'), vn);
    expect(lines[0]).toMatchObject({ level: 'warn' });
    expect(lines.some((l) => l.level === 'ok')).toBe(false);
  });

  it('a Tron or EVM address on a BTC order page is checked too', () => {
    const lines = letterAddressLines(page('<p>Deposit address: bc1qmumua59vdrukll6segkjm2zh0zgp5fphrtgtx9</p><p>Or USDT: TAcWbsKJryUGAGqHSJWa8bhgZQJtkvCaGd</p>'), signed);
    expect(lines[0]).toMatchObject({ level: 'warn', text: expect.stringContaining('TAcWbsKJ') });
    expect(letterCopyWarning('0x8617E340B3D01FA5F11F306F4090FD50E238070D', signed)).toContain("doesn't name");
  });

  it('EVM: compares case-insensitively and warns about another one', () => {
    const evm: LetterAddress[] = [{ address: '0x52908400098527886E0F7030069857D2E4169EE7', role: 'deposit' }];
    expect(letterAddressLines(page('<p>Deposit address: 0x52908400098527886e0f7030069857d2e4169ee7</p>'), evm)).toMatchObject([{ level: 'ok' }]);
    expect(letterAddressLines(page('<p>Deposit address: 0x8617E340B3D01FA5F11F306F4090FD50E238070D</p>'), evm)[0]).toMatchObject({ level: 'warn' });
  });

  it('cautions when the letter names no deposit address', () => {
    expect(letterAddressLines(page('<p>hi</p>'), [{ address: PAYOUT, role: 'payout' }])).toMatchObject([{ level: 'caution' }]);
  });
});

describe('letterCopyWarning', () => {
  const signed: LetterAddress[] = [{ address: 'bc1qmumua59vdrukll6segkjm2zh0zgp5fphrtgtx9', role: 'deposit' }];
  it('warns only for a copied address the letter does not name', () => {
    expect(letterCopyWarning(' bc1qmumua59vdrukll6segkjm2zh0zgp5fphrtgtx9 ', signed)).toBeNull();
    expect(letterCopyWarning('bc1q9a6k7z7wvzcvsy9tlrefl0kz67ma593spst9kv', signed)).toContain("doesn't name");
    expect(letterCopyWarning('0.1 BTC', signed)).toBeNull();
  });

  it('checks Tron copies when the letter names a Tron address', () => {
    const tron: LetterAddress[] = [{ address: 'TDmAwaqvQms5G6XmgX3hDpiN44ejYY1ara', role: 'deposit' }];
    expect(letterCopyWarning('TDmAwaqvQms5G6XmgX3hDpiN44ejYY1ara', tron)).toBeNull();
    expect(letterCopyWarning('TAcWbsKJryUGAGqHSJWa8bhgZQJtkvCaGd', tron)).toContain("doesn't name");
  });
});
