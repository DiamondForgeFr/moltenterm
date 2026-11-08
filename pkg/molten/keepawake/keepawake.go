// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Package keepawake is MoltenTerm's own keep-awake (FR-SHELL-023, DS-SHELL-024, DS-SHELL-025, DS-SHELL-062). wavesrv
// holds one state: the configuration, the reasons MoltenTerm keeps the computer awake (Automatic while work runs, each
// workspace's Manual switch, which the code calls its coffee, and later the on-demand keep-awake of FR-SHELL-024), the
// block attempts the inhibitor shims report and the per-session overrides. Electron main holds the one system sleep
// blocker while any reason is active (emain/moltenterm-keepawake.ts); the windows show the coffees and the list.
// Nothing is kept across a restart: quitting or a crash ends every reason, and the blocker goes with the process.
package keepawake

import (
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

const (
	Route = "molten:keepawake"
	// Event carries the whole State on every change, to the windows and Electron main.
	Event = "molten:keepawake"

	StateCommand    = "keepawakestate"
	CoffeeCommand   = "keepawakecoffee"
	ShimCommand     = "keepawakeshim"
	OverrideCommand = "keepawakeoverride"
	StopCommand     = "keepawakestop"
)

// What a shim answers, and a session's own choice: PolicyAllow lets the tool run, PolicyLetSleep neutralises it.
// PolicyUntilWorkEnds is only an answer of the ask-once notification (it turns Automatic on).
const (
	PolicyAllow         = "allow"
	PolicyUntilWorkEnds = "untilworkends"
	PolicyLetSleep      = "letsleep"
)

// The values of the power:terminalrequests setting; RequestsAsk is the setting left unset.
const (
	RequestsAsk    = ""
	RequestsAlways = "always"
	RequestsNever  = "never"
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
	// DefaultGrace absorbs the short pauses between an agent's turns before Automatic ends (DS-SHELL-025); the setting
	// power:graceminutes changes it.
	DefaultGrace = 2 * time.Minute
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

// Coffee is a workspace's Manual switch (DS-SHELL-062, FR-SHELL-023 AC14): it keeps the computer awake until the user
// turns it off, whether or not work runs.
type Coffee struct {
	WorkspaceId   string `json:"workspaceid"`
	WorkspaceName string `json:"workspacename,omitempty"`
	// Since: when the user turned it on (Unix milliseconds).
	Since int64 `json:"since"`
	// Working: work runs in the workspace now.
	Working bool `json:"working"`
	// Reasons: what works in the workspace now, the most telling first ("Adrien: background work"), while Working.
	Reasons []string `json:"reasons,omitempty"`
	// ReasonsText: Reasons' codes for the windows, by position (#656).
	ReasonsText []*uimsg.Text `json:"reasonstext,omitempty"`
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
	// EndsAt: when the tool ends by itself (a bare caffeinate's -t timeout, Unix milliseconds); 0 when it does not say.
	EndsAt int64 `json:"endsat,omitempty"`
	// Stoppable: the process only keeps the computer awake (a bare caffeinate), so ending it stops nothing else. A
	// wrapped command (caffeinate make, systemd-inhibit ...) is the user's work and is never ended from the menu.
	Stoppable bool `json:"stoppable,omitempty"`
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
	Hold bool `json:"hold"`
	// Automatic: the Automatic mode is on (power:automatic); Requests is what a terminal's request gets
	// (power:terminalrequests, empty while it asks).
	Automatic bool   `json:"automatic"`
	Requests  string `json:"requests,omitempty"`
	// Automatic holds the blocker: work runs, or it is in its grace until AutomaticEndsAt.
	AutomaticHolding bool  `json:"automaticholding,omitempty"`
	AutomaticWorking bool  `json:"automaticworking,omitempty"`
	AutomaticEndsAt  int64 `json:"automaticendsat,omitempty"`
	// AutomaticReasons: what works on this computer now, while AutomaticWorking.
	AutomaticReasons []string `json:"automaticreasons,omitempty"`
	// AutomaticReasonsText: AutomaticReasons' codes for the windows, by position (#656).
	AutomaticReasonsText []*uimsg.Text `json:"automaticreasonstext,omitempty"`
	// Coffees (the Manual switches), oldest first.
	Coffees   []Coffee   `json:"coffees"`
	Attempts  []Attempt  `json:"attempts"`
	Overrides []Override `json:"overrides"`
	// The coffee approvals (FR-SHELL-063): the agent sessions each coffee covers, and the latest decisions, newest
	// first.
	AutoApprove []AutoApproveSession `json:"autoapprove"`
	Approvals   []Approval           `json:"approvals"`
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

// StopRequest ends the keep-awake processes a terminal let through (the menu's Stop on a terminal's row, #1780).
type StopRequest struct {
	BlockId string `json:"blockid"`
}

type OverrideRequest struct {
	BlockId string `json:"blockid"`
	// Policy: PolicyAllow or PolicyLetSleep; empty removes the override.
	Policy string `json:"policy,omitempty"`
}

// WorkRules are the kinds of work that count (power:workagents, power:workcommands, power:workprojects).
type WorkRules struct {
	Agents   bool
	Commands bool
	Projects bool
}

// Config is the keep-awake configuration the keeper reads at each evaluation (the power:* settings).
type Config struct {
	// Automatic: the Automatic mode (power:automatic).
	Automatic bool
	// Requests: what a terminal's request to stay awake gets: RequestsAsk, RequestsAlways or RequestsNever.
	Requests string
	// Grace: how long Automatic holds after the last work stopped.
	Grace time.Duration
	Work  WorkRules
}

// DefaultConfig is the configuration while nothing is set.
func DefaultConfig() Config {
	return Config{Grace: DefaultGrace, Work: WorkRules{Agents: true, Commands: true, Projects: true}}
}

// CleanRequests reads power:terminalrequests; anything unknown is the unset value, which asks.
func CleanRequests(value string) string {
	switch strings.TrimSpace(strings.ToLower(value)) {
	case RequestsAlways:
		return RequestsAlways
	case RequestsNever:
		return RequestsNever
	}
	return RequestsAsk
}

// graceChoices are the minutes power:graceminutes may take.
var graceChoices = map[int64]bool{1: true, 2: true, 5: true, 10: true, 15: true}

// ConfigFromSettings reads the power:* settings; a missing or invalid value reads as its default.
func ConfigFromSettings(s wconfig.SettingsType) Config {
	cfg := DefaultConfig()
	cfg.Automatic = s.PowerAutomatic
	cfg.Requests = CleanRequests(s.PowerTerminalRequests)
	if s.PowerGraceMinutes != nil && graceChoices[*s.PowerGraceMinutes] {
		cfg.Grace = time.Duration(*s.PowerGraceMinutes) * time.Minute
	}
	if s.PowerWorkAgents != nil {
		cfg.Work.Agents = *s.PowerWorkAgents
	}
	if s.PowerWorkCommands != nil {
		cfg.Work.Commands = *s.PowerWorkCommands
	}
	if s.PowerWorkProjects != nil {
		cfg.Work.Projects = *s.PowerWorkProjects
	}
	return cfg
}

// ValidOverride tells the per-session policies a session may take.
func ValidOverride(policy string) bool {
	return policy == PolicyAllow || policy == PolicyLetSleep
}

// ShimPolicy is what a shim does under the terminal requests setting: only Never keeps it from asserting; Always and
// the unset value (which asks once meanwhile) let the real tool run.
func ShimPolicy(requests string) string {
	if requests == RequestsNever {
		return PolicyLetSleep
	}
	return PolicyAllow
}

// IsShimTool tells the tools a shim stands in for.
func IsShimTool(tool string) bool {
	return tool == ToolCaffeinate || tool == ToolSystemdInhibit
}
