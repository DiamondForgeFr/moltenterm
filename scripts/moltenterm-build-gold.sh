#!/bin/sh
# Copyright 2026, DiamondForge
# SPDX-License-Identifier: Apache-2.0
#
# Builds a Moltenterm gold from the current commit and delivers it where the installed gold looks for updates (#64):
# ~/Library/Application Support/Moltenterm Local Builds/gold/ (MOLTENTERM_GOLD_DIR overrides it). macOS only.
#
# Signing (#224): with the "MoltenTerm Local" identity (MOLTENTERM_SIGNING_IDENTITY overrides the name), created once by
# scripts/moltenterm-local-signing-identity.sh. With it, macOS keeps the Files and Folders and Full Disk Access grants
# from one gold to the next; ad hoc, the fallback, it forgets them at every gold.
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
# codesign refuses an identity the system does not trust, so only a VALID one is used: the check never creates one, as
# creating it needs the developer's approval and the build may run detached.
SIGNING_IDENTITY=${MOLTENTERM_SIGNING_IDENTITY:-MoltenTerm Local}
if MOLTENTERM_SIGNING_IDENTITY="$SIGNING_IDENTITY" ./scripts/moltenterm-local-signing-identity.sh --check; then
    MAC_IDENTITY=$SIGNING_IDENTITY
    echo "signing: $SIGNING_IDENTITY"
else
    MAC_IDENTITY=-
    echo "⚠ warning: no valid code-signing identity \"$SIGNING_IDENTITY\": this gold is signed ad hoc, and macOS will" >&2
    echo "  forget the permissions given to the previous one. Run scripts/moltenterm-local-signing-identity.sh once." >&2
fi

task build:backend
# electron-builder ships all of dist/bin: wsh binaries left by builds of other versions must not ride along (#184).
VERSION=$(node version.cjs)
for f in dist/bin/wsh-*; do
    [ -e "$f" ] || continue
    case "$f" in
        dist/bin/wsh-"$VERSION"-*) ;;
        *) rm -f "$f" ;;
    esac
done
MOLTENTERM_BUILD_CHANNEL=gold MOLTENTERM_BUILD_ID=$BUILD_ID npm run build:prod
# The gold has an icon and a name of its own (scripts/moltenterm-gen-icons.mjs, #191), so it is told apart from dev
# builds in the Dock and in Spotlight.
# electron-builder signs every nested helper and framework before the app, with the entitlements of the config. A
# self-signed identity has no "Developer ID Application:" prefix; electron-builder still takes it as a non-Apple
# certificate when it is named.
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder -c electron-builder.config.cjs -c.buildVersion="$BUILD_ID" \
    -c.productName="MoltenTerm Gold" -c.mac.icon=build/moltenterm/icon-gold.icns -c.mac.identity="$MAC_IDENTITY" \
    -p never --mac dir --"$ARCH"

APP_DIR=make/mac-$ARCH
[ "$ARCH" = "x64" ] && APP_DIR=make/mac

echo "▶ phase: deliver"
APP=$(ls -d "$APP_DIR"/*.app | head -1)
codesign --verify --deep --strict "$APP"
codesign -d -r- "$APP" 2>&1 | grep "designated"
node scripts/moltenterm-gold-deliver.mjs --app "$APP" --build-id "$BUILD_ID"
# The delivered copy is the gold; the one electron-builder left would be found by Spotlight as another MoltenTerm.
rm -rf "$APP"
