// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package keepawake is MoltenTerm's own keep-awake and the sleep policy (FR-SHELL-023, DS-SHELL-024, DS-SHELL-025,
// DS-SHELL-062). wavesrv holds one state: the global policy, the reasons MoltenTerm keeps the computer awake (the
// Until work ends policy while work runs, each workspace's coffee, and later the on-demand keep-awake of FR-SHELL-024),
// the block attempts the inhibitor shims report and the per-session overrides. Electron main holds the one system
// sleep blocker while any reason is active (emain/moltenterm-keepawake.ts); the windows show the coffees and the list.
// Nothing is kept across a restart: quitting or a crash ends every reason, and the blocker goes with the process.
package keepawake

import (
	"strings"
	"time"
)

const (
	Route = "molten:keepawake"
	// Event carries the whole State on every change, to the windows and Electron main.
	Event = "molten:keepawake"

	StateCommand    = "keepawakestate"
	CoffeeCommand   = "keepawakecoffee"
	ShimCommand     = "keepawakeshim"
	OverrideCommand = "keepawakeoverride"
)

// The values of the power:sleeppolicy setting; PolicyAsk is the setting left unset.
const (
	PolicyAsk           = ""
	PolicyAllow         = "allow"
	PolicyUntilWorkEnds = "untilworkends"
	PolicyLetSleep      = "letsleep"
)

// What a shim did with a block attempt.
const (
	OutcomeAllowed     = "allowed"
	OutcomeNeutralised = "neutralised"
)

// The inhibitor tools the shims stand in for (DS-SHELL-024).
const (
	ToolCaffeinate     = "caffeinate"
	ToolSystemdInhibit = "systemd-inhibit"
)

const (
	// GracePeriod absorbs the short pauses between an agent's turns before a reason ends (DS-SHELL-025).
	GracePeriod = 2 * time.Minute
	// MaxAttempts caps the attempts kept in the state; the oldest go first.
	MaxAttempts = 50
)

// The ask-once notification's gesture (frontend/moltenterm-shell/keepawake-store.ts registers it): it writes the
// chosen policy.
const (
	PolicyGesture      = "molten:sleeppolicy"
	AskNotificationKey = "molten:sleeppolicy:ask"
	NotificationSource = "moltenterm"
	noticeKindInfo     = "info"
)

// Coffee is one workspace kept awake from its rail bud (DS-SHELL-062).
type Coffee struct {
	WorkspaceId   string `json:"workspaceid"`
	WorkspaceName string `json:"workspacename,omitempty"`
	// Since: when the user turned it on (Unix milliseconds).
	Since int64 `json:"since"`
	// Working: work runs in the workspace now; otherwise the coffee is in its grace and ends at EndsAt.
	Working bool  `json:"working"`
	EndsAt  int64 `json:"endsat,omitempty"`
}

// Attempt is one block attempt a shim reported, while its process lives.
type Attempt struct {
	Id            string   `json:"id"`
	BlockId       string   `json:"blockid"`
	WorkspaceId   string   `json:"workspaceid,omitempty"`
	WorkspaceName string   `json:"workspacename,omitempty"`
	TabName       string   `json:"tabname,omitempty"`
	Tool          string   `json:"tool"`
	Args          []string `json:"args,omitempty"`
	Pid           int32    `json:"pid"`
	ParentPid     int32    `json:"parentpid,omitempty"`
	ParentName    string   `json:"parentname,omitempty"`
	Since         int64    `json:"since"`
	Outcome       string   `json:"outcome"`
}

// Override is a session's own policy, set from the status bar list, for the terminal's lifetime.
type Override struct {
	BlockId       string `json:"blockid"`
	WorkspaceId   string `json:"workspaceid,omitempty"`
	WorkspaceName string `json:"workspacename,omitempty"`
	TabName       string `json:"tabname,omitempty"`
	Policy        string `json:"policy"`
}

// State is what the windows and Electron main read; Version only grows.
type State struct {
	Version int64 `json:"version"`
	// Hold: MoltenTerm keeps the system awake now (Electron main holds its blocker).
	Hold   bool   `json:"hold"`
	Policy string `json:"policy"`
	// The Until work ends policy holds the blocker: work runs, or it is in its grace until PolicyEndsAt.
	PolicyHolding bool  `json:"policyholding,omitempty"`
	PolicyWorking bool  `json:"policyworking,omitempty"`
	PolicyEndsAt  int64 `json:"policyendsat,omitempty"`
	// Coffees, oldest first.
	Coffees   []Coffee   `json:"coffees"`
	Attempts  []Attempt  `json:"attempts"`
	Overrides []Override `json:"overrides"`
}

// ShimRequest is what a shim reports before it decides (cmd/wsh/cmd/wshcmd-molten-sleepshim.go).
type ShimRequest struct {
	BlockId   string   `json:"blockid"`
	Tool      string   `json:"tool"`
	Args      []string `json:"args,omitempty"`
	Pid       int32    `json:"pid"`
	ParentPid int32    `json:"parentpid,omitempty"`
	// Deadline: when the shim stops waiting and runs the real tool (Unix milliseconds).
	Deadline int64 `json:"deadline,omitempty"`
}

// ShimAnswer: Policy is PolicyLetSleep when the shim must not assert, PolicyAllow otherwise.
type ShimAnswer struct {
	Policy string `json:"policy"`
}

type CoffeeRequest struct {
	WorkspaceId string `json:"workspaceid"`
	On          bool   `json:"on"`
}

type OverrideRequest struct {
	BlockId string `json:"blockid"`
	// Policy: PolicyAllow or PolicyLetSleep; empty removes the override.
	Policy string `json:"policy,omitempty"`
}

// CleanPolicy reads the setting's value; anything unknown is the unset policy, which asks.
func CleanPolicy(value string) string {
	switch strings.TrimSpace(strings.ToLower(value)) {
	case PolicyAllow:
		return PolicyAllow
	case PolicyUntilWorkEnds:
		return PolicyUntilWorkEnds
	case PolicyLetSleep:
		return PolicyLetSleep
	}
	return PolicyAsk
}

// ValidOverride tells the per-session policies a session may take.
func ValidOverride(policy string) bool {
	return policy == PolicyAllow || policy == PolicyLetSleep
}

// ShimPolicy is what a shim does under a policy: only Let it sleep keeps it from asserting; Allow, Until work ends and
// the unset policy (which asks once meanwhile) let the real tool run.
func ShimPolicy(policy string) string {
	if policy == PolicyLetSleep {
		return PolicyLetSleep
	}
	return PolicyAllow
}

// IsShimTool tells the tools a shim stands in for.
func IsShimTool(tool string) bool {
	return tool == ToolCaffeinate || tool == ToolSystemdInhibit
}
