// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"path/filepath"
	"regexp"
	"strings"
	"unicode"
)

// Agent states (FR-SHELL-011, DS-SHELL-011): which coding agent runs in a terminal and what it is doing. wavesrv keeps
// the states (pkg/molten/attention); wsh reports them from the agents' hooks (`molten agent state`). The registry
// below is the list of known agents: adding one is adding a row.
// How each agent draws its UI, for clean copy (gutter glyphs, frames), is the row with the same id in
// frontend/moltenterm-shell/term-copy/agent-copy-profiles.ts.

// must match frontend/moltenterm-shell/agent-state-model.ts
const (
	AgentStateWorking = "working"
	AgentStateWaiting = "waiting"
	AgentStateDone    = "done"
	AgentStateError   = "error"
	AgentStateIdle    = "idle"

	AgentStateEvent      = "molten:agentstate"
	AgentStatesRoute     = "molten:agents"
	AgentStatesCommand   = "moltenagentstates"
	AgentStateSetCommand = "moltenagentstateset"

	AgentMessageMaxLength = 200
	agentIdMaxLength      = 32
)

type AgentKind struct {
	Id   string
	Name string
	// The words that start the agent in a shell.
	Commands []string
	// Fragments of a process's executable path or arguments that name the agent when its process name does not
	// (Claude Code's binary is ~/.local/share/claude/versions/<version>; Gemini CLI runs in node).
	ProcessHints []string
}

var AgentKinds = []AgentKind{
	{Id: "claude", Name: "Claude Code", Commands: []string{"claude"}, ProcessHints: []string{"/claude/versions/", "@anthropic-ai/claude-code", "/bin/claude"}},
	{Id: "codex", Name: "Codex", Commands: []string{"codex"}, ProcessHints: []string{"@openai/codex", "/bin/codex"}},
	{Id: "gemini", Name: "Gemini CLI", Commands: []string{"gemini"}, ProcessHints: []string{"@google/gemini-cli", "/bin/gemini"}},
	{Id: "opencode", Name: "OpenCode", Commands: []string{"opencode"}, ProcessHints: []string{"opencode-ai", "/bin/opencode"}},
}

var agentIdRegex = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)
var envAssignRegex = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*=`)

// Environment assignments before the command, quoted values included (as in frontend/app/view/term/osc-handlers.ts).
var leadingEnvRegex = regexp.MustCompile(`^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*`)

// Wrappers that run the command that follows them.
var commandPrefixes = map[string]bool{"env": true, "exec": true, "command": true, "time": true, "nohup": true, "caffeinate": true}

func FindAgentKind(id string) *AgentKind {
	for i := range AgentKinds {
		if AgentKinds[i].Id == id {
			return &AgentKinds[i]
		}
	}
	return nil
}

func AgentDisplayName(id string) string {
	if kind := FindAgentKind(id); kind != nil {
		return kind.Name
	}
	return id
}

// ValidAgentId accepts the registry's ids and any short lowercase name a hook reports for an agent the registry
// does not know yet.
func ValidAgentId(id string) bool {
	return len(id) <= agentIdMaxLength && agentIdRegex.MatchString(id)
}

func ValidAgentState(state string) bool {
	switch state {
	case AgentStateWorking, AgentStateWaiting, AgentStateDone, AgentStateError, AgentStateIdle:
		return true
	}
	return false
}

// AgentStateUrgency orders the states a tab or a workspace shows: waiting, then error, then working, then done.
func AgentStateUrgency(state string) int {
	switch state {
	case AgentStateWaiting:
		return 4
	case AgentStateError:
		return 3
	case AgentStateWorking:
		return 2
	case AgentStateDone:
		return 1
	}
	return 0
}

// MatchAgentCommand returns the agent a shell command line starts, or "": in each of its commands (`clear; claude`,
// `cd app && codex`), the first word after environment assignments and wrappers (env, exec, time...), by base name,
// so /usr/local/bin/claude and `npx codex` match too.
func MatchAgentCommand(cmdline string) string {
	for _, segment := range splitCommandLine(cmdline) {
		if id := matchSimpleCommand(segment); id != "" {
			return id
		}
	}
	return ""
}

// splitCommandLine cuts a command line into its commands at ;, &, &&, || and newlines, outside quotes. A pipeline
// stays one command, known by its first word: an agent fed by a pipe (`cat x | claude -p`) is a one-shot run. A
// comment ends the line.
func splitCommandLine(cmdline string) []string {
	var rtn []string
	var cur strings.Builder
	var quote rune
	escaped := false
	atWordStart := true
	flush := func() {
		if s := strings.TrimSpace(cur.String()); s != "" {
			rtn = append(rtn, s)
		}
		cur.Reset()
		atWordStart = true
	}
	runes := []rune(cmdline)
	for i := 0; i < len(runes); i++ {
		r := runes[i]
		switch {
		case escaped:
			escaped = false
		case quote != 0:
			if r == quote {
				quote = 0
			} else if r == '\\' && quote == '"' {
				escaped = true
			}
		case r == '\\':
			escaped = true
		case r == '"' || r == '\'':
			quote = r
		case r == ';' || r == '&' || r == '\n':
			flush()
			continue
		case r == '|' && i+1 < len(runes) && runes[i+1] == '|':
			i++
			flush()
			continue
		case r == '#' && atWordStart:
			flush()
			return rtn
		}
		cur.WriteRune(r)
		atWordStart = unicode.IsSpace(r)
	}
	flush()
	return rtn
}

func matchSimpleCommand(segment string) string {
	line := strings.TrimLeft(strings.TrimSpace(segment), "({ \t")
	if line == "" || strings.HasPrefix(line, "#") {
		return ""
	}
	line = leadingEnvRegex.ReplaceAllString(line, "")
	for _, word := range strings.Fields(line) {
		word = strings.Trim(strings.TrimRight(word, ")}"), `"'`)
		if envAssignRegex.MatchString(word) || strings.HasPrefix(word, "-") {
			continue
		}
		if commandPrefixes[word] || word == "npx" || word == "bunx" || word == "pnpx" {
			continue
		}
		base := filepath.Base(word)
		for _, kind := range AgentKinds {
			for _, c := range kind.Commands {
				if base == c {
					return kind.Id
				}
			}
		}
		if id := matchAgentPackage(word); id != "" {
			return id
		}
		return ""
	}
	return ""
}

func matchAgentPackage(word string) string {
	for _, kind := range AgentKinds {
		for _, hint := range kind.ProcessHints {
			if strings.HasPrefix(hint, "@") && strings.HasPrefix(word, hint) {
				return kind.Id
			}
		}
	}
	return ""
}

// The words an agent's notification uses when its turn is over rather than when it needs an answer.
var doneWordsRegex = regexp.MustCompile(`(?i)\b(complete|completed|finished|done)\b`)

// AttentionAgentState reads what an attention signal (DS-SHELL-004) says about a running agent: done when its text
// says the turn is over, waiting otherwise (a bell, a question, a permission request).
func AttentionAgentState(title string, message string) string {
	if doneWordsRegex.MatchString(title + " " + message) {
		return AgentStateDone
	}
	return AgentStateWaiting
}

// CleanAgentMessage keeps a reported message printable and short.
func CleanAgentMessage(message string) string {
	var b strings.Builder
	for _, r := range message {
		if unicode.IsControl(r) {
			r = ' '
		}
		b.WriteRune(r)
	}
	clean := strings.Join(strings.Fields(b.String()), " ")
	if len([]rune(clean)) > AgentMessageMaxLength {
		clean = string([]rune(clean)[:AgentMessageMaxLength-1]) + "…"
	}
	return clean
}

type AgentStateRequest struct {
	BlockId string `json:"blockid"`
	State   string `json:"state"`
	Agent   string `json:"agent,omitempty"`
	Message string `json:"message,omitempty"`
}

type AgentStateInfo struct {
	BlockId     string `json:"blockid"`
	TabId       string `json:"tabid,omitempty"`
	WorkspaceId string `json:"workspaceid,omitempty"`
	Agent       string `json:"agent,omitempty"`
	AgentName   string `json:"agentname,omitempty"`
	State       string `json:"state,omitempty"`
	Message     string `json:"message,omitempty"`
	Since       int64  `json:"since,omitempty"`
	Version     int64  `json:"version"`
	// Hooked: this agent's hooks reported in this run of MoltenTerm, in any terminal (the hook setup offer, #221).
	Hooked bool `json:"hooked,omitempty"`
	// Cleared: the block has no agent any more.
	Cleared bool `json:"cleared,omitempty"`
}

// AgentRunInfo is what the agent companion (DS-SHELL-019) needs of a block's agent: which one, and since when it runs.
type AgentRunInfo struct {
	BlockId string
	Agent   string
	// Started, in Unix milliseconds.
	Started int64
	Running bool
	State   string
}
