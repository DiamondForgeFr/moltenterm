// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The Linux half of the in-app update of a release (#1860): the AppImage file that runs is replaced by the staged one
// once the app has quit, and put back when the new one does not stay open. It is the macOS swap (moltenterm-update.ts,
// #64) for a single file: there is no bundle signature to check, so the staged file's SHA-256 is checked once more
// right before the move against the one the signed checksum list gave, since the staging folder is one the user's
// processes can write. Plain sh, no Electron: it runs after the app has gone.

import type { PendingSwap } from "./moltenterm-update";

// Longer than the macOS swap's: an AppImage mounts or unpacks itself before it starts.
const SwapGraceSeconds = 30;

export const AppImageSwapScript = `#!/bin/sh
# Swaps the Moltenterm AppImage once the running app has quit (#1860). Arguments: pid staged installed reopen version
# status started sha256. started is the marker the reopened build writes once its backend runs (#1193); sha256 is the
# staged file's hash from the signed checksum list.
pid="$1"; staged="$2"; installed="$3"; reopen="$4"; version="$5"; status="$6"; started="$7"; expected="$8"
grace="\${MOLTENTERM_SWAP_GRACE:-${SwapGraceSeconds}}"
sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d ' ' -f 1
    else
        shasum -a 256 "$1" | cut -d ' ' -f 1
    fi
}
# Tests start the file directly so the reopened app keeps their isolated profile.
reopen_app() {
    if [ -n "$MOLTENTERM_SWAP_DIRECT" ]; then
        # shellcheck disable=SC2086
        ("$1" $MOLTENTERM_SWAP_ARGS >/dev/null 2>&1 &)
    else
        (nohup "$1" >/dev/null 2>&1 &)
    fi
}
i=0
while kill -0 "$pid" 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -gt 240 ]; then echo "failed: MoltenTerm did not quit" > "$status"; exit 1; fi
    sleep 0.5
done
if [ -z "$expected" ] || [ ! -f "$staged" ] || [ "$(sha256_of "$staged")" != "$expected" ]; then
    rm -f "$staged"
    echo "failed: the new build's checksum did not verify" > "$status"
    [ "$reopen" = 1 ] && reopen_app "$installed"
    exit 1
fi
chmod 755 "$staged"
aside="$installed.previous-$$"
if ! mv "$installed" "$aside"; then echo "failed: the installed app could not be moved aside" > "$status"; exit 1; fi
if ! mv "$staged" "$installed" || [ "$(sha256_of "$installed")" != "$expected" ]; then
    rm -f "$installed"
    mv "$aside" "$installed"
    echo "failed: the new build could not be put in place" > "$status"
    [ "$reopen" = 1 ] && reopen_app "$installed"
    exit 1
fi
if [ "$reopen" != 1 ]; then
    rm -f "$aside"
    echo "installed $version" > "$status"
    exit 0
fi
rm -f "$started"
reopen_app "$installed"
i=0
while [ "$i" -lt "$((grace * 2))" ]; do
    sleep 0.5
    i=$((i + 1))
done
# The new build stayed open when its start marker names a process that is still there, checked with a signal.
newpid=$(head -c 32 "$started" 2>/dev/null | tr -cd 0-9)
if [ -n "$newpid" ] && kill -0 "$newpid" 2>/dev/null; then
    rm -f "$aside"
    echo "installed $version" > "$status"
    exit 0
fi
mv "$installed" "$installed.did-not-stay-open-$$" && mv "$aside" "$installed"
rm -f "$installed.did-not-stay-open-$$"
echo "rolledback $version" > "$status"
reopen_app "$installed"
`;

// The first bytes of a type 2 AppImage: an ELF file with "AI" and the type in its identification padding (AppImage spec).
export function isAppImageHeader(head: Buffer): boolean {
    return (
        head.length >= 11 &&
        head[0] === 0x7f &&
        head.subarray(1, 4).toString("latin1") === "ELF" &&
        head.subarray(8, 10).toString("latin1") === "AI" &&
        head[10] === 0x02
    );
}

export function releaseAppImageSwap(p: {
    staged: string;
    installed: string;
    version: string;
    sha256: string;
}): PendingSwap {
    return {
        name: "swap-appimage.sh",
        script: AppImageSwapScript,
        label: p.version,
        args: (reopen, status, started) => [
            p.staged,
            p.installed,
            reopen ? "1" : "0",
            p.version,
            status,
            started,
            p.sha256,
        ],
    };
}
