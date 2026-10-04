// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Moltenterm's application identity. A rename starts here, in
// pkg/wavebase/moltenterm_identity.go, in package.json (name, productName,
// build.appId) and in build/moltenterm/ (see UPSTREAM.md, "Identity and
// rename procedure").

export const MoltentermProductName = "MoltenTerm";
export const MoltentermDevProductName = "MoltenTerm (Dev)";
export const MoltentermGoldProductName = "MoltenTerm Gold";

// The name the app shows (Dock, menu, About): a gold says it is the gold (#191), so it is told apart from a dev build.
export function moltentermProductNameFor(channel: string, isDev: boolean): string {
    if (isDev) {
        return MoltentermDevProductName;
    }
    return channel === "gold" ? MoltentermGoldProductName : MoltentermProductName;
}
export const MoltentermWindowTitle = "MoltenTerm";
export const MoltentermTagline = "The terminal that takes your shape.";
export const MoltentermRepoUrl = "https://github.com/DiamondForgeFr/moltenterm";

// The Wave Terminal release Moltenterm is merged on ("Current base" in UPSTREAM.md); a Wave merge updates it, here and
// in pkg/wavebase/moltenterm_identity.go. The app's own number is package.json's version (FR-REL-001).
export const MoltentermWaveBaseVersion = "0.14.5";

// Base name of the configuration and data directories; dev builds append "-dev".
export const MoltentermDirName = "moltenterm";

// Directory overrides read from the user's environment. Wave's WAVETERM_*
// variables are only used to hand the resolved directories to wavesrv.
export const MoltentermConfigHomeVarName = "MOLTENTERM_CONFIG_HOME";
export const MoltentermDataHomeVarName = "MOLTENTERM_DATA_HOME";
export const MoltentermHomeVarName = "MOLTENTERM_HOME";
