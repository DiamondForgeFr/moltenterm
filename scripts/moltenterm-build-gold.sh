#!/bin/sh
# Copyright 2026, DiamondForge
# SPDX-License-Identifier: Apache-2.0
#
# Builds a Moltenterm gold from the current commit and delivers it where the installed gold looks for updates (#64):
# ~/Library/Application Support/Moltenterm Local Builds/gold/ (MOLTENTERM_GOLD_DIR overrides it). macOS only.
#
# usage: scripts/moltenterm-build-gold.sh [--allow-dirty]
set -e
cd "$(dirname "$0")/.."

if [ "$(uname)" != "Darwin" ]; then
    echo "the gold delivery is macOS only" >&2
    exit 1
fi
if [ "$1" != "--allow-dirty" ] && [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "the tree has uncommitted changes: commit them, or pass --allow-dirty" >&2
    exit 1
fi

BUILD_ID=$(date +%s)
ARCH=$(uname -m)
[ "$ARCH" = "x86_64" ] && ARCH=x64

echo "▶ phase: build"
task build:backend
MOLTENTERM_BUILD_CHANNEL=gold MOLTENTERM_BUILD_ID=$BUILD_ID npm run build:prod
# The gold has an icon of its own (scripts/moltenterm-gen-icons.mjs), so it is told apart from dev builds in the Dock.
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder -c electron-builder.config.cjs -c.buildVersion="$BUILD_ID" \
    -c.mac.icon=build/moltenterm/icon-gold.icns -p never --mac dir --"$ARCH"

APP_DIR=make/mac-$ARCH
[ "$ARCH" = "x64" ] && APP_DIR=make/mac

echo "▶ phase: deliver"
APP=$(ls -d "$APP_DIR"/*.app | head -1)
node scripts/moltenterm-gold-deliver.mjs --app "$APP" --build-id "$BUILD_ID"
