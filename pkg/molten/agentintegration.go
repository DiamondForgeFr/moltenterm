// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"encoding/json"
	"path/filepath"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// Agent integration at launch (FR-SHELL-036, DS-SHELL-045 to 048, FR-SHELL-038): in a local MoltenTerm terminal,
// `claude` and `codex` run MoltenTerm's launcher (pkg/molten/agentlaunch), which adds the hooks and the status line
// relay of this package (Claude Code) or the notify wrapper (Codex) for that run only, through the agent's own
// per-run settings. Nothing of the user's is written (NFR-SHELL-019). The
// launcher tells the pane's agent states what it added (DS-SHELL-051); these names are shared with wsh.

const (
	// Sent by the launcher before it starts the agent, on the agent states route.
	AgentIntegrationReportCommand = "moltenagentintegrationreport"
	// Asked by `molten agent integration status`: the report of the agent running in a block.
	AgentIntegrationStatusCommand = "moltenagentintegrationstatus"

	// What the SessionStart hook of agent-states.md runs; a configuration that runs it links its sessions itself.
	agentSessionHookCommand = "molten agent session"
	// The SessionStart hook of agent-states.md, byte for byte: an identical handler in the user's settings runs once.
	ClaudeSessionHookCommand = `[ -n "$WAVETERM_BLOCKID" ] && molten agent session --agent claude --stdin || true`
	ClaudeSessionHookEvent   = "SessionStart"

	// What the PermissionRequest hook runs (FR-SHELL-063, DS-SHELL-110): it answers allow while the pane's workspace
	// has its coffee on, nothing otherwise. A configuration that runs it answers its prompts itself.
	agentPermissionHookCommand  = "molten agent permission"
	ClaudePermissionHookCommand = `[ -n "$WAVETERM_BLOCKID" ] && molten agent permission --agent claude || true`
	ClaudePermissionHookEvent   = "PermissionRequest"
	// Seconds: the command waits 5 s at most for wavesrv; Claude Code shows its prompt meanwhile.
	ClaudePermissionHookTimeout = 15
	// Codex's PermissionRequest hook (FR-SHELL-064, DS-SHELL-113), the same answer. Codex trusts a hook against the
	// hash of its definition, so this text and its timeout must not change from one run or version to the next: a
	// change asks the developer to trust it again in /hooks.
	CodexPermissionHookCommand = `[ -n "$WAVETERM_BLOCKID" ] && molten agent permission --agent codex || true`
	CodexPermissionHookTimeout = 15
)

// Kinds of what the launcher adds to a run.
const (
	IntegrationStateHooks = "statehooks"
	IntegrationSession    = "sessionlink"
	IntegrationStatusLine = "statusline"
	// The molten-browser MCP server (FR-SHELL-037): added, or skipped as the user's own.
	IntegrationBrowser = "browser"
	// Codex's notify, run through `molten agent notify` around the user's own (FR-SHELL-038).
	IntegrationNotify = "notify"
	// The PermissionRequest hook that answers the agent's prompts while a coffee holds (FR-SHELL-063).
	IntegrationCoffeeApproval = "coffeeapproval"
)

// IntegrationItem is one thing added to a run, or left out (Reason says why, in plain words). NameText and ReasonText
// are their codes for the companion (#656); the English is what `molten agent integration status` prints.
type IntegrationItem struct {
	Kind       string      `json:"kind"`
	Name       string      `json:"name"`
	NameText   *uimsg.Text `json:"nametext,omitempty"`
	Reason     string      `json:"reason,omitempty"`
	ReasonText *uimsg.Text `json:"reasontext,omitempty"`
}

// AgentIntegrationReport is what the launcher tells of one run. StepAside: nothing was added, and why.
type AgentIntegrationReport struct {
	BlockId   string `json:"blockid"`
	Agent     string `json:"agent"`
	RealPath  string `json:"realpath"`
	Pid       int    `json:"pid,omitempty"`
	Settings  string `json:"settings,omitempty"`
	McpConfig string `json:"mcpconfig,omitempty"`
	// Args: the arguments added before the user's when the run gets no file (Codex's -c overrides).
	Args      []string          `json:"args,omitempty"`
	Added     []IntegrationItem `json:"added,omitempty"`
	Skipped   []IntegrationItem `json:"skipped,omitempty"`
	StepAside string            `json:"stepaside,omitempty"`
	// StepAsideText: StepAside's code for the companion (#656).
	StepAsideText *uimsg.Text `json:"stepasidetext,omitempty"`
	// At, in Unix milliseconds: set by wavesrv when it receives the report.
	At int64 `json:"at,omitempty"`
}

// ReportsStates tells whether what was added reports the agent's states (Claude Code's hooks, Codex's notify
// wrapper): the hook setup offer then has nothing to bring. A run that only got the browser server still gets it.
func (r AgentIntegrationReport) ReportsStates() bool {
	if !r.Integrated() {
		return false
	}
	for _, it := range r.Added {
		if it.Kind == IntegrationStateHooks || it.Kind == IntegrationNotify {
			return true
		}
	}
	return false
}

// RelaysStatusLine tells whether the run got the status line relay, which gives the plan usage gauges their values:
// the companion then has no setup to show (FR-SHELL-040-AC6).
func (r AgentIntegrationReport) RelaysStatusLine() bool {
	if !r.Integrated() {
		return false
	}
	for _, it := range r.Added {
		if it.Kind == IntegrationStatusLine {
			return true
		}
	}
	return false
}

// Integrated tells whether anything was added to the run.
func (r AgentIntegrationReport) Integrated() bool {
	return r.StepAside == "" && len(r.Added) > 0
}

// What a running agent's integration is, for the share menu and the settings (#947): RunIntegration* says whether
// the run got MoltenTerm's integration, RunBrowser* whether it got the browser server.
const (
	AgentIntegrationRunsCommand = "moltenagentintegrationruns"

	RunIntegrationOn      = "on"
	RunIntegrationOff     = "off"
	RunIntegrationUnknown = "unknown"

	RunBrowserAdded   = "added"
	RunBrowserSkipped = "skipped"
	RunBrowserNone    = "none"
	RunBrowserUnknown = "unknown"
)

// AgentIntegrationRun is one running agent's integration. Must match frontend/moltenterm-shell/agent-integration-runs.ts.
type AgentIntegrationRun struct {
	BlockId     string `json:"blockid"`
	Agent       string `json:"agent"`
	Integration string `json:"integration"`
	Browser     string `json:"browser"`
	// BrowserReason: why the launcher left the browser server out (Browser skipped), in English and by its code.
	BrowserReason     string      `json:"browserreason,omitempty"`
	BrowserReasonText *uimsg.Text `json:"browserreasontext,omitempty"`
}

type AgentIntegrationRuns struct {
	Runs []AgentIntegrationRun `json:"runs"`
}

// RunOfReport is what a launcher's report tells of its run.
func RunOfReport(r AgentIntegrationReport) AgentIntegrationRun {
	rtn := AgentIntegrationRun{BlockId: r.BlockId, Agent: r.Agent, Integration: RunIntegrationOff, Browser: RunBrowserNone}
	if !r.Integrated() {
		return rtn
	}
	rtn.Integration = RunIntegrationOn
	for _, it := range r.Added {
		if it.Kind == IntegrationBrowser {
			rtn.Browser = RunBrowserAdded
			return rtn
		}
	}
	for _, it := range r.Skipped {
		if it.Kind == IntegrationBrowser {
			rtn.Browser = RunBrowserSkipped
			rtn.BrowserReason = it.Reason
			rtn.BrowserReasonText = it.ReasonText
		}
	}
	return rtn
}

type AgentIntegrationStatusRequest struct {
	BlockId string `json:"blockid"`
}

// AgentIntegrationStatus answers `molten agent integration status`: Found is false when no launcher reported for the
// agent that runs in the block now.
type AgentIntegrationStatus struct {
	Found  bool                    `json:"found"`
	Report *AgentIntegrationReport `json:"report,omitempty"`
}

// ClaudeHookEntry is one hook of the state hooks of agent-states.md.
type ClaudeHookEntry struct {
	Event string
	// Matcher: what the hook's group matches, "" for every occurrence (Notification: the types that wait, #784).
	Matcher string
	Command string
}

// ClaudeStateHooks lists the state hooks of agent-states.md (claudeHooksSnippet) in their order, with their exact
// command strings: the launcher adds the same handlers, which Claude Code runs once when the user pasted them too.
func ClaudeStateHooks() []ClaudeHookEntry {
	var parsed struct {
		Hooks map[string][]struct {
			Matcher string `json:"matcher"`
			Hooks   []struct {
				Command string `json:"command"`
			} `json:"hooks"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal([]byte(claudeHooksSnippet), &parsed); err != nil {
		panic("claudeHooksSnippet does not parse: " + err.Error())
	}
	order := map[string]int{"UserPromptSubmit": 0, "PostToolUse": 1, "Notification": 2, "Stop": 3}
	var rtn []ClaudeHookEntry
	for event, matchers := range parsed.Hooks {
		for _, matcher := range matchers {
			for _, hook := range matcher.Hooks {
				rtn = append(rtn, ClaudeHookEntry{Event: event, Matcher: matcher.Matcher, Command: hook.Command})
			}
		}
	}
	sort.SliceStable(rtn, func(i, j int) bool { return order[rtn[i].Event] < order[rtn[j].Event] })
	return rtn
}

// IsAgentStateHookCommand tells whether a hook command reports agent states (any variant of agent-states.md's).
func IsAgentStateHookCommand(command string) bool {
	return strings.Contains(command, agentStateHookCommand)
}

// IsAgentSessionHookCommand tells whether a hook command links the session (any variant of agent-states.md's).
func IsAgentSessionHookCommand(command string) bool {
	return strings.Contains(command, agentSessionHookCommand)
}

// IsAgentPermissionHookCommand tells whether a hook command answers permission requests through MoltenTerm.
func IsAgentPermissionHookCommand(command string) bool {
	return strings.Contains(command, agentPermissionHookCommand)
}

// HasCoffeeApproval tells whether the run got the PermissionRequest hook of the coffee approvals.
func (r AgentIntegrationReport) HasCoffeeApproval() bool {
	if r.StepAside != "" {
		return false
	}
	for _, it := range r.Added {
		if it.Kind == IntegrationCoffeeApproval {
			return true
		}
	}
	return false
}

// CoffeeApprovalSkipped is why the launcher left the hook out of the run, "" when it did not say.
func (r AgentIntegrationReport) CoffeeApprovalSkipped() string {
	if r.StepAside != "" {
		return r.StepAside
	}
	for _, it := range r.Skipped {
		if it.Kind == IntegrationCoffeeApproval {
			return it.Reason
		}
	}
	return ""
}

// CoffeeApprovalSkippedText is CoffeeApprovalSkipped's code, nil when it has none.
func (r AgentIntegrationReport) CoffeeApprovalSkippedText() *uimsg.Text {
	if r.StepAside != "" {
		return r.StepAsideText
	}
	for _, it := range r.Skipped {
		if it.Kind == IntegrationCoffeeApproval {
			return it.ReasonText
		}
	}
	return nil
}

// IsStatusLineRelayCommand tells whether a status line command already runs the relay.
func IsStatusLineRelayCommand(command string) bool {
	return strings.Contains(command, agentStatusLineRelay)
}

// ClaudeConfigDir is Claude Code's user folder: CLAUDE_CONFIG_DIR, else ~/.claude.
func ClaudeConfigDir(env AgentEnv) string {
	return claudeConfigDir(env)
}

// ClaudeManagedSettingsPath is the managed settings file an administrator may deploy.
func ClaudeManagedSettingsPath() string {
	return claudeManagedSettings()
}

// ClaudeSettingsLevel is one settings file Claude Code may read, with its level: user, project or local.
type ClaudeSettingsLevel struct {
	Path  string
	Level string
}

const (
	ClaudeLevelUser    = "user"
	ClaudeLevelProject = "project"
	ClaudeLevelLocal   = "local"
)

// ClaudeUserProjectLocalFiles lists the user, project and local settings of a session started in cwd, highest level
// first: the project's local then shared files (nearest folder first), then the user's.
func ClaudeUserProjectLocalFiles(env AgentEnv, cwd string) []ClaudeSettingsLevel {
	var rtn []ClaudeSettingsLevel
	all := claudeSettingsFiles(env, cwd)
	if len(all) > 3 {
		project := all[3:]
		for i := 0; i+1 < len(project); i += 2 {
			rtn = append(rtn, ClaudeSettingsLevel{Path: project[i+1], Level: ClaudeLevelLocal}, ClaudeSettingsLevel{Path: project[i], Level: ClaudeLevelProject})
		}
	}
	userDir := claudeConfigDir(env)
	return append(rtn,
		ClaudeSettingsLevel{Path: filepath.Join(userDir, "settings.local.json"), Level: ClaudeLevelUser},
		ClaudeSettingsLevel{Path: filepath.Join(userDir, "settings.json"), Level: ClaudeLevelUser})
}

// DisplayHomePath shows a path under the home folder with ~.
func DisplayHomePath(env AgentEnv, path string) string {
	return displayHomePath(env, path)
}

// CodexHome is Codex's user folder: CODEX_HOME, else ~/.codex.
func CodexHome(env AgentEnv) string {
	return codexHome(env)
}

// GuideProfileOfAgent maps an agent id (claude) to the profile of its molten guides (claude-code), or "".
func GuideProfileOfAgent(agent string) string {
	return guideProfileOfAgent(agent)
}
