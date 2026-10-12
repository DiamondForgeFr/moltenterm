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
cd "$dir"

# Every platform or none: a release missing one would be offered as complete.
missing=0
for pattern in "*.dmg:2" "*darwin*.zip:2" "*.AppImage:2" "*.deb:2" "latest-mac.yml:1" "latest-linux.yml:1" "latest-linux-arm64.yml:1"; do
    glob="${pattern%:*}"
    want="${pattern##*:}"
    found=0
    # shellcheck disable=SC2086
    for file in $glob; do
        if [ -e "$file" ]; then
            found=$((found + 1))
        fi
    done
    if [ "$found" -ne "$want" ]; then
        echo "::error::expected $want file(s) matching $glob, found $found"
        missing=1
    fi
done
if [ "$missing" -ne 0 ]; then
    ls -l
    exit 1
fi
sha256sum -- *.dmg *.zip *.AppImage *.deb > SHA256SUMS.txt
cat SHA256SUMS.txt
