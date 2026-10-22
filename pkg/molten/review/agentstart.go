// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"fmt"
	"strconv"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// Where an agent MoltenTerm starts for the developer goes (#758): nothing opens unasked, and what opens says why. The
// developer chooses in the window: the agent works out of sight (a hidden tab of the workspace, revealed only when the
// developer goes to it) or with them (its own tab, shown and focused by the window). Never the PR's Review tab: the
// review stays for later, on the reworked PR. The terminal carries its origin, which the window shows above it.

const (
	// AgentModeBackground: the agent works out of sight; AgentModeTogether: in a tab the window shows.
	AgentModeBackground = "background"
	AgentModeTogether   = "together"

	// AgentOriginKind…: what the agent was started for.
	AgentOriginRebase  = "rebase"
	AgentOriginRestart = "restart"
	// AgentOriginInvestigate: the agent reads a PR's failed checks and proposes what to do (#797).
	AgentOriginInvestigate = "investigate"
	// AgentOriginBatch: the batch merge's agent (FR-REV-025, batch_agent.go), for Count PRs into Base.
	AgentOriginBatch = "batch"
	// AgentOriginFinish: Check the agents (#954), the agent verifies the PR and finishes what is left.
	AgentOriginFinish = "finish"

	// OriginMetaKey: the AgentOrigin of a terminal MoltenTerm started; must match
	// frontend/moltenterm-shell/reviews/agent-origin.ts.
	OriginMetaKey = "molten:origin"
	// AgentTabMetaKey: the tab of such an agent, "owner/name#N".
	AgentTabMetaKey = "molten:agenttab"
)

// AgentOrigin is why a terminal is there, for the banner above it.
type AgentOrigin struct {
	Kind   string `json:"kind"`
	Repo   string `json:"repo"`
	Number int    `json:"number"`
	Branch string `json:"branch"`
	Base   string `json:"base,omitempty"`
	// MergedPr: the merge that put the PR in conflict (#691); Round: the review round handed over (Restart work).
	MergedPr int `json:"mergedpr,omitempty"`
	Round    int `json:"round,omitempty"`
	Count    int `json:"count,omitempty"`
	// Tag, Phase and Step: the failed release step an agent works on (#945).
	Tag   string `json:"tag,omitempty"`
	Phase string `json:"phase,omitempty"`
	Step  string `json:"step,omitempty"`
	Mode  string `json:"mode"`
	// At: when the developer asked, Unix milliseconds.
	At int64 `json:"at"`
}

func validMode(mode string) bool {
	return mode == AgentModeBackground || mode == AgentModeTogether
}

// defaultAgentTabName is the tab's name when the window sent none (its name in the interface language).
func defaultAgentTabName(kind string, number int) string {
	if kind == AgentOriginRestart {
		return "Restart #" + strconv.Itoa(number)
	}
	if kind == AgentOriginInvestigate {
		return "CI #" + strconv.Itoa(number)
	}
	if kind == AgentOriginFinish {
		return "Finish #" + strconv.Itoa(number)
	}
	return "Rebase #" + strconv.Itoa(number)
}

// agentTab makes the agent's tab in the developer's workspace: hidden in background mode.
func (r *Restarter) agentTab(ctx context.Context, req RestartRequest, origin AgentOrigin) (string, error) {
	if r.env.AgentTab == nil {
		return "", fmt.Errorf("MoltenTerm cannot open tabs yet")
	}
	name := req.TabName
	if name == "" {
		name = defaultAgentTabName(origin.Kind, origin.Number)
	}
	meta := waveobj.MetaMapType{AgentTabMetaKey: tabKey(req.Repo, req.Number)}
	return r.env.AgentTab(ctx, req.WorkspaceId, name, meta, req.Mode == AgentModeBackground)
}
