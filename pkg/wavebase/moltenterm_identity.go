// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wavebase

// Moltenterm's identity on the Go side. Keep in sync with
// frontend/util/moltenterm-identity.ts (see UPSTREAM.md, "Identity and rename
// procedure").
const (
	// MoltentermDirName is the base name of Moltenterm's directories; dev builds append "-dev".
	MoltentermDirName = "moltenterm"
	// MoltentermRepoURL is the page shown by the starter web block.
	MoltentermRepoURL = "https://github.com/DiamondForgeFr/moltenterm"
	// MoltentermWaveBaseVersion is the Wave Terminal release Moltenterm is merged on ("Current base" in UPSTREAM.md);
	// a Wave merge updates it. The app's own number is package.json's version (FR-REL-001).
	MoltentermWaveBaseVersion = "0.14.5"
)
