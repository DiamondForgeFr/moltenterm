// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package molten

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"

	"github.com/BurntSushi/toml"
)

// The hook setup offer (#221, FR-SHELL-011): an agent whose hooks never reported shows its states from its pane's
// output only (#217). Every provider of agentHookSetups gets the same flow (#2595, agenthookfile.go): the dialog shows
// what changes, Apply writes it into the file the offer names after a backup, Copy keeps the manual recipe. The
// adapters: Kimi Code's managed TOML block (kimihooks.go), Claude Code's and Codex's JSON hooks (agenthookjson.go).

const (
	AgentHookOfferCommand   = "moltenagenthookoffer"
	AgentHookDismissCommand = "moltenagenthookdismiss"
	AgentHookApplyCommand   = "moltenagenthookapply"
	AgentHookRemoveCommand  = "moltenagenthookremove"
	AgentStatesDocCommand   = "moltenagentstatesdoc"

	// What every hook of agent-states.md runs; a configuration that runs it is set up.
	agentStateHookCommand = "molten agent state"
	agentStatesDocFile    = "agent-states.md"
	// What MoltenTerm's launcher adds to claude and codex, and how to turn it off (FR-SHELL-040).
	AgentIntegrationsDocFile = "agent-integrations.md"
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

	HookStatusAbsent              = "absent"
	HookStatusCurrent             = "current"
	HookStatusDefinitionUpdate    = "definition-update"
	HookStatusCompatibilityReview = "compatibility-review"
	HookStatusDrift               = "drift"
	HookStatusInvalid             = "invalid"
	HookStatusConflict            = "conflict"
	HookStatusManual              = "manual"
	HookStatusNotReporting        = "installed-not-reporting"
	HookStatusReporting           = "reporting"

	HookActionInstall = "install"
	HookActionUpdate  = "update"
	HookActionRepair  = "repair"
	HookActionReview  = "review"
	HookActionRemove  = "remove"

	HookUpdateDefinition    = "definition"
	HookUpdateCompatibility = "compatibility"
	HookUpdateRepair        = "repair"
)

// The hooks of agent-states.md (#988): the same events and the same command as the launcher's, so a pasted copy is the
// same handler (Claude Code runs it once; Codex trusts it once).
var (
	claudeHooksSnippet = hooksSnippet(AgentStateHooks(AgentIdClaude))
	codexHooksSnippet  = hooksSnippet(AgentStateHooks(AgentIdCodex))
	kimiHooksSnippet   = kimiHooksTOML(AgentStateHooks(AgentIdKimi))
)

// The notify line an older agent-states.md offered Codex: a config.toml running it is still set up.
const codexNotifySnippet = `notify = ["sh", "-c", "[ -n \"$WAVETERM_BLOCKID\" ] && molten agent state done --agent codex || true"]`

// hooksSnippet writes hooks in the file shape Claude Code's settings and Codex's hooks.json share, one line per
// handler.
func hooksSnippet(entries []AgentHookEntry) string {
	quote := func(s string) string {
		var b strings.Builder
		enc := json.NewEncoder(&b)
		enc.SetEscapeHTML(false)
		enc.Encode(s)
		return strings.TrimSuffix(b.String(), "\n")
	}
	var b strings.Builder
	b.WriteString("{\n  \"hooks\": {\n")
	for i, e := range entries {
		handler := `{ "type": "command", "command": ` + quote(e.Command)
		if e.Timeout > 0 {
			handler += fmt.Sprintf(`, "timeout": %d`, e.Timeout)
		}
		handler += " }"
		group := `{ "hooks": [` + handler + `] }`
		if e.Matcher != "" {
			group = `{ "matcher": ` + quote(e.Matcher) + `, "hooks": [` + handler + `] }`
		}
		fmt.Fprintf(&b, "    %s: [\n      %s\n    ]", quote(e.Event), group)
		if i < len(entries)-1 {
			b.WriteString(",")
		}
		b.WriteString("\n")
	}
	b.WriteString("  }\n}")
	return b.String()
}

// kimiHooksTOML writes the [[hooks]] entries of Kimi Code's config.toml, one event per rule.
func kimiHooksTOML(entries []AgentHookEntry) string {
	var b strings.Builder
	for i, entry := range entries {
		if i > 0 {
			b.WriteString("\n")
		}
		fmt.Fprintf(&b, "[[hooks]]\nevent = %q\ncommand = %q\n", entry.Event, entry.Command)
		if entry.Timeout > 0 {
			fmt.Fprintf(&b, "timeout = %d\n", entry.Timeout)
		}
	}
	return strings.TrimSuffix(b.String(), "\n")
}

type agentHookSetup struct {
	language string
	snippet  string
	// file: where the snippet goes; also: where else it may go, said in a sentence.
	file       func(env AgentEnv) string
	also       string
	brings     string
	configured func(env AgentEnv, cwd string) bool
	// adapter reads, applies and removes MoltenTerm's hooks in file; every provider has one (agenthookflow_test.go).
	adapter agentHookAdapter
}

func claudeUserSettingsPath(env AgentEnv) string {
	return filepath.Join(claudeConfigDir(env), "settings.json")
}

func codexUserHooksPath(env AgentEnv) string {
	return filepath.Join(codexHome(env), CodexHooksFile)
}

var agentHookSetups = map[string]agentHookSetup{
	"claude": {
		language:   "json",
		snippet:    claudeHooksSnippet,
		file:       claudeUserSettingsPath,
		also:       "or in a project's .claude/settings.json, merged with the hooks you already have",
		brings:     "waiting when it asks for a permission, done when its turn ends, working again once you approved",
		configured: claudeHooksConfigured,
		adapter:    jsonHookAdapter{agent: AgentIdClaude, path: claudeUserSettingsPath, configured: claudeHooksConfigured},
	},
	"codex": {
		language:   "json",
		snippet:    codexHooksSnippet,
		file:       codexUserHooksPath,
		also:       "or in a project's .codex/hooks.json, merged with the hooks you already have; Codex runs them once you trust them in /hooks",
		brings:     "working while it works, done when its turn ends, and its session linked as soon as it starts",
		configured: codexHooksConfigured,
		adapter:    jsonHookAdapter{agent: AgentIdCodex, path: codexUserHooksPath, configured: codexHooksConfigured, trust: true},
	},
	"kimi": {
		language:   "toml",
		snippet:    kimiHooksSnippet,
		file:       func(env AgentEnv) string { return filepath.Join(kimiCodeHome(env), "config.toml") },
		also:       "merged with the hooks you already have; Kimi Code reads hooks from this user file, not from the project",
		brings:     "working, waiting for a permission, done, errors and interruptions, plus the session and sub-agent links",
		configured: kimiHooksConfigured,
		adapter:    kimiHookAdapter{},
	},
}

// Codex's own hooks file, next to its config.toml (developers.openai.com/codex/hooks).
const CodexHooksFile = "hooks.json"

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

	Persistent                 bool     `json:"persistent,omitempty"`
	Status                     string   `json:"status,omitempty"`
	Action                     string   `json:"action,omitempty"`
	UpdateKind                 string   `json:"updatekind,omitempty"`
	UpdateKey                  string   `json:"updatekey,omitempty"`
	DefinitionVersion          int      `json:"definitionversion,omitempty"`
	DefinitionSHA256           string   `json:"definitionsha256,omitempty"`
	InstalledDefinitionVersion int      `json:"installeddefinitionversion,omitempty"`
	InstalledDefinitionSHA256  string   `json:"installeddefinitionsha256,omitempty"`
	InstalledKimiVersion       string   `json:"installedkimiversion,omitempty"`
	CurrentKimiVersion         string   `json:"currentkimiversion,omitempty"`
	QualifiedKimiVersion       string   `json:"qualifiedkimiversion,omitempty"`
	Events                     []string `json:"events,omitempty"`
	Managed                    bool     `json:"managed,omitempty"`
	ConfigDigest               string   `json:"configdigest,omitempty"`
	CanApply                   bool     `json:"canapply,omitempty"`
	CanRemove                  bool     `json:"canremove,omitempty"`
	ErrorCode                  string   `json:"errorcode,omitempty"`
	DetectionError             string   `json:"detectionerror,omitempty"`
	// Changes: what differs between the installed MoltenTerm hooks and the available ones (#2543).
	Changes []AgentHookChange `json:"changes,omitempty"`
	// Unqualified: the agent's version is not the qualified one nor known incompatible. Applying is allowed once the
	// developer confirms the risk (ConfirmUnqualified); only a known incompatible version stays read-only.
	Unqualified bool `json:"unqualified,omitempty"`
	// TrustRequired: the agent runs hooks it was not shown before only once the developer trusts them in its own
	// screen (Codex's /hooks); MoltenTerm never answers that for them.
	TrustRequired bool `json:"trustrequired,omitempty"`
	// LauncherAlso: this run was started by MoltenTerm's launcher, which added its current hooks, so the older
	// MoltenTerm hooks of the file run next to them until the update replaces them (#2595).
	LauncherAlso bool `json:"launcheralso,omitempty"`
}

type AgentHookOfferRequest struct {
	BlockId string `json:"blockid"`
}

type AgentHookDismissRequest struct {
	Agent     string `json:"agent"`
	UpdateKey string `json:"updatekey,omitempty"`
}

type AgentHookMutationRequest struct {
	BlockId string `json:"blockid"`
	// Agent is the run's agent, which wavesrv sets from the terminal; what a caller sends there is ignored.
	Agent          string `json:"agent,omitempty"`
	Action         string `json:"action"`
	UpdateKey      string `json:"updatekey"`
	ExpectedDigest string `json:"expecteddigest"`
	// The developer confirmed writing hooks for a version that is not qualified yet.
	ConfirmUnqualified bool `json:"confirmunqualified,omitempty"`
}

type AgentHookMutationResult struct {
	Offer      AgentHookOffer `json:"offer"`
	BackupPath string         `json:"backuppath,omitempty"`
}

// AgentHookDetection is the bounded, cached Kimi probe result supplied by attention.
type AgentHookDetection struct {
	Installed bool
	Version   string
	Reason    string
}

// Registered by agentcontinuity, which owns the bounded stat-cached detector. A callback avoids an import cycle through
// the companion while keeping detection out of the pure offer engine.
var DetectKimiHookVersion = func(context.Context) AgentHookDetection {
	return AgentHookDetection{Reason: "Kimi version detector is unavailable"}
}

func claudeConfigDir(env AgentEnv) string {
	return envOr(env, "CLAUDE_CONFIG_DIR", filepath.Join(env.Home, ".claude"))
}

func codexHome(env AgentEnv) string {
	return envOr(env, "CODEX_HOME", filepath.Join(env.Home, ".codex"))
}

func kimiCodeHome(env AgentEnv) string {
	return envOr(env, "KIMI_CODE_HOME", filepath.Join(env.Home, ".kimi-code"))
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
		return IsAgentStateHookCommand(string(data))
	}
	for _, matchers := range settings.Hooks {
		for _, matcher := range matchers {
			for _, hook := range matcher.Hooks {
				if IsAgentStateHookCommand(hook.Command) {
					return true
				}
			}
		}
	}
	return false
}

// codexHooksConfigured: a hooks.json of the user's that runs MoltenTerm's hooks (the same shape as Claude Code's
// settings), or a config.toml with the older notify line.
func codexHooksConfigured(env AgentEnv, cwd string) bool {
	if claudeFileHasHooks(filepath.Join(codexHome(env), CodexHooksFile)) {
		return true
	}
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

// kimiHooksConfigured reads only Kimi Code's hooks table. An invalid file is not called configured.
func kimiHooksConfigured(env AgentEnv, cwd string) bool {
	data, err := os.ReadFile(filepath.Join(kimiCodeHome(env), "config.toml"))
	if err != nil {
		return false
	}
	var config struct {
		Hooks []struct {
			Command string `toml:"command"`
		} `toml:"hooks"`
	}
	if err := toml.Unmarshal(data, &config); err != nil {
		return false
	}
	return slices.ContainsFunc(config.Hooks, func(h struct {
		Command string `toml:"command"`
	}) bool {
		return IsAgentStateHookCommand(h.Command)
	})
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
// is a refusal of the initial offer too. Kimi update, repair and compatibility offers take precedence over that memory.
func MakeAgentHookOffer(env AgentEnv, agent string, cwd string, hooked bool) AgentHookOffer {
	return MakeAgentHookOfferDetected(env, agent, cwd, hooked, AgentHookDetection{})
}

func MakeAgentHookOfferDetected(env AgentEnv, agent string, cwd string, hooked bool, detection AgentHookDetection) AgentHookOffer {
	offer := AgentHookOffer{Agent: agent, AgentName: AgentDisplayName(agent)}
	setup, ok := agentHookSetups[agent]
	if !ok {
		offer.Reason = HookOfferUnsupported
		return offer
	}
	offer.File = displayHomePath(env, setup.file(env))
	offer.Also = setup.also
	offer.Brings = setup.brings
	offer.Language = setup.language
	offer.Snippet = setup.snippet
	return setup.adapter.offer(env, offer, cwd, hooked, detection)
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

// AgentDocRequest names the agent guide AgentStatesDocCommand returns: agent-states.md when empty.
type AgentDocRequest struct {
	Doc string `json:"doc,omitempty"`
}

// The agent guides the pane and the companion open (FR-SHELL-040: agent-integrations.md).
var agentDocFiles = map[string]bool{agentStatesDocFile: true, AgentIntegrationsDocFile: true}

// AgentDocPath writes the documentation of this version and returns one of its agent guides.
func AgentDocPath(dataDir string, version string, doc string) (string, error) {
	if doc == "" {
		doc = agentStatesDocFile
	}
	if !agentDocFiles[doc] {
		return "", fmt.Errorf("unknown agent guide %q", doc)
	}
	path, err := AgentStatesDocPath(dataDir, version)
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(path), doc), nil
}
