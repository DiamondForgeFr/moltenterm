// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
)

// The hook setup offer (#221, FR-SHELL-011): an agent whose hooks never reported shows its states from its pane's
// output only (#217); the pane header offers the setup of agentdocs/agent-states.md, which makes them precise. The
// user applies it: MoltenTerm only reads the agent's configuration, to leave out an agent already set up, and never
// writes it.

const (
	AgentHookOfferCommand   = "moltenagenthookoffer"
	AgentHookDismissCommand = "moltenagenthookdismiss"
	AgentStatesDocCommand   = "moltenagentstatesdoc"

	// What every hook of agent-states.md runs; a configuration that runs it is set up.
	agentStateHookCommand = "molten agent state"
	agentStatesDocFile    = "agent-states.md"
)

const (
	HookOfferUnsupported = "unsupported"
	HookOfferRemote      = "remote"
	HookOfferHooked      = "hooked"
	HookOfferSeen        = "seen"
	HookOfferDeclined    = "declined"
	HookOfferRemoved     = "removed"
	HookOfferConfigured  = "configured"
	// The agent was started through MoltenTerm's launcher, which added its hooks to the run (FR-SHELL-036).
	HookOfferIntegrated = "integrated"
)

const claudeHooksSnippet = `{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "[ -n \"$WAVETERM_BLOCKID\" ] && molten agent state working --agent claude || true" }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "[ -n \"$WAVETERM_BLOCKID\" ] && molten agent state working --agent claude || true" }] }
    ],
    "Notification": [
      { "hooks": [{ "type": "command", "command": "[ -n \"$WAVETERM_BLOCKID\" ] && molten agent state waiting --agent claude --stdin || true" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "[ -n \"$WAVETERM_BLOCKID\" ] && molten agent state done --agent claude || true" }] }
    ]
  }
}`

const codexNotifySnippet = `notify = ["sh", "-c", "[ -n \"$WAVETERM_BLOCKID\" ] && molten agent state done --agent codex || true"]`

type agentHookSetup struct {
	language string
	snippet  string
	// file: where the snippet goes; also: where else it may go, said in a sentence.
	file       func(env AgentEnv) string
	also       string
	brings     string
	configured func(env AgentEnv, cwd string) bool
}

var agentHookSetups = map[string]agentHookSetup{
	"claude": {
		language:   "json",
		snippet:    claudeHooksSnippet,
		file:       func(env AgentEnv) string { return filepath.Join(claudeConfigDir(env), "settings.json") },
		also:       "or in a project's .claude/settings.json, merged with the hooks you already have",
		brings:     "waiting when it asks for a permission, done when its turn ends, working again once you approved",
		configured: claudeHooksConfigured,
	},
	"codex": {
		language:   "toml",
		snippet:    codexNotifySnippet,
		file:       func(env AgentEnv) string { return filepath.Join(codexHome(env), "config.toml") },
		also:       "at the top level, replacing any notify line you already have",
		brings:     "done when its turn ends",
		configured: codexHooksConfigured,
	},
}

// AgentHookOffer is what the pane header shows for a terminal's agent. Reason says why it does not show.
type AgentHookOffer struct {
	BlockId   string `json:"blockid"`
	Agent     string `json:"agent,omitempty"`
	AgentName string `json:"agentname,omitempty"`
	Show      bool   `json:"show"`
	Reason    string `json:"reason,omitempty"`
	File      string `json:"file,omitempty"`
	Also      string `json:"also,omitempty"`
	Brings    string `json:"brings,omitempty"`
	Language  string `json:"language,omitempty"`
	Snippet   string `json:"snippet,omitempty"`
}

type AgentHookOfferRequest struct {
	BlockId string `json:"blockid"`
}

type AgentHookDismissRequest struct {
	Agent string `json:"agent"`
}

func claudeConfigDir(env AgentEnv) string {
	return envOr(env, "CLAUDE_CONFIG_DIR", filepath.Join(env.Home, ".claude"))
}

func codexHome(env AgentEnv) string {
	return envOr(env, "CODEX_HOME", filepath.Join(env.Home, ".codex"))
}

// Claude Code's managed settings, set by an administrator; a var so tests do not read the real one.
var claudeManagedSettings = func() string {
	switch runtime.GOOS {
	case "darwin":
		return "/Library/Application Support/ClaudeCode/managed-settings.json"
	case "windows":
		return `C:\ProgramData\ClaudeCode\managed-settings.json`
	}
	return "/etc/claude-code/managed-settings.json"
}

// claudeSettingsFiles lists the settings Claude Code reads for a session started in cwd: the user's, the managed
// ones, and the project's and local ones of cwd and of its parents up to the repository's root (a session started
// in a subfolder still runs the project's hooks), never above the home folder.
func claudeSettingsFiles(env AgentEnv, cwd string) []string {
	userDir := claudeConfigDir(env)
	files := []string{filepath.Join(userDir, "settings.json"), filepath.Join(userDir, "settings.local.json"), claudeManagedSettings()}
	if cwd == "" || !filepath.IsAbs(cwd) {
		return files
	}
	home := filepath.Clean(env.Home)
	for dir := filepath.Clean(cwd); ; dir = filepath.Dir(dir) {
		files = append(files, filepath.Join(dir, ".claude", "settings.json"), filepath.Join(dir, ".claude", "settings.local.json"))
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			break
		}
		if dir == home || dir == filepath.Dir(dir) {
			break
		}
	}
	return files
}

func claudeHooksConfigured(env AgentEnv, cwd string) bool {
	return slices.ContainsFunc(claudeSettingsFiles(env, cwd), claudeFileHasHooks)
}

type claudeSettingsHooks struct {
	Hooks map[string][]struct {
		Hooks []struct {
			Command string `json:"command"`
		} `json:"hooks"`
	} `json:"hooks"`
}

// A settings file that does not parse is searched as text: Claude Code may accept what this reader does not, and a
// false "set up" only hides an offer.
func claudeFileHasHooks(path string) bool {
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	var settings claudeSettingsHooks
	if err := json.Unmarshal(data, &settings); err != nil {
		return strings.Contains(string(data), agentStateHookCommand)
	}
	for _, matchers := range settings.Hooks {
		for _, matcher := range matchers {
			for _, hook := range matcher.Hooks {
				if strings.Contains(hook.Command, agentStateHookCommand) {
					return true
				}
			}
		}
	}
	return false
}

func codexHooksConfigured(env AgentEnv, cwd string) bool {
	data, err := os.ReadFile(filepath.Join(codexHome(env), "config.toml"))
	if err != nil {
		return false
	}
	// A commented-out line is not set up; the snippet itself holds no '#'.
	for _, line := range strings.Split(string(data), "\n") {
		code, _, _ := strings.Cut(line, "#")
		if strings.Contains(code, agentStateHookCommand) {
			return true
		}
	}
	return false
}

// guideProfileOfAgent maps an agent state id (claude) to its guides' profile (claude-code), for `molten agent remove`.
func guideProfileOfAgent(agent string) string {
	kind := FindAgentKind(agent)
	if kind == nil {
		return ""
	}
	for _, profile := range AgentProfiles {
		if profile.Executable != "" && slices.Contains(kind.Commands, profile.Executable) {
			return profile.Id
		}
	}
	return ""
}

func displayHomePath(env AgentEnv, path string) string {
	home := filepath.Clean(env.Home)
	if home == "" || home == "." {
		return path
	}
	if rest, ok := strings.CutPrefix(path, home+string(filepath.Separator)); ok {
		return "~/" + filepath.ToSlash(rest)
	}
	return path
}

// MakeAgentHookOffer decides the offer for an agent running in a local terminal whose folder is cwd. hooked: its hooks
// reported in this run of MoltenTerm. The user's refusal of MoltenTerm's guides for the agent (`molten agent remove`)
// is a refusal of the offer too.
func MakeAgentHookOffer(env AgentEnv, agent string, cwd string, hooked bool) AgentHookOffer {
	offer := AgentHookOffer{Agent: agent, AgentName: AgentDisplayName(agent)}
	setup, ok := agentHookSetups[agent]
	switch {
	case !ok:
		offer.Reason = HookOfferUnsupported
	case hooked:
		offer.Reason = HookOfferHooked
	case AgentHooksSeen(env.DataDir, agent):
		offer.Reason = HookOfferSeen
	case IsAgentHooksOfferDeclined(env.DataDir, agent):
		offer.Reason = HookOfferDeclined
	case guideProfileOfAgent(agent) != "" && IsAgentDeclined(env.DataDir, guideProfileOfAgent(agent)):
		offer.Reason = HookOfferRemoved
	case setup.configured(env, cwd):
		offer.Reason = HookOfferConfigured
	}
	if offer.Reason != "" {
		return offer
	}
	offer.Show = true
	offer.File = displayHomePath(env, setup.file(env))
	offer.Also = setup.also
	offer.Brings = setup.brings
	offer.Language = setup.language
	offer.Snippet = setup.snippet
	return offer
}

// AgentStatesDocPath writes the documentation of this version where `molten docs` does, and returns its page on
// agent states.
func AgentStatesDocPath(dataDir string, version string) (string, error) {
	dir := DocsDir(dataDir, version)
	if err := WriteDocs(dir); err != nil {
		return "", err
	}
	return filepath.Join(dir, agentStatesDocFile), nil
}
