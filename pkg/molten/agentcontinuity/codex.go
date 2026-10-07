// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentcontinuity

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentlaunch"
	"github.com/wavetermdev/waveterm/pkg/molten/companion"
	"github.com/wavetermdev/waveterm/pkg/molten/usage"
)

// Codex (DS-CONT-019; developers.openai.com/codex config reference; codex --help and codex resume --help, codex-cli
// 0.160.1, read 2026-10-07). `codex [PROMPT]` starts an interactive session with an initial prompt, -m picks the
// model, `codex resume <id>` resumes a session. The briefing goes in developer_instructions ("Additional developer
// instructions injected into the session") with -c for the run, after the user's own value, which -c would replace.
// Codex lists the models it offers in $CODEX_HOME/models_cache.json (undocumented file, read-only); the user's model
// is config.toml's top-level `model`. Launch integration, per-run MCP and notify come with #320.

const (
	codexName          = "Codex"
	codexExecutable    = "codex"
	codexModelFlag     = "-m"
	codexResumeCommand = "resume"
	codexForkCommand   = "fork"
	codexBriefingFlag  = "-c developer_instructions=…"
	codexExitCommand   = "/exit"
	codexModelsFile    = "models_cache.json"
	codexConfigFile    = "config.toml"
	codexModelListed   = "list"
	// Larger files are not read: they are not Codex's.
	maxCodexFileBytes = 8 * 1024 * 1024
	maxCodexModels    = 50
)

// Codex's options whose value is the next argument (codex --help, 0.160.1): the first other word is its subcommand.
var codexValueOptions = map[string]bool{
	"-c": true, "--config": true, "--enable": true, "--disable": true, "--remote": true, "--remote-auth-token-env": true,
	"-i": true, "--image": true, "-m": true, "--model": true, "--local-provider": true, "-p": true, "--profile": true,
	"-s": true, "--sandbox": true, "-a": true, "--ask-for-approval": true, "-C": true, "--cd": true, "--add-dir": true,
}

var codexCapabilities = map[string]Capability{
	CapBriefing:      {Support: SupportDocumented, Note: "-c developer_instructions for the run, after the user's own (FR-CONT-009)"},
	CapInitialPrompt: {Support: SupportDocumented, Note: "codex [PROMPT]"},
	CapModels:        {Support: SupportDocumented, Note: "-m <model>; the list comes from Codex's models cache (undocumented file)"},
	CapResume:        {Support: SupportDocumented, Note: "codex resume <id>, codex fork"},
	CapTranscript:    {Support: SupportUndocumented, Note: "$CODEX_HOME/sessions documented; the rollout file layout is source only and migrating", InUse: true},
	CapQuota:         {Support: SupportUndocumented, Note: "token_count rate_limits in the session log (#263), else the app-server", InUse: true},
	CapMcp:           {Support: SupportDocumented, Note: "-c mcp_servers.<name> for the run (FR-SHELL-038, #320)"},
	CapHooks:         {Support: SupportDocumented, Note: "notify for the run (#320); today the snippet the pane header offers"},
}

var codexConfigModelRegex = regexp.MustCompile(`^model\s*=\s*"([^"\\]*)"\s*(#.*)?$`)

type codexAdapter struct{}

func (codexAdapter) Id() string         { return molten.AgentIdCodex }
func (codexAdapter) Name() string       { return codexName }
func (codexAdapter) Executable() string { return codexExecutable }

func (codexAdapter) Briefing() BriefingChannel {
	return BriefingChannel{Channel: ChannelDeveloper, Support: SupportDocumented, Flag: codexBriefingFlag,
		Note: "developer instructions for the run, after the user's own; AGENTS.md still applies"}
}

// Models: the agent's default, then the models Codex lists (visibility "list") with their context windows. The user's
// configured model is marked, and added when the cache does not list it.
func (codexAdapter) Models(env ModelEnv) []ModelChoice {
	home := molten.CodexHome(env)
	configured := readCodexConfiguredModel(filepath.Join(home, codexConfigFile))
	rtn := []ModelChoice{{Id: "", Label: "Your default model"}}
	seen := false
	for _, m := range readCodexModelsCache(filepath.Join(home, codexModelsFile)) {
		if m.Id == configured {
			m.Configured, seen = true, true
		}
		rtn = append(rtn, m)
	}
	if configured != "" && !seen {
		rtn = append(rtn, ModelChoice{Id: configured, Label: configured, Configured: true})
	}
	return rtn
}

type codexModelsCache struct {
	Models []struct {
		Slug          string `json:"slug"`
		DisplayName   string `json:"display_name"`
		Visibility    string `json:"visibility"`
		ContextWindow int    `json:"context_window"`
	} `json:"models"`
}

func readCodexModelsCache(path string) []ModelChoice {
	data, err := readBoundedFile(path, maxCodexFileBytes)
	if err != nil {
		return nil
	}
	var cache codexModelsCache
	if json.Unmarshal(data, &cache) != nil {
		return nil
	}
	var rtn []ModelChoice
	for _, m := range cache.Models {
		if m.Visibility != codexModelListed || !ValidModelId(m.Slug) {
			continue
		}
		label := strings.TrimSpace(m.DisplayName)
		if label == "" {
			label = m.Slug
		}
		window := m.ContextWindow
		if window < 0 {
			window = 0
		}
		rtn = append(rtn, ModelChoice{Id: m.Slug, Label: label, ContextWindow: window})
		if len(rtn) >= maxCodexModels {
			break
		}
	}
	return rtn
}

// readCodexConfiguredModel reads config.toml's top-level model, before any table; "" when absent or not a plain
// string.
func readCodexConfiguredModel(path string) string {
	data, err := readBoundedFile(path, maxCodexFileBytes)
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "[") {
			return ""
		}
		if match := codexConfigModelRegex.FindStringSubmatch(line); match != nil && ValidModelId(match[1]) {
			return match[1]
		}
	}
	return ""
}

// readBoundedFile reads a regular file of at most max bytes: a FIFO or a device would block.
func readBoundedFile(path string, max int64) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file", path)
	}
	if info.Size() > max {
		return nil, fmt.Errorf("%s is too large", path)
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(io.LimitReader(f, max))
}

func (codexAdapter) FreshArgs(model string, initialPrompt string) ([]string, error) {
	if err := checkModel(model); err != nil {
		return nil, err
	}
	var rtn []string
	if model != "" {
		rtn = append(rtn, codexModelFlag, model)
	}
	prompt, err := promptArgs(initialPrompt)
	if err != nil {
		return nil, err
	}
	return append(rtn, prompt...), nil
}

func (codexAdapter) ResumeArgs(sessionId string) ([]string, error) {
	if err := checkSessionId(sessionId); err != nil {
		return nil, err
	}
	return []string{codexResumeCommand, sessionId}, nil
}

// ResumesSession: the resume and fork subcommands reopen an existing session's history.
func (codexAdapter) ResumesSession(args []string) bool {
	word := firstWord(args, codexValueOptions)
	return word == codexResumeCommand || word == codexForkCommand
}

func (codexAdapter) Exit() ExitSequence {
	return ExitSequence{Command: codexExitCommand, Interrupt: []string{"Escape", "Ctrl+C"}}
}

func (codexAdapter) Capabilities() map[string]Capability {
	return copyCapabilities(codexCapabilities)
}

// Launch: nil until #320 registers Codex's launcher.
func (codexAdapter) Launch() agentlaunch.LaunchAdapter {
	return agentlaunch.FindAdapter(molten.AgentIdCodex)
}

func (codexAdapter) Transcripts() companion.Adapter {
	return companion.AdapterFor(molten.AgentIdCodex)
}

func (codexAdapter) Usage() usage.UsageAdapter {
	return usage.For(molten.AgentIdCodex)
}

func (codexAdapter) GuideProfile() string {
	return molten.GuideProfileOfAgent(molten.AgentIdCodex)
}
