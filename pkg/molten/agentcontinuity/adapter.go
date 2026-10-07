// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package agentcontinuity holds what MoltenTerm knows of each coding agent, whatever its provider (FR-CONT-006,
// DS-CONT-006): how to detect it, start it with a model and an initial prompt, resume one of its sessions, give it a
// briefing, end it, and which of its capabilities are documented. An adapter composes the agent's existing parts
// instead of repeating them: its launcher (agentlaunch, #318), its transcript reader (companion) and its usage adapter
// (usage, #260 to #263). Detection and model lists only read the agent's files and run `<agent> --version`: nothing
// of the agent's is written, no login is run and no credential is read (NFR-CONT-002, NFR-SHELL-019).
//
// Adding an agent means adding an adapter here (FR-CONT-013 adds Gemini CLI, Kimi Code and OpenCode).
package agentcontinuity

import (
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentlaunch"
	"github.com/wavetermdev/waveterm/pkg/molten/companion"
	"github.com/wavetermdev/waveterm/pkg/molten/usage"
)

// How well a capability is known (DS-CONT-007): documented by the agent's vendor, undocumented (source, issue or
// observation only, and so at risk with each version), or not available.
const (
	SupportDocumented   = "documented"
	SupportUndocumented = "undocumented"
	SupportUnavailable  = "unavailable"
)

// How an adapter gives the agent a briefing (DS-CONT-006), best documented channel first.
const (
	ChannelSystemAppend     = "systemappend"
	ChannelDeveloper        = "developer"
	ChannelInstructionsFile = "instructionsfile"
	ChannelAgentFile        = "agentfile"
	ChannelFirstMessage     = "firstmessage"
)

// The capabilities every adapter declares (DS-CONT-006, DS-CONT-007).
const (
	CapBriefing      = "briefing"
	CapInitialPrompt = "initialprompt"
	CapModels        = "models"
	CapResume        = "resume"
	CapTranscript    = "transcript"
	CapQuota         = "quota"
	CapMcp           = "mcp"
	CapHooks         = "hooks"
)

// AllCapabilities lists the capabilities in the order molten agent list shows them.
var AllCapabilities = []string{CapBriefing, CapInitialPrompt, CapModels, CapResume, CapTranscript, CapQuota, CapMcp, CapHooks}

// Capability is one capability of an agent. InUse: MoltenTerm uses it today; a documented capability another story
// wires is declared with InUse false, so an interface offers only what works.
type Capability struct {
	Support string `json:"support"`
	Note    string `json:"note,omitempty"`
	InUse   bool   `json:"inuse,omitempty"`
}

// BriefingChannel is how the agent receives a briefing for one run. Flag: the argument that carries it; Key: the
// configuration key the flag sets, when it sets one (Codex's -c developer_instructions=...). The briefing itself is
// composed and passed by FR-CONT-009 (#180).
type BriefingChannel struct {
	Channel string `json:"channel"`
	Support string `json:"support"`
	Flag    string `json:"flag,omitempty"`
	Key     string `json:"key,omitempty"`
	Note    string `json:"note,omitempty"`
}

// ModelChoice is one model an agent can run. Id "" is the agent's own default (no model argument). ContextWindow is
// in tokens, 0 when unknown.
type ModelChoice struct {
	Id            string `json:"id"`
	Label         string `json:"label"`
	Local         bool   `json:"local,omitempty"`
	ContextWindow int    `json:"contextwindow,omitempty"`
	// Configured: the model the user's own configuration selects.
	Configured bool `json:"configured,omitempty"`
}

// ExitSequence is how an agent is ended cleanly: the command typed at its prompt, and the keys that interrupt a
// turn. MoltenTerm types them only on a user action, while the agent is idle (NFR-CONT-004).
type ExitSequence struct {
	Command   string   `json:"command"`
	Interrupt []string `json:"interrupt,omitempty"`
}

// ModelEnv is what a model list may read: the agent's configuration folders, never a credential.
type ModelEnv = molten.AgentEnv

// AgentAdapter is one coding agent (DS-CONT-006).
type AgentAdapter interface {
	// Id is the agent id of molten.AgentKinds (or kimi).
	Id() string
	Name() string
	// Executable is the program looked up on the login PATH.
	Executable() string
	// Models lists the models offered, the agent's default first. It reads the agent's files only.
	Models(env ModelEnv) []ModelChoice
	Briefing() BriefingChannel
	// FreshArgs builds the arguments that start a fresh interactive session (without the program name). model ""
	// keeps the agent's default; initialPrompt "" starts without one. A model id is one argument, never parsed by a
	// shell.
	FreshArgs(model string, initialPrompt string) ([]string, error)
	// ResumeArgs builds the arguments that resume one of the agent's sessions by id.
	ResumeArgs(sessionId string) ([]string, error)
	// ResumesSession tells whether the user's arguments resume an existing session (a resumed session gets no
	// briefing: DS-CONT-013).
	ResumesSession(args []string) bool
	Exit() ExitSequence
	// Capabilities holds every capability of AllCapabilities.
	Capabilities() map[string]Capability
	// Launch is the agent's launcher (#318), nil while it has none.
	Launch() agentlaunch.LaunchAdapter
	// Transcripts is the companion's reader of the agent's sessions, nil while it has none.
	Transcripts() companion.Adapter
	// Usage is the agent's usage adapter (page and gauges sources), nil while it has none.
	Usage() usage.UsageAdapter
	// GuideProfile is the id of the agent's molten guides profile (molten agent install), "" for none.
	GuideProfile() string
}
