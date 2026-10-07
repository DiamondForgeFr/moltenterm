// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentcontinuity

import (
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentlaunch"
	"github.com/wavetermdev/waveterm/pkg/molten/companion"
	"github.com/wavetermdev/waveterm/pkg/molten/usage"
)

// Claude Code (DS-CONT-018; code.claude.com/docs/en/cli-reference, sessions, statusline, hooks; claude --help
// 2.1.292, read 2026-10-07). `claude "query"` starts an interactive session with an initial prompt, --model takes an
// alias (fable, opus, sonnet, haiku) or a full name, --resume <id> resumes a session. The briefing is appended to the
// system prompt for the run with --append-system-prompt-file, which works in interactive mode; the system prompt is
// recorded at the first request and reused on --resume, so a resumed session gets no briefing.

const (
	claudeName          = "Claude Code"
	claudeExecutable    = "claude"
	claudeModelFlag     = "--model"
	claudeResumeFlag    = "--resume"
	claudeBriefingFlag  = "--append-system-prompt-file"
	claudeContextWindow = 200000
	claudeExitCommand   = "/exit"
)

var claudeModels = []ModelChoice{
	{Id: "", Label: "Your default model"},
	{Id: "fable", Label: "Fable (latest)", ContextWindow: claudeContextWindow},
	{Id: "opus", Label: "Opus (latest)", ContextWindow: claudeContextWindow},
	{Id: "sonnet", Label: "Sonnet (latest)", ContextWindow: claudeContextWindow},
	{Id: "haiku", Label: "Haiku (latest)", ContextWindow: claudeContextWindow},
}

var claudeCapabilities = map[string]Capability{
	CapBriefing:      {Support: SupportDocumented, Note: "--append-system-prompt-file, for the run (FR-CONT-009)"},
	CapInitialPrompt: {Support: SupportDocumented, Note: `claude "query"`},
	CapModels:        {Support: SupportDocumented, Note: "--model with an alias or a full name"},
	CapResume:        {Support: SupportDocumented, Note: "--resume <id>, --continue, --fork-session"},
	CapTranscript:    {Support: SupportDocumented, Note: "~/.claude/projects/<folder>/<session>.jsonl; its format is internal and changes between versions", InUse: true},
	CapQuota:         {Support: SupportDocumented, Note: "status line rate_limits (#261), StopFailure rate_limit hook, usage limit messages", InUse: true},
	CapMcp:           {Support: SupportDocumented, Note: "--mcp-config for the run (FR-SHELL-037)"},
	CapHooks:         {Support: SupportDocumented, Note: "state hooks, session link and status line relay, per run through the #318 launcher", InUse: true},
}

type claudeAdapter struct{}

func (claudeAdapter) Id() string         { return molten.AgentIdClaude }
func (claudeAdapter) Name() string       { return claudeName }
func (claudeAdapter) Executable() string { return claudeExecutable }

func (claudeAdapter) Models(env ModelEnv) []ModelChoice {
	return append([]ModelChoice(nil), claudeModels...)
}

func (claudeAdapter) Briefing() BriefingChannel {
	return BriefingChannel{Channel: ChannelSystemAppend, Support: SupportDocumented, Flag: claudeBriefingFlag,
		Note: "appended to Claude Code's system prompt for the run; CLAUDE.md and the user's settings still apply"}
}

func (claudeAdapter) FreshArgs(model string, initialPrompt string) ([]string, error) {
	if err := checkModel(model); err != nil {
		return nil, err
	}
	var rtn []string
	if model != "" {
		rtn = append(rtn, claudeModelFlag, model)
	}
	prompt, err := promptArgs(initialPrompt)
	if err != nil {
		return nil, err
	}
	return append(rtn, prompt...), nil
}

func (claudeAdapter) ResumeArgs(sessionId string) ([]string, error) {
	if err := checkSessionId(sessionId); err != nil {
		return nil, err
	}
	return []string{claudeResumeFlag, sessionId}, nil
}

// ResumesSession: --continue, --resume (with or without an id, which opens the picker) and --from-pr all reopen an
// existing session.
func (claudeAdapter) ResumesSession(args []string) bool {
	return hasOption(args, "-c", "--continue", "-r", "--resume", "--from-pr")
}

func (claudeAdapter) Exit() ExitSequence {
	return ExitSequence{Command: claudeExitCommand, Interrupt: []string{"Escape", "Ctrl+C"}}
}

func (claudeAdapter) Capabilities() map[string]Capability {
	return copyCapabilities(claudeCapabilities)
}

func (claudeAdapter) Launch() agentlaunch.LaunchAdapter {
	return agentlaunch.FindAdapter(molten.AgentIdClaude)
}

func (claudeAdapter) Transcripts() companion.Adapter {
	return companion.AdapterFor(molten.AgentIdClaude)
}

func (claudeAdapter) Usage() usage.UsageAdapter {
	return usage.For(molten.AgentIdClaude)
}

func (claudeAdapter) GuideProfile() string {
	return molten.GuideProfileOfAgent(molten.AgentIdClaude)
}

func copyCapabilities(caps map[string]Capability) map[string]Capability {
	rtn := make(map[string]Capability, len(caps))
	for k, v := range caps {
		rtn[k] = v
	}
	return rtn
}
