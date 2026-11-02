#!/usr/bin/env bash
# Copyright 2026, DiamondForge
# SPDX-License-Identifier: Apache-2.0
#
# Checks that a folder holds every file of a MoltenTerm release, then writes SHA256SUMS.txt in it. Run by
# .github/workflows/release.yml on a release and on a rehearsal, so the two always expect the same files.
#
# usage: scripts/moltenterm-release-files.sh <folder>
set -euo pipefail

dir="${1:?usage: moltenterm-release-files.sh <folder>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
node "$root/scripts/release-inventory.mjs" "$dir"
cat "$dir/SHA256SUMS.txt"
