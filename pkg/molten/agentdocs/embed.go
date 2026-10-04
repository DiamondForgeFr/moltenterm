// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package agentdocs holds the documentation coding agents read to build mods (DS-MORPH-006): the mod format, the
// morph guide, and complete example mods; and to connect projects to Mission Control (FR-MC-008): the
// molten-pipeline guide and the pipeline format. It is embedded in wsh, so `molten` always gives the documentation
// of its own version, offline.
package agentdocs

import "embed"

// The copy box example must stay identical to frontend/molten/builtin/copy-box/ (checked by pkg/molten tests).
// agent-states.md tells how to wire an agent's hooks to `molten agent state` (FR-SHELL-011) and to
// `molten agent session` for the agent companion (FR-SHELL-018).
// worktrees.md tells how an agent links the worktree of its task to its terminal (FR-SHELL-016).
// molten-bug.md is the guide for reporting a MoltenTerm bug (FR-MORPH-011).
// claude-code-parts.md and examples/test-band/ document the Claude Code part of a mod (FR-MORPH-010); `all:` keeps
// the part's `.claude-plugin/` folder, which embed would skip as hidden.
//
//go:embed mod-format.md morph.md molten-pipeline.md molten-bug.md pipeline-format.md agent-states.md worktrees.md claude-code-parts.md all:examples
var Files embed.FS

const GuideFile = "morph.md"
const PipelineGuideFile = "molten-pipeline.md"
const BugGuideFile = "molten-bug.md"
