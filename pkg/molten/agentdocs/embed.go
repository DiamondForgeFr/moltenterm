// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package agentdocs holds the documentation coding agents read to build mods (DS-MORPH-006): the mod format, the
// molten-feature guide, and complete example mods. It is embedded in wsh, so `molten` always gives the documentation
// of its own version, offline.
package agentdocs

import "embed"

// The copy box example must stay identical to frontend/molten/builtin/copy-box/ (checked by pkg/molten tests).
//
//go:embed mod-format.md molten-feature.md examples
var Files embed.FS

const GuideFile = "molten-feature.md"
