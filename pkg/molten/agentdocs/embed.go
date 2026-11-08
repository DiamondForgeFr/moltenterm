// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

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
// local-ci-rule.md is the rule "run the local CI through `molten ci run`", written once: the molten-pipeline guide
// includes it ({{LOCAL_CI_RULE}}), and the briefing a run appends for an agent (#180) takes it from here.
// sandbox-rule.md tells an agent what to do when its sandbox blocks the molten command (#989): the morph,
// molten-pipeline and molten-bug guides include it ({{SANDBOX_RULE}}).
// claude-code-parts.md and examples/test-band/ document the Claude Code part of a mod (FR-MORPH-010); `all:` keeps
// the part's `.claude-plugin/` folder, which embed would skip as hidden.
// language-pack.md is the first preconfigured morph: translate MoltenTerm or change its texts (FR-I18N-002).
// review.md is the guide a review session's agent gets as its system prompt (FR-REV-004, DS-REV-006).
// pr-signature.md tells agents how to sign their commits and pull requests (#847).
// pipeline-writing-guide.md is how the AI speaks in the pipeline setup, and the brief of the setup tab's agent (#1152).
// pipeline-setup-agent.md teaches the pipeline tab's agent the `molten pipeline setup` commands (FR-MC-045, #1163).
// materials.md tells agents to declare what they produce for the developer with `molten material add` (FR-MAT-001).
// files.md tells agents to show what they searched for in their tab's file panel with `molten files` (FR-FILE-002).
// pages.md tells agents to open the pages they show the developer in MoltenTerm's browser, not the system's (#1812).
// bookmarks.md tells agents to read the project's web page bookmarks with `molten bookmarks list` (FR-BRW-020).
// learning.md tells agents to read what a guided workflow learned of the developer and to record their adjustments
// with `molten learn` (FR-LRN-002).
// morph-design.md teaches the agent that /morph runs the `molten morph design` commands that keep the mod design view's
// panel in step with the conversation (FR-MORPH-019).
// agent-decisions.md tells a lead to settle the stop of an agent whose question it decided, with `molten agent
// decision settle` (#1876, FR-REV-022 AC20).
//
//go:embed mod-format.md morph.md language-pack.md molten-pipeline.md molten-bug.md local-ci-rule.md sandbox-rule.md pipeline-format.md agent-states.md agent-integrations.md worktrees.md claude-code-parts.md review.md pr-signature.md pipeline-writing-guide.md pipeline-setup-agent.md materials.md files.md pages.md bookmarks.md learning.md morph-design.md agent-decisions.md all:examples
var Files embed.FS

const ReviewGuideFile = "review.md"

const PipelineWritingGuideFile = "pipeline-writing-guide.md"

const GuideFile = "morph.md"
const PipelineGuideFile = "molten-pipeline.md"
const BugGuideFile = "molten-bug.md"
const LocalCiRuleFile = "local-ci-rule.md"
const SandboxRuleFile = "sandbox-rule.md"
