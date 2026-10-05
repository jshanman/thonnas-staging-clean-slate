#!/usr/bin/env bash
# @intent Bump thonnas-package.json to the next SemVer -beta.N, commit, and tag (beta branch only)
set -euo pipefail
# @intent Bump the package in cwd when thonnas-package.json is here; else the script's package root
if [ ! -f thonnas-package.json ]; then
  cd "$(dirname "$0")/.."
fi

REF_NAME="${GITHUB_REF_NAME:-$(git branch --show-current 2>/dev/null || true)}"
if [ "$REF_NAME" != "beta" ]; then
  echo "Skipping version bump on ref '${REF_NAME:-detached}' (only runs on beta)."
  exit 0
fi

PREV="$(node -p "require('./thonnas-package.json').version")"
VER="$(node <<'EOF'
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('thonnas-package.json', 'utf8'));
const v = String(pkg.version || '0.1.0');
const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/);
if (!m) {
  console.error('Unsupported version for --beta bump:', v);
  process.exit(1);
}
let next;
if (m[4] !== undefined) {
  next = `${m[1]}.${m[2]}.${m[3]}-beta.${Number(m[4]) + 1}`;
} else {
  next = `${m[1]}.${Number(m[2]) + 1}.0-beta.0`;
}
pkg.version = next;
fs.writeFileSync('thonnas-package.json', `${JSON.stringify(pkg, null, 2)}\n`);
process.stdout.write(next);
EOF
)"
echo "version ${PREV} -> ${VER}"

if [ -z "${GITHUB_ACTIONS:-}" ]; then
  echo "Skipping git commit/tag/push outside GitHub Actions."
  exit 0
fi

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git checkout -B beta
git fetch origin --tags --force >/dev/null 2>&1 || true

TAGS_TO_PUSH=()
if [ -n "$PREV" ] && ! git rev-parse "refs/tags/${PREV}" >/dev/null 2>&1; then
  git tag -a "$PREV" -m "${PREV}"
  TAGS_TO_PUSH+=("$PREV")
fi

git add thonnas-package.json
if git diff --cached --quiet; then
  echo "thonnas-package.json unchanged; not creating a bump commit."
else
  git commit -m "chore: bump version to ${VER} [skip cicd]"
fi

if git rev-parse "refs/tags/${VER}" >/dev/null 2>&1; then
  echo "Tag ${VER} already exists locally."
else
  git tag -a "$VER" -m "${VER}"
  TAGS_TO_PUSH+=("$VER")
fi

# @intent Retry push when another package bumped beta in parallel
for attempt in 1 2 3 4 5; do
  if git push origin beta; then
    break
  fi
  if [ "$attempt" -eq 5 ]; then
    echo "git push origin beta failed after ${attempt} attempts" >&2
    exit 1
  fi
  echo "push rejected; rebase onto origin/beta (attempt ${attempt})"
  git fetch origin beta
  git rebase origin/beta
done
if [ "${#TAGS_TO_PUSH[@]}" -gt 0 ]; then
  git push origin "${TAGS_TO_PUSH[@]}"
fi

