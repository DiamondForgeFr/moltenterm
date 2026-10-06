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
)

// AgentSessionRequest is what `molten agent session` reports: the transcript of the agent's session in a block.
type AgentSessionRequest struct {
	BlockId string `json:"blockid"`
	Agent   string `json:"agent,omitempty"`
	Path    string `json:"path"`
}
