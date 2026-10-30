// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"path/filepath"
	"regexp"
	"strings"
	"unicode"

	"github.com/wavetermdev/waveterm/pkg/molten/agenthook"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
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
	// A window tells that the user has seen a done agent (#784): its green mark clears.
	AgentStateSeenCommand = "moltenagentstateseen"

	// The last first name a pane's agent had (FR-CONT-014), kept in the block's meta so a session that outlives a
	// restart of MoltenTerm (a durable terminal) gets it back.
	AgentFirstNameMetaKey = "molten:agentfirstname"

	AgentMessageMaxLength = 200
	agentIdMaxLength      = 32
)

// The agent ids every package uses for the same agent: states, launch, companion, usage and the agent adapters of
// pkg/molten/agentcontinuity.
const (
	AgentIdClaude   = "claude"
	AgentIdCodex    = "codex"
	AgentIdGemini   = "gemini"
	AgentIdOpenCode = "opencode"
	AgentIdKimi     = "kimi"
)

type AgentKind struct {
	Id   string
	Name string
	// The words that start the agent in a shell.
	Commands []string
	// Fragments of a process's executable path or arguments that name the agent when its process name does not
	// (Claude Code's binary is ~/.local/share/claude/versions/<version>; Gemini CLI runs in node).
	ProcessHints []string
	// WorktreesDir: the folder, relative to the project, the agent creates its own worktree agents in; a background
	// agent there was started by a session of this agent in the main checkout (#1463). "" when it has none.
	WorktreesDir string
}

var AgentKinds = []AgentKind{
	{Id: AgentIdClaude, Name: "Claude Code", Commands: []string{"claude"}, ProcessHints: []string{"/claude/versions/", "@anthropic-ai/claude-code", "/bin/claude"}, WorktreesDir: filepath.Join(".claude", "worktrees")},
	{Id: AgentIdCodex, Name: "Codex", Commands: []string{"codex"}, ProcessHints: []string{"@openai/codex", "/bin/codex"}},
	{Id: AgentIdGemini, Name: "Gemini CLI", Commands: []string{"gemini"}, ProcessHints: []string{"@google/gemini-cli", "/bin/gemini"}},
	{Id: AgentIdOpenCode, Name: "OpenCode", Commands: []string{"opencode"}, ProcessHints: []string{"opencode-ai", "/bin/opencode"}},
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

// AgentCallName is how a sentence names a session's agent: its first name (FR-CONT-014), else the agent's name.
func AgentCallName(firstName string, id string) string {
	if firstName != "" {
		return firstName
	}
	return AgentDisplayName(id)
}

// AgentLabel is how a list names a session's agent: "Jérôme · Claude Code", the agent's name alone without a first
// name. Must match agentLabel in frontend/moltenterm-shell/agent-state-model.ts.
func AgentLabel(firstName string, id string) string {
	if firstName == "" {
		return AgentDisplayName(id)
	}
	return firstName + " · " + AgentDisplayName(id)
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
// says the turn is over, waiting otherwise (a bell, a question, a permission request). Claude Code's "waiting for
// your input", a minute after a turn ended, asks nothing: done (#784).
func AttentionAgentState(title string, message string) string {
	if doneWordsRegex.MatchString(title+" "+message) || IsIdlePromptSignal(title, message) {
		return AgentStateDone
	}
	return AgentStateWaiting
}

// IsIdlePromptSignal tells whether an attention signal is Claude Code's idle reminder, which follows a turn that
// already ended: it must not turn an agent the user has seen back to done.
func IsIdlePromptSignal(title string, message string) bool {
	return agenthook.IsIdlePromptMessage(title + " " + message)
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

// AgentStateRequest is a state report. TurnEnd: the report comes from a source that only sees turns end (the Codex
// notify wrapper of the launcher, `molten agent notify`), not from the user's hooks: the pane's output activity keeps
// giving working, and the hook setup offer does not count the agent as set up. Start: the agent's SessionStart hook
// (`molten agent hook`, #988): the pane's states are precise from now on, and it shows State (idle) unless the agent
// is working or waiting.
type AgentStateRequest struct {
	BlockId string `json:"blockid"`
	State   string `json:"state"`
	Agent   string `json:"agent,omitempty"`
	Message string `json:"message,omitempty"`
	TurnEnd bool   `json:"turnend,omitempty"`
	Start   bool   `json:"start,omitempty"`
	// Subagent: the report is about a sub-agent of the pane's session (its agent_id, #1092), never the main session's
	// state: working means it runs, done that it stopped.
	Subagent string `json:"subagent,omitempty"`
}

// AgentStateSeenRequest: the window showed the block's done agent, at Version of its state.
type AgentStateSeenRequest struct {
	BlockId string `json:"blockid"`
	Version int64  `json:"version"`
}

type AgentStateInfo struct {
	BlockId     string `json:"blockid"`
	TabId       string `json:"tabid,omitempty"`
	WorkspaceId string `json:"workspaceid,omitempty"`
	Agent       string `json:"agent,omitempty"`
	AgentName   string `json:"agentname,omitempty"`
	// FirstName: the session's first name, unique among the app's active agents (FR-CONT-014).
	FirstName string `json:"firstname,omitempty"`
	State     string `json:"state,omitempty"`
	Message   string `json:"message,omitempty"`
	// MessageText: Message's code when MoltenTerm holds the state (#896), the window words it; nil for the agent's own
	// words.
	MessageText *uimsg.Text `json:"messagetext,omitempty"`
	Since       int64       `json:"since,omitempty"`
	// Started: when the agent's run started, in Unix milliseconds; the tab names its longest-running agent (#1033).
	Started int64 `json:"started,omitempty"`
	Version int64 `json:"version"`
	// Hooked: this agent's hooks reported in this run of MoltenTerm, in any terminal (the hook setup offer, #221).
	Hooked bool `json:"hooked,omitempty"`
	// Model, ModelName, Effort: the run's model and effort level as the agent last reported them (#549: Claude Code's
	// status line, Codex's last turn), "" when unknown; never a guess.
	Model     string `json:"model,omitempty"`
	ModelName string `json:"modelname,omitempty"`
	Effort    string `json:"effort,omitempty"`
	// Subagents: how many sub-agents of the session run now, as its hooks report them (#1092). Background: State is
	// working only because of them, the main session's prompt is idle (or done) and takes a message.
	Subagents  int  `json:"subagents,omitempty"`
	Background bool `json:"background,omitempty"`
	// Cleared: the block has no agent any more.
	Cleared bool `json:"cleared,omitempty"`
}

// AgentSettings is a run's model and effort level as its agent reports them (#549); "" fields are unknown.
type AgentSettings struct {
	Model     string
	ModelName string
	Effort    string
}

// AgentRunInfo is what the agent companion (DS-SHELL-019) needs of a block's agent: which one, and since when it runs.
type AgentRunInfo struct {
	BlockId string
	Agent   string
	// Started, in Unix milliseconds.
	Started int64
	Running bool
	// State: the main session's, never its sub-agents' (#1092): a handoff is typed when it is neither working nor
	// waiting, sub-agents running or not.
	State string
	// Subagents: how many sub-agents of the session run now (#1092).
	Subagents int
	// StateSince: when the agent entered State, in Unix milliseconds.
	StateSince int64
	// Pid: the agent's process, when the process tree found it in a local terminal (0 otherwise); PidStartMs tells a
	// reused pid apart. The keep-awake reads its tree's CPU to see background work (#493).
	Pid        int32
	PidStartMs int64
	// Settings: the model and effort level the agent last reported for this run.
	Settings AgentSettings
	// FirstName: the session's first name (FR-CONT-014).
	FirstName string
}
