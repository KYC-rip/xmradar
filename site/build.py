#!/usr/bin/env python3
"""Build the xmradar.app landing page into a folder ready for Cloudflare Pages.

Fills the download links and the "verifiable builds" box from a GitHub release (the latest one by
default), so the page always names a release that exists.

    python3 -I site/build.py [--tag vX.Y.Z] [--out site-dist]
    npx wrangler pages deploy site-dist --project-name xmradar-app --branch main
"""
import argparse
import html
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

REPO = 'KYC-rip/xmradar'
SITE = Path(__file__).resolve().parent
ASSETS = ['style.css', 'app.js', 'logo', 'fonts', 'shots', 'signer.html']

# no third-party requests: fonts and scripts are served from this site
HEADERS = """/*
  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  Permissions-Policy: interest-cohort=(), browsing-topics=()
/signer
  Content-Security-Policy: default-src 'none'; style-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
/signer.html
  Content-Security-Policy: default-src 'none'; style-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
"""




def gh(*args: str) -> str:
    try:
        return subprocess.run(['gh', *args], check=True, capture_output=True, text=True, timeout=60).stdout
    except subprocess.CalledProcessError as e:
        sys.exit(f'gh {" ".join(args[:2])} failed: {e.stderr.strip()}')
    except (OSError, subprocess.TimeoutExpired) as e:
        sys.exit(f'gh {" ".join(args[:2])} failed: {e}')


def need(value: str, pattern: str, what: str) -> str:
    if not re.fullmatch(pattern, value):
        sys.exit(f'unexpected {what}: {value!r}')
    return value


def safe_out(out: Path) -> Path:
    """The output folder: never this site's sources, a folder above them, or the current folder."""
    o = out.resolve()
    if o == Path.cwd().resolve() or o == SITE or o in SITE.parents or SITE in o.parents:
        sys.exit(f'refusing to build into {out}')
    # a folder it built has its _headers file; nothing else is ever deleted
    built = (o / '_headers').is_file() and (o / '_headers').read_text() == HEADERS
    if o.exists() and not built:
        sys.exit(f'{out} exists and was not built by this script; remove it yourself or pick another --out')
    return o


def release(tag: str | None) -> dict:
    fields = 'tagName,url,assets'
    if tag:
        return json.loads(gh('release', 'view', tag, '-R', REPO, '--json', fields))
    return json.loads(gh('release', 'view', '-R', REPO, '--json', fields))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--tag')
    ap.add_argument('--out', default='site-dist')
    a = ap.parse_args()

    out = safe_out(Path(a.out))
    r = release(a.tag)
    tag = need(r['tagName'], r'v\d+\.\d+\.\d+', 'tag')
    names = [x['name'] for x in r['assets']]
    version = need(next((n for n in names if n.endswith('-chrome.zip')), '').removeprefix('xmradar-').removesuffix('-chrome.zip'), r'\d+\.\d+\.\d+\.\d+', 'Chrome zip version')
    chrome, firefox = f'xmradar-{version}-chrome.zip', f'xmradar-{version}-firefox.zip'
    if firefox not in names:
        sys.exit(f'{tag} has no {firefox}')
    sums = {}
    for line in gh('release', 'download', tag, '-R', REPO, '-p', 'SHA256SUMS', '-O', '-').splitlines():
        if m := re.fullmatch(r'([0-9a-f]{64})\s+\*?(\S+)', line.strip()):
            sums[m[2]] = m[1]
    if chrome not in sums:
        sys.exit(f'SHA256SUMS of {tag} has no {chrome}')
    commit = need(gh('api', f'repos/{REPO}/commits/{tag}', '--jq', '.sha').strip(), r'[0-9a-f]{40}', 'commit')

    dl = f'https://github.com/{REPO}/releases/download/{tag}'
    values = {
        'VERSION': version,
        'RELEASE_URL': r['url'],
        'CHROME_URL': f'{dl}/{chrome}',
        'FIREFOX_URL': f'{dl}/{firefox}',
        'CHROME_ZIP': chrome,
        'COMMIT': commit,
        'COMMIT_SHORT': commit[:7],
        'SHA_CHROME': sums[chrome],
        'SHA_CHROME_SHORT': f'{sums[chrome][:4]}…{sums[chrome][-4:]}',
    }

    page = (SITE / 'index.html').read_text()
    for k, v in values.items():
        page = page.replace('{{' + k + '}}', html.escape(v))
    if '{{' in page:
        sys.exit('unfilled placeholder in index.html')

    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    (out / 'index.html').write_text(page)
    (out / '_headers').write_text(HEADERS)
    for name in ASSETS:
        src = SITE / name
        (shutil.copytree if src.is_dir() else shutil.copy2)(src, out / name)
    print(f'{a.out}: {version} ({commit[:7]})')


if __name__ == '__main__':
    main()
