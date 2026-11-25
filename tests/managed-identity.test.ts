import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { decode, nsecEncode } from 'nostr-tools/nip19';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { KeyReplaceRequired, KindNotAllowed, MANAGED_KINDS, managedIdentity, memoryKeyStore, parseSecretKey } from '../src/identity/managed';
import { isExactExtensionPageSender } from '../src/sender';

// PLAN-MANAGEDID
describe('the XMRadar identity', () => {
  it('is made once, on first use, and kept', async () => {
    const store = memoryKeyStore();
    const id = managedIdentity(store, () => 1);
    expect(await id.pubkey()).toBeNull();
    const a = await id.ensure();
    expect(a.created).toBe(true);
    const b = await managedIdentity(store).ensure();
    expect(b).toEqual({ pubkey: a.pubkey, created: false });
    expect(await id.pubkey()).toBe(a.pubkey);
  });
  it('signs only XMRadar’s own kinds, and what it signs verifies', async () => {
    const id = managedIdentity(memoryKeyStore());
    const { pubkey } = await id.ensure();
    const ev = await id.sign({ kind: 17, created_at: 1, tags: [['k', 'web']], content: 'ɱ❤' });
    expect(ev.pubkey).toBe(pubkey);
    expect(verifyEvent(ev)).toBe(true);
    for (const kind of [1, 4, 30023, 24242, 9734, 1059]) await expect(id.sign({ kind, created_at: 1, tags: [], content: '' })).rejects.toBeInstanceOf(KindNotAllowed);
    expect([...MANAGED_KINDS].sort((a, b) => a - b)).toEqual([0, 5, 17, 9042, 9044, 10002, 10011, 10133, 27235]);
  });
  it('exports as an nsec of the same key, and is gone after delete', async () => {
    const store = memoryKeyStore();
    const id = managedIdentity(store);
    const { pubkey } = await id.ensure();
    const nsec = (await id.exportNsec())!;
    const d = decode(nsec);
    expect(d.type).toBe('nsec');
    const { getPublicKey } = await import('nostr-tools/pure');
    expect(getPublicKey(d.data as Uint8Array)).toBe(pubkey);
    await id.forget();
    expect(await id.pubkey()).toBeNull();
    expect(await id.exportNsec()).toBeNull();
    await expect(id.sign({ kind: 17, created_at: 1, tags: [], content: '' })).rejects.toThrow('No XMRadar identity');
  });
  it('only the background imports it (content scripts and pages never hold the key)', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
    const users = walk(join(process.cwd(), 'src')).filter((f) => /\.ts$/.test(f) && /identity\/managed['"]/.test(readFileSync(f, 'utf8')));
    expect(users.map((f) => f.slice(f.indexOf('src/')))).toEqual(['src/entrypoints/background.ts']);
  });
});

import { bySignerMode, NoSignerError } from '../src/identity/signer-mode';
describe('which key signs', () => {
  const run = (mode: 'auto' | 'signer' | 'managed', signer: () => Promise<string>) => {
    const fellBack = { yes: false };
    const p = bySignerMode(mode, signer, async () => 'managed', async () => void (fellBack.yes = true));
    return { p, fellBack };
  };
  it('auto: the signer when there is one; the XMRadar identity only when there’s none at all', async () => {
    expect(await run('auto', async () => 'signer').p).toBe('signer');
    const none = run('auto', async () => {
      throw new NoSignerError('none');
    });
    expect(await none.p).toBe('managed');
    expect(none.fellBack.yes).toBe(true);
  });
  it('a refusal or any other signer error is never replaced by the XMRadar identity', async () => {
    const refused = run('auto', async () => {
      throw new Error('User rejected');
    });
    await expect(refused.p).rejects.toThrow('User rejected');
    expect(refused.fellBack.yes).toBe(false);
  });
  it('signer: never the XMRadar identity; managed: never the signer', async () => {
    await expect(run('signer', async () => { throw new NoSignerError('none'); }).p).rejects.toBeInstanceOf(NoSignerError);
    let asked = false;
    expect(await run('managed', async () => ((asked = true), 'signer')).p).toBe('managed');
    expect(asked).toBe(false);
  });
});

describe('review fixes (PLAN-MANAGEDID)', () => {
  it('two signatures at once make one key', async () => {
    const store = memoryKeyStore();
    const id = managedIdentity(store);
    const [a, b, c] = await Promise.all([id.ensure(), id.ensure(), id.ensure()]);
    expect(new Set([a.pubkey, b.pubkey, c.pubkey]).size).toBe(1);
    expect([a, b, c].filter((x) => x.created).length).toBe(1);
  });

  it('imports user nsec or 64-hex, enforces overwrite confirm, supports rollback, and never echoes secret in errors', async () => {
    const sk1 = generateSecretKey();
    const pk1 = getPublicKey(sk1);
    const nsec1 = nsecEncode(sk1);
    const sk2 = generateSecretKey();
    const pk2 = getPublicKey(sk2);
    const hex2 = bytesToHex(sk2);

    // Validation & sanitized errors
    expect(bytesToHex(parseSecretKey(`  ${nsec1}  `))).toBe(bytesToHex(sk1));
    expect(bytesToHex(parseSecretKey(nsec1.toUpperCase()))).toBe(bytesToHex(sk1));
    expect(bytesToHex(parseSecretKey(hex2))).toBe(hex2);

    const mixedCase = nsec1.slice(0, 6).toUpperCase() + nsec1.slice(6);
    for (const bad of ['', 'not-a-key', mixedCase, '0'.repeat(64), 'f'.repeat(64), `${nsec1.slice(0, 10)} ${nsec1.slice(10)}`]) {
      let msg = '';
      try {
        parseSecretKey(bad);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toMatch(/Enter a valid Nostr private key/);
      if (bad.length > 4) expect(msg).not.toContain(bad.slice(0, 8));
    }

    const store = memoryKeyStore();
    const id = managedIdentity(store);

    // Fresh import works without confirmation
    const first = await id.importKey(nsec1);
    expect(first.pubkey).toBe(pk1);
    expect(first.unchanged).toBe(false);
    expect(await id.pubkey()).toBe(pk1);

    // Re-importing the exact same key is a no-op
    const same = await id.importKey(nsec1);
    expect(same.pubkey).toBe(pk1);
    expect(same.unchanged).toBe(true);

    // Replacing a different key requires confirmOverwrite
    await expect(id.importKey(hex2)).rejects.toBeInstanceOf(KeyReplaceRequired);
    expect(await id.pubkey()).toBe(pk1);

    // Confirmed replacement succeeds and can roll back cleanly
    const replaced = await id.importKey(hex2, { confirmOverwrite: true });
    expect(replaced.pubkey).toBe(pk2);
    expect(replaced.unchanged).toBe(false);
    expect(await id.pubkey()).toBe(pk2);

    await replaced.rollback();
    expect(await id.pubkey()).toBe(pk1);

    // Stale rollback must NOT clobber a newer concurrent import
    const sk3 = generateSecretKey();
    const pk3 = getPublicKey(sk3);
    const impA = await id.importKey(hex2, { confirmOverwrite: true });
    const impB = await id.importKey(bytesToHex(sk3), { confirmOverwrite: true });
    expect(impB.pubkey).toBe(pk3);
    await impA.rollback();
    expect(await id.pubkey()).toBe(pk3);

    // Imported key remains bound to MANAGED_KINDS
    await expect(id.sign({ kind: 1, created_at: 1, tags: [], content: '' })).rejects.toBeInstanceOf(KindNotAllowed);
  });

  it('isExactExtensionPageSender allows only top-frame options/setup pages', () => {
    const base = 'moz-extension://abc-123/';
    expect(isExactExtensionPageSender({ id: 'xmradar@local', frameId: 0, url: `${base}options.html#identity` }, 'xmradar@local', base, ['/options.html', '/setup.html'])).toBe(true);
    expect(isExactExtensionPageSender({ id: 'xmradar@local', frameId: 0, url: `${base}setup.html?x=1#casper` }, 'xmradar@local', base, ['/options.html', '/setup.html'])).toBe(true);
    expect(isExactExtensionPageSender({ id: 'xmradar@local', frameId: 1, url: `${base}options.html` }, 'xmradar@local', base, ['/options.html', '/setup.html'])).toBe(false);
    expect(isExactExtensionPageSender({ id: 'xmradar@local', frameId: 0, url: `${base}popup.html` }, 'xmradar@local', base, ['/options.html', '/setup.html'])).toBe(false);
    expect(isExactExtensionPageSender({ id: 'xmradar@local', frameId: 0, url: `${base}guard.html` }, 'xmradar@local', base, ['/options.html', '/setup.html'])).toBe(false);
    expect(isExactExtensionPageSender({ id: 'xmradar@local', frameId: 0, url: `${base}options.html.evil` }, 'xmradar@local', base, ['/options.html', '/setup.html'])).toBe(false);
  });
});
