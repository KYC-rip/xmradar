#!/usr/bin/env bash
# Builds the Chrome and Firefox zips plus the sources zip and SHA256SUMS.
# The same commit gives byte-identical zips on the same OS, Node and zip tool;
# CI (Ubuntu 24.04, Node from .nvmrc, Info-ZIP) is the canonical build.
# Usage: scripts/build-release.sh [outdir under dist/]   SOURCE_DATE_EPOCH defaults to the commit time.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=${1:-dist}
# it's deleted before the build, so it must stay inside dist/
case "$OUT" in *..* | */ | *//*) echo "outdir must be dist or a plain path under dist/" >&2; exit 1 ;; esac
case "$OUT" in dist | dist/*) ;; *) echo "outdir must be dist or under dist/" >&2; exit 1 ;; esac
export SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct)}
export TZ=UTC LC_ALL=C

# The sources zip is `git archive HEAD`, so the build must not use anything HEAD doesn't have.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "uncommitted changes; commit or stash them first" >&2
  exit 1
fi
# without --exclude-standard this lists ignored files too
extra=$(git ls-files --others -- src public)
if [ -n "$extra" ]; then
  printf 'files under src/ or public/ that are not committed:\n%s\n' "$extra" >&2
  exit 1
fi

want=$(cat .nvmrc)
have=$(node -p 'process.versions.node.split(".")[0]')
[ "$want" = "$have" ] || echo "warning: Node $have, .nvmrc says $want; hashes won't match CI" >&2
echo "node $(node -v); $(zip -v | sed -n 2p)"

VERSION=$(node -p "require('./package.json').version")${WXT_BUILD_NUMBER:+.$WXT_BUILD_NUMBER}
# touch -t works with both BSD and GNU touch, unlike -d @epoch
STAMP=$(node -p 'new Date(process.env.SOURCE_DATE_EPOCH * 1000).toISOString().replace(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d).*/, "$1$2$3$4$5.$6")')

rm -rf output "$OUT"
mkdir -p "$OUT"
pnpm wxt build
pnpm wxt build -b firefox

pack() { # dir zip
  (cd "$1" &&
    find . -exec touch -h -t "$STAMP" {} + &&
    find . -type f | sort | zip -X -D -q -9 "$2" -@)
}
pack output/chrome-mv3 "$PWD/$OUT/xmradar-$VERSION-chrome.zip"
pack output/firefox-mv3 "$PWD/$OUT/xmradar-$VERSION-firefox.zip"
# For Firefox review: exactly the tracked files at this commit.
git archive --format=zip --mtime="@$SOURCE_DATE_EPOCH" -o "$OUT/xmradar-$VERSION-sources.zip" HEAD

(cd "$OUT" && if command -v sha256sum >/dev/null; then sha256sum -- *.zip; else shasum -a 256 -- *.zip; fi) >"$OUT/SHA256SUMS"
cat "$OUT/SHA256SUMS"
