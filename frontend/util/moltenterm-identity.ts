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

// The MoltenTerm symbol as one filled shape, the path of build/moltenterm/brand/svg/mark.svg without its 16,16 margin,
// for drawings that paint it themselves (a gradient fill); app/asset/logo.svg carries the same path in flat orange.
export const MoltentermMarkViewBox = "0 0 298 235";
export const MoltentermMarkPath =
    "M6 2 Q0 -2 0 5 L0 58 Q0 62 4 65 L71 116 L4 169 Q0 172 0 177 L0 228 Q0 235 6 230 L69 183 C86 171 105 177 122 190 " +
    "L149 211 C158 219 166 224 179 224 L271 224 C286 224 298 212 298 197 C298 182 286 170 271 170 L161 170 C133 170 117 " +
    "169 114 160 C110 150 120 142 128 135 C140 124 140 112 125 100 Z";

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
