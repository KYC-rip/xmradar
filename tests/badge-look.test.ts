import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { storage } from 'wxt/utils/storage';
import { BADGE_CSS, badgeLook, buildBadge, MONERO_OUTER, MONERO_PARTS, MONERO_VIEWBOX, type BadgeIcon } from '../src/identity/badge-look';
import { migrateXmrSettingsV3, xmrSettingsItem } from '../src/settings';
import { mountBadgeLook } from '../src/ui/badge-look-controls';

const raw = readFileSync(join(process.cwd(), 'tests/fixtures/monero-vector.svg'));

describe('Monero symbol source', () => {
  it('is the monero-gui file at 5265e52', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe('db8919d5bbad50d9a28223d75d56e80f512d473875fbe63ac872ffe9ffa10e71');
  });
  it('copies its viewBox, transforms, paths and fills unchanged, without the clipPath', () => {
    const src = new DOMParser().parseFromString(raw.toString('utf8'), 'image/svg+xml');
    expect(src.documentElement.getAttribute('viewBox')).toBe(MONERO_VIEWBOX);
    expect(src.querySelector('svg > g')!.getAttribute('transform')).toBe(MONERO_OUTER);
    const parts = [...src.querySelectorAll('g[clip-path] > g')].map((g) => [g.getAttribute('transform'), g.querySelector('path')!.getAttribute('d'), g.querySelector('path')!.getAttribute('fill')]);
    expect(parts).toEqual(MONERO_PARTS.map((p) => [...p]));
    const color = buildBadge(document, { icon: 'color', label: true }, 'a');
    expect(color.querySelector('clipPath')).toBeNull();
  });
});

describe('badgeLook', () => {
  it('fills defaults for any stored value and never leaves the badge empty', () => {
    expect(badgeLook(null)).toEqual({ icon: 'mono', label: true });
    expect(badgeLook({})).toEqual({ icon: 'mono', label: true });
    expect(badgeLook({ badgeIcon: 'nope', badgeLabel: 'no' })).toEqual({ icon: 'mono', label: true });
    expect(badgeLook({ badgeIcon: 'color', badgeLabel: false })).toEqual({ icon: 'color', label: false });
    expect(badgeLook({ badgeIcon: 'none', badgeLabel: false })).toEqual({ icon: 'none', label: true });
  });
});

describe('buildBadge', () => {
  const cases: [BadgeIcon, boolean, number, boolean, string][] = [
    ['mono', true, 2, true, 'pill'],
    ['mono', false, 2, false, 'round'],
    ['color', true, 3, true, 'pill'],
    ['color', false, 3, false, 'round'],
    ['none', true, 0, true, 'pill'],
    ['none', false, 0, true, 'pill'],
  ];
  it.each(cases)('%s, label %s', (icon, label, paths, text, shape) => {
    const el = buildBadge(document, { icon, label }, 'XBToshi');
    expect(el.localName).toBe('button');
    expect(el.classList.contains(shape)).toBe(true);
    expect(el.querySelectorAll('path').length).toBe(paths);
    expect(el.textContent).toBe(text ? 'XMR' : '');
    expect(el.childNodes.length).toBeGreaterThan(0);
    expect(el.getAttribute('aria-label')).toBe('Accepts Monero — tip @XBToshi');
    const svg = el.querySelector('svg');
    if (paths) {
      expect(svg!.getAttribute('aria-hidden')).toBe('true');
      const fills = [...el.querySelectorAll('path')].map((p) => p.getAttribute('fill'));
      expect(fills).toEqual(icon === 'mono' ? ['currentColor', 'currentColor'] : ['#fff', '#f36e36', '#575757']);
    } else expect(svg).toBeNull();
  });
  it('previews are plain, hidden spans', () => {
    const el = buildBadge(document, { icon: 'mono', label: true }, null);
    expect(el.localName).toBe('span');
    expect(el.getAttribute('aria-hidden')).toBe('true');
  });
  it('keeps the round sizes: 16px colour symbol, 12px white symbol inset in its orange circle', () => {
    expect(BADGE_CSS).toContain('.round svg { width: 16px; height: 16px; }');
    expect(BADGE_CSS).toMatch(/\.round\.mono svg \{ width: 12px; height: 12px; \}/);
  });
  it('builds no markup from strings', () => {
    expect(readFileSync(join(process.cwd(), 'src/identity/badge-look.ts'), 'utf8')).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
  });
});

describe('settings v3', () => {
  beforeEach(() => fakeBrowser.reset());
  const v2 = { badgesX: false, badgesNostr: true, nostrDiscovery: true, tipReceipts: false };
  it('v2 gets the badge-look defaults and keeps the rest', async () => {
    await storage.setItem('sync:xmrSettings', v2);
    await storage.setMeta('sync:xmrSettings', { v: 2 });
    await xmrSettingsItem.migrate();
    expect(await xmrSettingsItem.getValue()).toEqual({ ...v2, badgeIcon: 'mono', badgeLabel: true });
  });
  it('keeps a look that is already there and replaces invalid values', () => {
    expect(migrateXmrSettingsV3({ ...v2, badgeIcon: 'color', badgeLabel: false })).toMatchObject({ badgeIcon: 'color', badgeLabel: false });
    expect(migrateXmrSettingsV3({ ...v2, badgeIcon: 'x' as never, badgeLabel: 1 as never })).toMatchObject({ badgeIcon: 'mono', badgeLabel: true });
  });
});

describe('options Badge look card', () => {
  const html = `<div id="t"><label class="look"><input type="radio" name="badge-icon" value="mono"/><span data-preview="mono"></span></label>
    <label class="look"><input type="radio" name="badge-icon" value="color"/><span data-preview="color"></span></label>
    <label class="look"><input type="radio" name="badge-icon" value="none"/><span data-preview="none"></span></label>
    <input type="checkbox" data-look="label"/></div>`;
  const $ = <T extends Element>(s: string) => document.querySelector<T>(s)!;
  beforeEach(() => {
    fakeBrowser.reset();
    document.body.innerHTML = html;
  });

  it('shows the stored look and draws a preview per choice', async () => {
    await xmrSettingsItem.setValue({ ...(await xmrSettingsItem.getValue()), badgeIcon: 'color', badgeLabel: false });
    await mountBadgeLook($('#t'));
    expect($<HTMLInputElement>('input[value="color"]').checked).toBe(true);
    expect($<HTMLInputElement>('[data-look="label"]').checked).toBe(false);
    expect(document.querySelectorAll('[data-preview] > span').length).toBe(3);
  });

  it('clicking a preview selects its radio and saves only the icon', async () => {
    await mountBadgeLook($('#t'));
    $<HTMLElement>('[data-preview="color"]').click();
    expect($<HTMLInputElement>('input[value="color"]').checked).toBe(true);
    await vi.waitFor(async () => expect(await xmrSettingsItem.getValue()).toMatchObject({ badgeIcon: 'color', badgeLabel: true, badgesX: true }));
  });

  it('text only forces the label on and disables its switch', async () => {
    await mountBadgeLook($('#t'));
    $<HTMLInputElement>('[data-look="label"]').click();
    await vi.waitFor(async () => expect((await xmrSettingsItem.getValue()).badgeLabel).toBe(false));
    $<HTMLElement>('[data-preview="none"]').click();
    await vi.waitFor(() => expect($<HTMLInputElement>('[data-look="label"]').disabled).toBe(true));
    expect($<HTMLInputElement>('[data-look="label"]').checked).toBe(true);
  });
});
