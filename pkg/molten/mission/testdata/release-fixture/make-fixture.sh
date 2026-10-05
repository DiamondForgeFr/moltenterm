#!/usr/bin/env bash
# Makes a throwaway Notulia-shaped project for the release tests (#230): <base>/origin.git, a bare repository standing
# for GitHub, and <base>/fixture, its clone on develop, whose .molten/project.json is project-<variant>.json.
#
#   make-fixture.sh <base> <unphased|phased>
#
# Nothing leaves <base>: origin is a local path, so no tag or release can reach a real remote.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: make-fixture.sh <base> <unphased|phased>" >&2
  exit 2
fi
HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="$1"
VARIANT="$2"
if [[ ! -f "$HERE/project-$VARIANT.json" ]]; then
  echo "unknown variant: $VARIANT" >&2
  exit 2
fi
if [[ -e "$BASE/fixture" || -e "$BASE/origin.git" ]]; then
  echo "$BASE already holds a fixture" >&2
  exit 1
fi
mkdir -p "$BASE"
BASE="$(cd "$BASE" && pwd)"

git init -q --bare -b develop "$BASE/origin.git"
git init -q -b develop "$BASE/fixture"
cd "$BASE/fixture"
git config user.name "Release fixture"
git config user.email "fixture@example.invalid"
git config commit.gpgsign false
git config tag.gpgsign false
git remote add origin "$BASE/origin.git"
mkdir -p .molten scripts
cp "$HERE/project-$VARIANT.json" .molten/project.json
cp "$HERE/pipeline-step.sh" scripts/pipeline-step.sh
chmod +x scripts/pipeline-step.sh
echo "0.0.0" >VERSION
printf '.fail-*\n' >.gitignore
git add -A
git commit -q -m "feat: a first feature"
git push -q -u origin develop
git push -q origin develop:main
echo "$BASE/fixture"
