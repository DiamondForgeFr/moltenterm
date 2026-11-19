// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agentcontinuity

import (
	"path/filepath"
	"sort"

	"github.com/BurntSushi/toml"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentlaunch"
	"github.com/wavetermdev/waveterm/pkg/molten/agenttoolkit"
	"github.com/wavetermdev/waveterm/pkg/molten/companion"
	"github.com/wavetermdev/waveterm/pkg/molten/usage"
)

// Kimi Code 2.6.3 (DS-CONT-040; moonshotai.github.io/kimi-code, kimi --help, read 2026-11-19). -m takes a configured
// model alias, --session resumes an id and --continue reopens the current folder's previous session. The CLI and its
// internal wire protocol change quickly: transcript replay is undocumented, bounded and fails closed to terminal-only.
// Prompt mode offers stream-json, but -p applies automatic permissions and can write; it is not a read-only runner.
const (
	kimiName            = "Kimi Code"
	kimiExecutable      = "kimi"
	kimiModelFlag       = "-m"
	kimiResumeFlag      = "--session"
	kimiContinueFlag    = "--continue"
	kimiExitCommand     = "/exit"
	kimiConfigFile      = "config.toml"
	maxKimiConfigBytes  = 4 * 1024 * 1024
	maxKimiModelChoices = 50
)

var kimiCapabilities = map[string]Capability{
	CapBriefing:      {Support: SupportUnavailable, Note: "no per-run briefing channel is wired; #333 owns briefing delivery"},
	CapInitialPrompt: {Support: SupportDocumented, Note: "interactive prompt after --; -p --output-format stream-json is documented headless, but uses automatic permissions and may write"},
	CapModels:        {Support: SupportDocumented, Note: "-m <alias>; aliases and context sizes are read from config.toml"},
	CapResume:        {Support: SupportDocumented, Note: "kimi --session <id>, kimi --continue"},
	CapTranscript:    {Support: SupportUndocumented, Note: "state.json, session_index.jsonl and wire.jsonl observed on 2.6.3; internal format, terminal-only on incompatible records", InUse: true},
	CapQuota:         {Support: SupportUnavailable, Note: "/usage exists, but no usage adapter is wired"},
	CapMcp:           {Support: SupportDocumented, Note: "documented MCP configuration; this Story does not write it or add a per-run server"},
	CapHooks:         {Support: SupportDocumented, Note: "manual [[hooks]] config.toml recipe; no launcher or automatic installation", InUse: true},
}

type kimiAdapter struct{}

func (kimiAdapter) Id() string         { return molten.AgentIdKimi }
func (kimiAdapter) Name() string       { return kimiName }
func (kimiAdapter) Executable() string { return kimiExecutable }

func (kimiAdapter) Models(env ModelEnv) []ModelChoice {
	home := ""
	if env.Getenv != nil {
		home = env.Getenv("KIMI_CODE_HOME")
	}
	if home == "" {
		home = filepath.Join(env.Home, ".kimi-code")
	}
	data, err := readBoundedFile(filepath.Join(home, kimiConfigFile), maxKimiConfigBytes)
	if err != nil {
		return []ModelChoice{{Id: "", Label: "Your default model"}}
	}
	var config struct {
		DefaultModel string `toml:"default_model"`
		Models       map[string]struct {
			DisplayName    string `toml:"display_name"`
			Model          string `toml:"model"`
			MaxContextSize int    `toml:"max_context_size"`
		} `toml:"models"`
	}
	if toml.Unmarshal(data, &config) != nil {
		return []ModelChoice{{Id: "", Label: "Your default model"}}
	}
	aliases := make([]string, 0, len(config.Models))
	for alias := range config.Models {
		if ValidModelId(alias) {
			aliases = append(aliases, alias)
		}
	}
	sort.Strings(aliases)
	if config.DefaultModel != "" {
		aliases = append([]string{config.DefaultModel}, aliases...)
	}
	rtn := []ModelChoice{{Id: "", Label: "Your default model"}}
	seen := map[string]bool{}
	for _, alias := range aliases {
		if seen[alias] || len(rtn) > maxKimiModelChoices {
			continue
		}
		seen[alias] = true
		model, ok := config.Models[alias]
		if !ok {
			continue
		}
		label := CleanLabel(model.DisplayName)
		if label == "" {
			label = CleanLabel(model.Model)
		}
		if label == "" {
			label = alias
		}
		window := model.MaxContextSize
		if window < 0 {
			window = 0
		}
		rtn = append(rtn, ModelChoice{Id: alias, Label: label, ContextWindow: window, Configured: alias == config.DefaultModel})
	}
	return rtn
}

func (kimiAdapter) Briefing() BriefingChannel {
	return BriefingChannel{Channel: ChannelFirstMessage, Support: SupportUnavailable, Note: "not wired; #333 owns briefing delivery"}
}

func (kimiAdapter) FreshArgs(model string, initialPrompt string) ([]string, error) {
	if err := checkModel(model); err != nil {
		return nil, err
	}
	var rtn []string
	if model != "" {
		rtn = append(rtn, kimiModelFlag, model)
	}
	prompt, err := promptArgs(initialPrompt)
	if err != nil {
		return nil, err
	}
	return append(rtn, prompt...), nil
}

func (kimiAdapter) ResumeArgs(sessionId string) ([]string, error) {
	if err := checkSessionId(sessionId); err != nil {
		return nil, err
	}
	return []string{kimiResumeFlag, sessionId}, nil
}

func (kimiAdapter) LastSessionArgs() []string {
	return []string{kimiContinueFlag}
}

func (kimiAdapter) ResumesSession(args []string) bool {
	return hasOption(args, "-S", kimiResumeFlag, "-c", kimiContinueFlag)
}

func (kimiAdapter) Exit() ExitSequence {
	return ExitSequence{Command: kimiExitCommand, Interrupt: []string{"Escape", "Ctrl+C"}}
}

func (kimiAdapter) Capabilities() map[string]Capability {
	return copyCapabilities(kimiCapabilities)
}

func (kimiAdapter) Features() map[string]FeatureSupport {
	return copyFeatures(kimiFeatures)
}

func (kimiAdapter) Launch() agentlaunch.LaunchAdapter { return nil }

func (kimiAdapter) Transcripts() companion.Adapter {
	return companion.AdapterFor(molten.AgentIdKimi)
}

func (kimiAdapter) Usage() usage.UsageAdapter { return nil }

func (kimiAdapter) GuideProfile() string {
	return molten.GuideProfileOfAgent(molten.AgentIdKimi)
}

func (kimiAdapter) Toolkit(env ModelEnv, cwd string) agenttoolkit.Toolkit {
	return agenttoolkit.Toolkit{}
}
