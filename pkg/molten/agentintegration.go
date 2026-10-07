// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"encoding/json"
	"path/filepath"
	"sort"
	"strings"
)

// Agent integration at launch (FR-SHELL-036, DS-SHELL-045 to 048): in a local MoltenTerm terminal, `claude` runs
// MoltenTerm's launcher (pkg/molten/agentlaunch), which adds the hooks and the status line relay of this package for
// that run only, through the agent's own per-run settings. Nothing of the user's is written (NFR-SHELL-019). The
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
)

// Kinds of what the launcher adds to a run.
const (
	IntegrationStateHooks = "statehooks"
	IntegrationSession    = "sessionlink"
	IntegrationStatusLine = "statusline"
	// The molten-browser MCP server (FR-SHELL-037): added, or skipped as the user's own.
	IntegrationBrowser = "browser"
)

// IntegrationItem is one thing added to a run, or left out (Reason says why, in plain words).
type IntegrationItem struct {
	Kind   string `json:"kind"`
	Name   string `json:"name"`
	Reason string `json:"reason,omitempty"`
}

// AgentIntegrationReport is what the launcher tells of one run. StepAside: nothing was added, and why.
type AgentIntegrationReport struct {
	BlockId   string            `json:"blockid"`
	Agent     string            `json:"agent"`
	RealPath  string            `json:"realpath"`
	Pid       int               `json:"pid,omitempty"`
	Settings  string            `json:"settings,omitempty"`
	McpConfig string            `json:"mcpconfig,omitempty"`
	Added     []IntegrationItem `json:"added,omitempty"`
	Skipped   []IntegrationItem `json:"skipped,omitempty"`
	StepAside string            `json:"stepaside,omitempty"`
	// At, in Unix milliseconds: set by wavesrv when it receives the report.
	At int64 `json:"at,omitempty"`
}

// Integrated tells whether anything was added to the run.
func (r AgentIntegrationReport) Integrated() bool {
	return r.StepAside == "" && len(r.Added) > 0
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
	Event   string
	Command string
}

// ClaudeStateHooks lists the state hooks of agent-states.md (claudeHooksSnippet) in their order, with their exact
// command strings: the launcher adds the same handlers, which Claude Code runs once when the user pasted them too.
func ClaudeStateHooks() []ClaudeHookEntry {
	var parsed struct {
		Hooks map[string][]struct {
			Hooks []struct {
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
				rtn = append(rtn, ClaudeHookEntry{Event: event, Command: hook.Command})
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
