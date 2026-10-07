// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

// The agent companion (FR-SHELL-018, DS-SHELL-019): wavesrv follows the transcript of the agent running in a
// terminal (pkg/molten/companion) and the companion view shows it. These names are shared with wsh, whose
// `molten agent session` reports a session's transcript from the agent's hook.

// must match frontend/moltenterm-shell/companion/companion-model.ts
const (
	CompanionRoute          = "molten:companion"
	CompanionEvent          = "molten:companion"
	CompanionOpenCommand    = "moltencompanionopen"
	CompanionCloseCommand   = "moltencompanionclose"
	CompanionPickCommand    = "moltencompanionpick"
	CompanionAnswerCommand  = "moltencompanionanswer"
	CompanionDiffCommand    = "moltencompaniondiff"
	CompanionSessionCommand = "moltencompanionsession"
	CompanionUsageCommand   = "moltencompanionusage"
	// Show or hide plan usage for the agent of a block (FR-SHELL-027).
	CompanionUsageGaugesCommand = "moltencompanionusagegauges"
	// Turn the agent's experimental usage source on (after its confirmation) or off (FR-SHELL-028).
	CompanionUsageExperimentalCommand = "moltencompanionusageexperimental"
	// The plan gauges of a block, when its status line relay brings new windows.
	CompanionUsageEvent = "molten:companionusage"
	// What `molten agent statusline` sends: the rate limit windows of Claude Code's status line input.
	AgentStatusLineCommand = "moltenagentstatusline"
)

// SubagentSessionError is the error of a session reported by id that is a sub-agent's: `molten agent notify` then
// reports no turn end either, since the pane's own agent is still at work.
const SubagentSessionError = "this session is a sub-agent's"

// AgentSessionRequest is what `molten agent session` reports: the transcript of the agent's session in a block.
// SessionId, when Path is empty: the agent's session id, which its companion adapter resolves to the transcript
// (Codex's notify payload carries the thread id, not the rollout's path: `molten agent notify`).
type AgentSessionRequest struct {
	BlockId   string `json:"blockid"`
	Agent     string `json:"agent,omitempty"`
	Path      string `json:"path"`
	SessionId string `json:"sessionid,omitempty"`
}
