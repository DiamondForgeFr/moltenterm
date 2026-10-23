// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agenthook

import (
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"time"
)

// The one hook handler of Claude Code and Codex (#988, FR-SHELL-036, FR-SHELL-038): both agents run their lifecycle
// hooks with the same JSON input on stdin (hook_event_name, session_id, transcript_path...), so MoltenTerm gives every
// event the same command, `molten agent hook --agent <id>`, and the event decides what it reports. Codex trusts a hook
// against the hash of its definition: the command text never carries the event.
//
// It prints nothing: Codex adds a SessionStart or UserPromptSubmit hook's output to the model's context, and refuses
// plain text from a Stop or SubagentStop hook.

// must match pkg/molten (checked by its tests)
const (
	CompanionSessionCommand  = "moltencompanionsession"
	CompanionSubagentCommand = "moltencompanionsubagent"

	HookEventSessionStart     = "SessionStart"
	HookEventUserPromptSubmit = "UserPromptSubmit"
	HookEventPostToolUse      = "PostToolUse"
	HookEventNotification     = "Notification"
	HookEventStop             = "Stop"
	HookEventSubagentStart    = "SubagentStart"
	HookEventSubagentStop     = "SubagentStop"

	SubagentEventStart = "start"
	SubagentEventStop  = "stop"
)

// A compaction starts a session again in the middle of a turn: it links the session, it changes no state.
const sessionSourceCompact = "compact"

// A PostToolUse input carries the tool's whole output: it is read as a stream, and no further than this.
const maxHookStdin = 16 * 1024 * 1024

// AgentSessionRequest is molten.AgentSessionRequest, as `molten agent hook` sends it at SessionStart.
type AgentSessionRequest struct {
	BlockId   string `json:"blockid"`
	Agent     string `json:"agent,omitempty"`
	Path      string `json:"path"`
	SessionId string `json:"sessionid,omitempty"`
}

// AgentSubagentRequest is molten.AgentSubagentRequest: a sub-agent of the pane's session started or stopped.
type AgentSubagentRequest struct {
	BlockId        string `json:"blockid"`
	Agent          string `json:"agent,omitempty"`
	Event          string `json:"event"`
	SessionId      string `json:"sessionid,omitempty"`
	AgentId        string `json:"agentid,omitempty"`
	AgentType      string `json:"agenttype,omitempty"`
	TranscriptPath string `json:"transcriptpath,omitempty"`
}

// HookArgs are the arguments of `molten agent hook`.
type HookArgs struct {
	Agent string
}

// ParseHookArgs reads `[--agent a]`; ok is false for anything else (help, a mistake to report: wsh's).
func ParseHookArgs(args []string) (HookArgs, bool) {
	var ha HookArgs
	for i := 0; i < len(args); i++ {
		name, value, hasValue := strings.Cut(args[i], "=")
		if name != "--agent" {
			return ha, false
		}
		if !hasValue {
			if i+1 >= len(args) {
				return ha, false
			}
			i++
			value = args[i]
		}
		ha.Agent = value
	}
	if ha.Agent != "" && !ValidAgentId(ha.Agent) {
		return ha, false
	}
	return ha, true
}

// HookCaller sends one request to wavesrv.
type HookCaller func(command string, route string, data any) error

func runHook(ha HookArgs, env Env) (bool, int) {
	token := env.Getenv(jwtVarName)
	if token == "" {
		return false, 0
	}
	blockId := env.Getenv("WAVETERM_BLOCKID")
	if claims, err := ParseTokenClaims(token); err == nil && claims.BlockId != "" {
		blockId = claims.BlockId
	}
	if blockId == "" {
		return false, 0
	}
	input := ReadHookInput(env.Stdin)
	caller, done := makeHookCaller(token)
	defer done()
	if err := RunHookEvent(input, ha.Agent, blockId, caller); err != nil {
		fmt.Fprintf(env.Stderr, "molten: %v\n", err)
		return true, 1
	}
	return true, 0
}

// makeHookCaller dials wavesrv on the first request only (most events need one) and keeps the connection for the
// next; every request has its own deadline.
func makeHookCaller(token string) (HookCaller, func()) {
	var c *Client
	call := func(command string, route string, data any) error {
		deadline := time.Now().Add(stateTimeout)
		if c == nil {
			var err error
			if c, err = Dial(token, deadline); err != nil {
				return err
			}
		}
		_, err := c.Call(command, route, data, deadline)
		return err
	}
	return call, func() {
		if c != nil {
			c.Close()
		}
	}
}

// RunHookEvent reports what one hook event means for the pane: its state, its session, its sub-agents. An event it
// does not know reports nothing.
func RunHookEvent(input HookInput, agent string, blockId string, call HookCaller) error {
	state := func(s string, message string) error {
		return call(AgentStateSetCommand, AgentStatesRoute, AgentStateRequest{BlockId: blockId, State: s, Agent: agent, Message: message})
	}
	switch input.HookEventName {
	case HookEventSessionStart:
		return sessionStart(input, agent, blockId, call)
	case HookEventUserPromptSubmit, HookEventPostToolUse:
		return state(AgentStateWorking, "")
	case HookEventNotification:
		if !ClaudeNotificationWaits(input) {
			return nil
		}
		return state(AgentStateWaiting, input.Message)
	case HookEventStop:
		return state(AgentStateDone, "")
	case HookEventSubagentStart, HookEventSubagentStop:
		event, path := SubagentEventStart, ""
		if input.HookEventName == HookEventSubagentStop {
			event, path = SubagentEventStop, input.AgentTranscriptPath
		}
		return call(CompanionSubagentCommand, CompanionRoute, AgentSubagentRequest{
			BlockId: blockId, Agent: agent, Event: event, SessionId: input.SessionId, AgentId: input.AgentId,
			AgentType: input.AgentType, TranscriptPath: absPath(path),
		})
	}
	return nil
}

// sessionStart links the session (its transcript, else its id) and makes the pane's states precise: a start report
// shows idle unless the agent is already at work (wavesrv keeps working and waiting). The state goes first: the
// companion's answer may take longer, and a failed link must not cost the pane its precise states.
func sessionStart(input HookInput, agent string, blockId string, call HookCaller) error {
	var errs []string
	if input.Source != sessionSourceCompact {
		req := AgentStateRequest{BlockId: blockId, State: AgentStateIdle, Agent: agent, Start: true}
		if err := call(AgentStateSetCommand, AgentStatesRoute, req); err != nil {
			errs = append(errs, err.Error())
		}
	}
	link := AgentSessionRequest{BlockId: blockId, Agent: agent, Path: absPath(input.TranscriptPath)}
	if link.Path == "" {
		link.SessionId = input.SessionId
	}
	if link.Path != "" || link.SessionId != "" {
		if err := call(CompanionSessionCommand, CompanionRoute, link); err != nil {
			errs = append(errs, err.Error())
		}
	}
	if len(errs) > 0 {
		return fmt.Errorf("%s", strings.Join(errs, "; "))
	}
	return nil
}

func absPath(path string) string {
	if path == "" {
		return ""
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return path
	}
	return abs
}

// field is where a key of a hook's input is kept, nil for a key that is skipped.
func (input *HookInput) field(key string) *string {
	switch key {
	case "hook_event_name":
		return &input.HookEventName
	case "notification_type":
		return &input.NotificationType
	case "message":
		return &input.Message
	case "session_id":
		return &input.SessionId
	case "transcript_path":
		return &input.TranscriptPath
	case "source":
		return &input.Source
	case "agent_id":
		return &input.AgentId
	case "agent_type":
		return &input.AgentType
	case "agent_transcript_path":
		return &input.AgentTranscriptPath
	}
	return nil
}

// ReadHookInput reads a hook's JSON input as a stream: the fields it knows are kept, every other value is skipped,
// so a tool's large output costs no more than reading it. A missing or broken input gives the fields read until then;
// a value that is not a string (null) leaves its field empty.
func ReadHookInput(r io.Reader) HookInput {
	var input HookInput
	if r == nil {
		return input
	}
	dec := json.NewDecoder(io.LimitReader(r, maxHookStdin))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return input
	}
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return input
		}
		key, _ := tok.(string)
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return input
		}
		if dst := input.field(key); dst != nil {
			var s string
			if json.Unmarshal(raw, &s) == nil {
				*dst = s
			}
		}
	}
	return input
}
