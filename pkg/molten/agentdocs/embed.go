// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package agentdocs holds the documentation coding agents read to build mods (DS-MORPH-006): the mod format, the
// molten-feature guide, and complete example mods; and to connect projects to Mission Control (FR-MC-008): the
// molten-pipeline guide and the pipeline format. It is embedded in wsh, so `molten` always gives the documentation
// of its own version, offline.
package agentdocs

import "embed"

// The copy box example must stay identical to frontend/molten/builtin/copy-box/ (checked by pkg/molten tests).
// agent-states.md tells how to wire an agent's hooks to `molten agent state` (FR-SHELL-011).
// worktrees.md tells how an agent links the worktree of its task to its terminal (FR-SHELL-016).
//
//go:embed mod-format.md molten-feature.md molten-pipeline.md pipeline-format.md agent-states.md worktrees.md examples
var Files embed.FS

const GuideFile = "molten-feature.md"
const PipelineGuideFile = "molten-pipeline.md"
