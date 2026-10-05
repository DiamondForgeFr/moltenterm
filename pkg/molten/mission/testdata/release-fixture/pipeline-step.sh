#!/usr/bin/env bash
# A Notulia-shaped release in miniature (#230), against a local origin: the steps of Notulia's
# scripts/pipeline-step.sh and release.sh, without GitHub. The cut is prepared and finalized in a release worktree
# beside the checkout, which is never touched.
#
#   pipeline-step.sh warm-cache
#   pipeline-step.sh promote                                 develop onto main, on origin
#   pipeline-step.sh prepare <version> --internal|--public   bump and notes in ../<repo>-release, nothing committed
#   pipeline-step.sh finalize <version> --internal|--public  commit, tag, push --atomic, on what was prepared
#   pipeline-step.sh sync-back [<tag>]                       the release commit back onto develop
#
# A file .fail-<step> in the checkout makes that step fail once, before it changes anything.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
RELEASE_WORKTREE="$(dirname "$ROOT")/$(basename "$ROOT")-release"

STEP="${1:-}"
if [[ $# -gt 0 ]]; then shift; fi

if [[ -f "$ROOT/.fail-$STEP" ]]; then
  rm -f "$ROOT/.fail-$STEP"
  echo "✗ $STEP failed, as asked by .fail-$STEP." >&2
  exit 1
fi

# Back to a clean state, created on <start> if it does not exist: what a failed step left must not fail the retry.
reset_worktree() {
  if [[ ! -e "$RELEASE_WORKTREE/.git" ]]; then git worktree add -q -f --detach "$RELEASE_WORKTREE" "$1"; fi
  cd "$RELEASE_WORKTREE"
  git cherry-pick --abort >/dev/null 2>&1 || true
  git reset -q --hard
  git clean -qfd
  git fetch --quiet --tags origin
}

cut_args() {
  if [[ $# -ne 2 || ! "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "usage: pipeline-step.sh $STEP <version> --internal|--public" >&2
    exit 2
  fi
  case "$2" in
    --internal | --public) ;;
    *) echo "usage: pipeline-step.sh $STEP <version> --internal|--public" >&2; exit 2 ;;
  esac
}

case "$STEP" in
  warm-cache)
    echo "Warming the release cache."
    ;;

  promote)
    git fetch --quiet origin
    # Forced: main's release commits came back to develop as cherry-picks, so develop holds them all (Notulia
    # replays develop onto main instead).
    git push --quiet --force origin origin/develop:refs/heads/main
    echo "✓ develop promoted onto main."
    ;;

  prepare)
    cut_args "$@"
    reset_worktree origin/main
    git checkout -q -B main origin/main
    if [[ "$2" == "--internal" ]]; then
      last="$(git tag -l "v$1-*" | sed "s/^v$1-//" | sort -n | tail -n 1)"
      VERSION="$1-$(( ${last:-0} + 1 ))"
    else
      VERSION="$1"
    fi
    if git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then
      echo "✗ Tag v$VERSION already exists: nothing was changed." >&2
      exit 1
    fi
    echo "$VERSION" >VERSION
    mkdir -p releases
    printf '# v%s\n\nWhat changed in this release.\n' "$VERSION" >"releases/v$VERSION.md"
    echo "✓ v$VERSION prepared: version bumped, notes written, nothing committed."
    ;;

  finalize)
    cut_args "$@"
    if [[ ! -d "$RELEASE_WORKTREE" ]]; then
      echo "✗ Nothing is prepared: $RELEASE_WORKTREE does not exist. Run prepare first." >&2
      exit 1
    fi
    cd "$RELEASE_WORKTREE"
    VERSION="$(cat VERSION)"
    if [[ "${VERSION%%-*}" != "$1" ]]; then
      echo "✗ The prepared tree reads $VERSION, not a release of $1." >&2
      exit 1
    fi
    if [[ ! -f "releases/v$VERSION.md" ]]; then
      echo "✗ releases/v$VERSION.md is missing: prepare the cut again." >&2
      exit 1
    fi
    git add VERSION releases
    git commit -q -m "chore(release): v$VERSION"
    git tag "v$VERSION"
    git push --quiet --atomic origin main "v$VERSION"
    echo "✓ v$VERSION tagged and pushed."
    ;;

  sync-back)
    git fetch --quiet --tags origin
    TAG="${1:-}"
    if [[ -z "$TAG" ]]; then
      # Read whole: a reader that stops early would break the pipe under pipefail.
      TAGS="$(git for-each-ref --sort=-creatordate --format='%(refname:short)' 'refs/tags/v*')"
      TAG="${TAGS%%$'\n'*}"
    fi
    reset_worktree origin/main
    git checkout -q -B "chore/sync-main-${TAG#v}" origin/develop
    git cherry-pick "$TAG" >/dev/null
    git push --quiet origin HEAD:refs/heads/develop
    echo "✓ $TAG carried back to develop."
    ;;

  *)
    echo "usage: pipeline-step.sh warm-cache|promote|prepare|finalize|sync-back" >&2
    exit 2
    ;;
esac
