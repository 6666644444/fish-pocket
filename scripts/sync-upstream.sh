#!/usr/bin/env bash
# Bring upstream Fish Pocket (imsai-sh/fish-pocket) into this fork's branch, by merge.
#
#   scripts/sync-upstream.sh           merge upstream/main into the current branch, then test
#   scripts/sync-upstream.sh --check   try the merge, test, and undo it (CI's weekly check)
#
# Never rebases, never pushes, never force-anything. A conflicted merge is left in place for
# you to resolve (or `git merge --abort`); the files that conflict most often are the
# upstream files this fork changed, listed in DECISIONS.md ("改过的上游文件").
# After the merge: the learning plugin's tests and the English translation coverage.
# Environment: UPSTREAM_URL, UPSTREAM_BRANCH (default main), SKIP_TESTS=1.
set -euo pipefail

UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/imsai-sh/fish-pocket.git}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"
check=false
case "${1:-}" in
  --check) check=true ;;
  "") ;;
  *) echo "usage: $0 [--check]" >&2; exit 2 ;;
esac

root="$(git rev-parse --show-toplevel)"
cd "$root"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "the working tree has uncommitted changes; commit or stash them first" >&2
  exit 1
fi
if [ -e "$(git rev-parse --git-path MERGE_HEAD)" ]; then
  echo "a merge is already in progress; finish it or run git merge --abort" >&2
  exit 1
fi

if git remote get-url upstream >/dev/null 2>&1; then
  current="$(git remote get-url upstream)"
  [ "$current" = "$UPSTREAM_URL" ] || echo "note: remote upstream is $current (UPSTREAM_URL is $UPSTREAM_URL); using the remote"
else
  git remote add upstream "$UPSTREAM_URL"
fi

# A shallow clone has no merge base with upstream: get the whole history first.
if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
  echo "== deepening the shallow clone"
  git fetch --unshallow origin
fi
echo "== fetching upstream/$UPSTREAM_BRANCH"
git fetch --no-tags upstream "$UPSTREAM_BRANCH"
target="upstream/$UPSTREAM_BRANCH"

base="$(git merge-base HEAD "$target" || true)"
if [ -z "$base" ]; then
  echo "no common history with $target" >&2
  exit 1
fi
ahead="$(git rev-list --count "HEAD..$target")"
echo "== $target has $ahead commit(s) not in $(git rev-parse --abbrev-ref HEAD) (merge base ${base:0:10})"
if [ "$ahead" = "0" ]; then
  echo "already up to date"
  exit 0
fi
git log --oneline --no-decorate "HEAD..$target" | head -50

undo() { $check && git merge --abort >/dev/null 2>&1 || true; }

echo "== merging"
if $check; then
  merged=0; git merge --no-ff --no-commit "$target" || merged=$?
else
  merged=0; git merge --no-ff -m "Merge $target into $(git rev-parse --abbrev-ref HEAD)" "$target" || merged=$?
fi
if [ "$merged" != "0" ]; then
  echo "== the merge has conflicts in:" >&2
  git diff --name-only --diff-filter=U | sed 's/^/  /' >&2
  if $check; then
    undo
  else
    echo "resolve them, run this script's tests by hand (see below), then git commit; or git merge --abort" >&2
  fi
  exit 1
fi

status=0
if [ "${SKIP_TESTS:-}" != "1" ]; then
  echo "== learning tests"
  (cd engine && npm ci --ignore-scripts --no-audit --no-fund >/dev/null && node --test --test-reporter=dot test/learning-*.test.mjs) || status=1
  echo "== translation coverage (English must be complete)"
  node scripts/strings-coverage.mjs || true
  node scripts/strings-coverage.mjs en >/dev/null || { echo "English translations are missing; run: node scripts/strings-coverage.mjs en" >&2; status=1; }
fi

if $check; then
  undo
  [ "$status" = "0" ] && echo "== check passed: $target merges cleanly and the tests pass (nothing was committed)"
  exit "$status"
fi
if [ "$status" != "0" ]; then
  echo "== merged, but checks failed. Fix them, or undo with: git reset --hard ORIG_HEAD" >&2
  exit "$status"
fi
echo "== merged and tested. Look it over, then push yourself: git push origin $(git rev-parse --abbrev-ref HEAD)"
