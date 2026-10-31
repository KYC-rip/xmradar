// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { pageLetterText } from '../src/entrypoints/content/receipt';
import { letterInText } from '../src/log/fetch';

const LETTER = '-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA512\n\nNOXSWAP LETTER OF GUARANTEE\nOrder ID: nx_test\n-----BEGIN PGP SIGNATURE-----\n\nabc\n-----END PGP SIGNATURE-----';

// Chrome's innerText leaves out a closed <details>' body; happy-dom doesn't lay out, so say what Chrome returns
const shownText = (text: string) => Object.defineProperty(document.body, 'innerText', { configurable: true, get: () => text });

describe('a letter kept in a collapsed block', () => {
  it('is read from a closed <details> (as NoxSwap shows it)', () => {
    document.body.innerHTML = `<details><summary>Letter of guarantee</summary><pre>${LETTER}</pre></details>`;
    shownText('Letter of guarantee');
    expect(letterInText(pageLetterText(document))).toBe(LETTER);
  });
  it('other hidden text is not taken', () => {
    document.body.innerHTML = '<details><summary>More</summary><pre>secret notes</pre></details>';
    shownText('More');
    expect(pageLetterText(document)).not.toContain('secret notes');
  });
  it('also from a <code> block, and a MistProof letter', () => {
    document.body.innerHTML = `<details><summary>Letter</summary><code>${LETTER}</code></details>`;
    shownText('Letter');
    expect(letterInText(pageLetterText(document))).toBe(LETTER);
    const mist = JSON.stringify({ alg: 'Ed25519', format: 'mistex-receipt/1', key_id: 'k', payload: '{}', signature: 's' });
    document.body.innerHTML = `<details><summary>Proof</summary><pre>${mist}</pre></details>`;
    shownText('Proof');
    expect(letterInText(pageLetterText(document))).toBe(mist);
  });
});
