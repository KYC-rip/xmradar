import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const read = (f: string) => readFileSync(join(process.cwd(), 'site', f), 'utf8');
const page = read('index.html');
const body = page.slice(page.indexOf('<body>') + 6, page.indexOf('<script src="app.js">'));

describe('xmradar.app', () => {
  it('loads nothing from another host: scripts, styles, fonts and images are its own', () => {
    for (const m of page.matchAll(/<(script|link|img|source)\b[^>]*\b(?:src|href)="([^"]+)"/g)) expect(m[2], m[0]).not.toMatch(/^(https?:)?\/\//);
    expect(read('style.css')).not.toMatch(/url\((['"]?)(https?:)?\/\//);
    expect(read('build.py')).toContain("default-src 'none'");
    expect(read('build.py')).toContain('Referrer-Policy: no-referrer');
  });

  it('claims only what README.md says XMRadar does', () => {
    expect(page).not.toMatch(/on X and Nostr|author's key|always produces|look-alike|[Bb]locks? /);
  });

  it('without its script, only the first slide shows', () => {
    expect(page).toMatch(/id="slide-safety"[^>]*aria-hidden="true"[^>]*inert/);
  });

  describe('the carousel', () => {
    afterEach(() => {
      vi.useRealTimers();
      document.body.innerHTML = '';
    });
    const start = () => {
      vi.useFakeTimers();
      document.body.innerHTML = body;
      new Function(read('app.js'))();
      const q = (s: string) => document.querySelector<HTMLElement>(s)!;
      return { q, tabs: [...document.querySelectorAll<HTMLElement>('[role="tab"]')] };
    };

    it('moves on every 6 s until paused; arrow keys move between tabs', () => {
      const { q, tabs } = start();
      expect(q('#slide-safety').getAttribute('aria-hidden')).toBe('true');
      vi.advanceTimersByTime(6000);
      expect(q('#slide-safety').getAttribute('aria-hidden')).toBe('false');
      expect(q('#slide-tips').hasAttribute('inert')).toBe(true);
      const pause = q('.pause');
      expect(pause.hidden).toBe(false);
      pause.click();
      expect(pause.getAttribute('aria-pressed')).toBe('true');
      vi.advanceTimersByTime(12_000);
      expect(q('#slide-safety').getAttribute('aria-hidden')).toBe('false');
      tabs[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
      expect(tabs[0]!.tabIndex).toBe(0);
      expect(tabs[1]!.tabIndex).toBe(-1);
    });
  });
});
