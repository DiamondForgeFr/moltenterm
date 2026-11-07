// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The Electron fuses of a packaged build (#1975, FR-BRW-014). electron-builder flips them in the Electron binary right
// before it signs the app (`electronFuses` in electron-builder.config.cjs), and scripts/moltenterm-check-fuses.mjs reads
// them back from the packaged app: this file is the one place that says which are on and which are off.
//
// Dev runs (`task dev`, `task start`, the perf and accessibility scripts) use the binary in node_modules/electron, whose
// fuses stay at Electron's defaults: they keep `--inspect` and `ELECTRON_RUN_AS_NODE`. Only the packaged app is hardened.

const FuseWireOrder = [
    "runAsNode",
    "enableCookieEncryption",
    "enableNodeOptionsEnvironmentVariable",
    "enableNodeCliInspectArguments",
    "enableEmbeddedAsarIntegrityValidation",
    "onlyLoadAppFromAsar",
    "loadBrowserProcessSpecificV8Snapshot",
    "grantFileProtocolExtraPrivileges",
];

const ElectronFuses = {
    // A same-user process could otherwise run its own script under MoltenTerm's signature
    // (`ELECTRON_RUN_AS_NODE=1 MoltenTerm -e ...`), with the privacy grants and keychain access of the app.
    runAsNode: false,
    // NODE_OPTIONS (`--require`, `--inspect`...) and NODE_EXTRA_CA_CERTS are read by the main process otherwise.
    enableNodeOptionsEnvironmentVariable: false,
    // `--inspect`, `--inspect-brk`... and SIGUSR1 would open the main process to any local program otherwise.
    enableNodeCliInspectArguments: false,
    // The app code is app.asar, checked against the hash electron-builder writes into the app (macOS and Windows; Linux
    // ignores the fuse), and nothing else: an `app` folder beside it is never loaded.
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    // Still on: the app page is loaded with loadFile() (a file: URL inside app.asar, see emain/emain-tabview.ts) and its
    // module scripts, workers and fetches need what the fuse grants. It goes off when that page is served by a custom
    // protocol (FR-BRW-014).
    grantFileProtocolExtraPrivileges: true,
};

module.exports = { ElectronFuses, FuseWireOrder };
