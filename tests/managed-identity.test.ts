import { verifyEvent } from 'nostr-tools/pure';
import { decode } from 'nostr-tools/nip19';
import { describe, expect, it } from 'vitest';
import { KindNotAllowed, MANAGED_KINDS, managedIdentity, memoryKeyStore } from '../src/identity/managed';

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
});
