import { describe, expect, it, vi } from 'vitest';
import { buildAndroidSiteCatalogPayload, hasAndroidNativeCatalogBridge, syncAndroidSiteCatalog } from '../src/sites/android-catalog';
import type { SiteFeed } from '../src/sites/feed';
import type { LogoPack } from '../src/sites/logos';

const SAMPLE_LOGO = 'data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=';

function sampleFeed(): SiteFeed {
  return {
    reader: 8,
    issuedAt: 1_760_000_000,
    expiresAt: 1_760_999_999,
    sites: [
      {
        id: 'trocador',
        name: 'Trocador',
        category: 'swap-aggregator',
        grade: 'A',
        incident: false,
        url: 'https://xmr.club/trocador',
        hosts: ['WWW.Trocador.app.', 'trocador.app', 'github.com'],
        nkip01: { level: 3, logOnly: false, checkedAt: 1, lastOkAt: 1, l3VerifiedAt: 1 },
        orderUrl: 'https://trocador.app/order/{order}',
        log: { format: 'nkip01' },
        phishingHosts: ['trocador-fake.com'],
      },
      {
        id: 'newswap',
        name: 'NewSwap',
        category: 'swap',
        grade: '',
        incident: false,
        url: 'https://xmr.club/newswap',
        hosts: ['newswap.io'],
        intern: { day: 3, daysRequired: 14, track: 'funds' },
      },
      {
        id: 'fixedfloat',
        name: 'FixedFloat',
        category: 'swap',
        grade: 'C',
        incident: true,
        incidentDetail: {
          date: '2026-06-08',
          severity: 'medium',
          summary: 'Suspends funds for verification. Extra context here.',
          sourceUrl: 'https://x.com/FixedFloat',
        },
        url: 'https://xmr.club/exchanges/fixedfloat',
        hosts: ['ff.io', 'fixedfloat.com'],
      },
      {
        id: 'platform-only',
        name: 'GitHub Listing',
        category: 'tool',
        grade: 'A',
        incident: false,
        url: 'https://xmr.club/gh',
        hosts: ['github.com', 'x.com'],
      },
    ],
  };
}

function sampleLogoPack(): LogoPack {
  const logos = Object.assign(Object.create(null) as Record<string, string>, { trocador: SAMPLE_LOGO });
  const hosts = Object.assign(Object.create(null) as Record<string, string>, { 'trocador.app': 'trocador' });
  return { sha256: 'abc', logos, hosts };
}

describe('android-catalog', () => {
  it('builds a clean payload stripping platform hosts, orderUrl, phishingHosts, and attaching verified logos', () => {
    const payload = buildAndroidSiteCatalogPayload(sampleFeed(), sampleLogoPack());
    expect(payload.type).toBe('sync_site_catalog');
    expect(payload.issuedAt).toBe(1_760_000_000);
    expect(payload.sites).toHaveLength(3);

    const trocador = payload.sites[0]!;
    expect(trocador).toEqual({
      id: 'trocador',
      name: 'Trocador',
      category: 'swap-aggregator',
      grade: 'A',
      url: 'https://xmr.club/trocador',
      incident: false,
      intern: false,
      internHoldsFunds: false,
      hosts: ['trocador.app'],
      nkip01Level: 3,
      logOnly: false,
      hasLog: true,
      logo: SAMPLE_LOGO,
    });
    expect('orderUrl' in trocador).toBe(false);
    expect('phishingHosts' in trocador).toBe(false);

    const newswap = payload.sites[1]!;
    expect(newswap.intern).toBe(true);
    expect(newswap.internHoldsFunds).toBe(true);
    expect(newswap.internDay).toBe(3);
    expect(newswap.internDaysRequired).toBe(14);
    expect(newswap.logo).toBeUndefined();

    const ff = payload.sites[2]!;
    expect(ff.incident).toBe(true);
    expect(ff.incidentWhen).toBe('medium, 2026-06-08');
    expect(ff.incidentSummary).toBe('Suspends funds for verification.');
    expect(ff.url).toBe('https://xmr.club/exchanges/fixedfloat');
    expect(ff.hosts).toEqual(['ff.io', 'fixedfloat.com']);
  });

  it('emits an empty clearing payload when feed is null (site info disabled)', () => {
    expect(buildAndroidSiteCatalogPayload(null, null)).toEqual({
      type: 'sync_site_catalog',
      issuedAt: 0,
      sites: [],
    });
  });

  it('skips native messaging when permission is absent or platform is desktop', async () => {
    const sendNativeMessage = vi.fn().mockResolvedValue('{"ok":true}');
    expect(
      hasAndroidNativeCatalogBridge({
        sendNativeMessage,
        getManifest: () => ({ permissions: ['storage'] }),
      }),
    ).toBe(false);

    const desktopOk = await syncAndroidSiteCatalog(
      {
        sendNativeMessage,
        getManifest: () => ({ permissions: ['storage', 'nativeMessaging'] }),
        getPlatformInfo: async () => ({ os: 'mac' }),
      },
      sampleFeed(),
      sampleLogoPack(),
    );
    expect(desktopOk).toBe(false);
    expect(sendNativeMessage).not.toHaveBeenCalled();
  });

  it('sends the verified catalog payload on standalone Android APK', async () => {
    const sendNativeMessage = vi.fn().mockResolvedValue('{"ok":true}');
    const ok = await syncAndroidSiteCatalog(
      {
        sendNativeMessage,
        getManifest: () => ({ permissions: ['storage', 'geckoViewAddons', 'nativeMessaging'] }),
        getPlatformInfo: async () => ({ os: 'android' }),
      },
      sampleFeed(),
      sampleLogoPack(),
    );
    expect(ok).toBe(true);
    expect(sendNativeMessage).toHaveBeenCalledTimes(1);
    expect(sendNativeMessage).toHaveBeenCalledWith(
      'xmradar_android',
      expect.objectContaining({ type: 'sync_site_catalog', issuedAt: 1_760_000_000 }),
    );
  });
});
