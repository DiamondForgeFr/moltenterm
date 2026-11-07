// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// wavesrv runs the Node.js scripts of an app build (Tailwind CSS for tsunami apps) with the app's Electron binary and
// ELECTRON_RUN_AS_NODE=1. A packaged app has its runAsNode fuse off (#1975, FR-BRW-014): that binary would start the
// app again instead of the script, so wavesrv gets none and uses the Node.js on the PATH (pkg/wavebase/moltenterm_noderunner.go).
// A dev run keeps its Electron binary, whose fuses are Electron's defaults.
export function electronBinaryToRunAsNode(execPath: string, isPackaged: boolean): string {
    return isPackaged ? "" : execPath;
}
