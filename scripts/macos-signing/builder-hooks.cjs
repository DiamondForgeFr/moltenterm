// Copyright 2026, MoltenTerm Authors
// SPDX-License-Identifier: Apache-2.0

// Deferred integration: importing this bridge never accesses a keychain or contacts Apple.
// Finalization (DMG notarization, update metadata) runs in package.mjs once the builder has exited, because the
// builder writes its *-mac.yml files after afterAllArtifactBuild returns.
let hooks;
const load = () => (hooks ??= import("./hooks.mjs").then(({ createHooks }) => createHooks()));
exports.sign = async (...args) => (await load()).sign(...args);
