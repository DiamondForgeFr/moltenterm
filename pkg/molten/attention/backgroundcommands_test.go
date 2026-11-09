// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package attention

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agenthook"
)

// Payloads recorded from Claude Code 2.1 sessions (#2140): a Bash call left in the background ends its PostToolUse
// with tool_response.backgroundTaskId; its end is a task notification Claude Code writes to the session's transcript
// (a queue-operation record, then the user record of the turn it starts).
func bgHookTool(transcript string, id string, description string) string {
	return fmt.Sprintf(`{"session_id":"s","transcript_path":%q,"cwd":"/w","permission_mode":"bypassPermissions","hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"until gh pr checks 2140 --required; do sleep 30; done","description":%q,"run_in_background":true},"tool_response":{"stdout":"","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false,"backgroundTaskId":%q},"tool_use_id":"toolu_01NnjrZZRsCGRGCibAkZF1ag"}`, transcript, description, id)
}

func bgHookStop(transcript string) string {
	return fmt.Sprintf(`{"session_id":"s","transcript_path":%q,"cwd":"/w","hook_event_name":"Stop","stop_hook_active":false}`, transcript)
}

func bgHookPlainTool(transcript string) string {
	return fmt.Sprintf(`{"session_id":"s","transcript_path":%q,"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"cat /tmp/tasks/bz4ehrk6q.output","description":"Read the CI result"},"tool_response":{"stdout":"all checks passed","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false}}`, transcript)
}

func bgNotificationRecords(id string, status string) string {
	// Claude Code writes its JSON without escaping < and >, as JSON.stringify does.
	quoted := fmt.Sprintf(`"<task-notification>\n<task-id>%s</task-id>\n<tool-use-id>toolu_01NnjrZZRsCGRGCibAkZF1ag</tool-use-id>\n<output-file>/private/tmp/claude-501/p/s/tasks/%s.output</output-file>\n<status>%s</status>\n<summary>Background command \"Wait for the CI\" %s (exit code 0)</summary>\n</task-notification>"`, id, id, status, status)
	return fmt.Sprintf(`{"type":"queue-operation","operation":"enqueue","timestamp":"2026-11-09T10:02:00.000Z","sessionId":"s","content":%s}`+"\n"+
		`{"parentUuid":"p1","isSidechain":false,"promptId":"x","type":"user","message":{"role":"user","content":%s},"uuid":"u9","timestamp":"2026-11-09T10:02:00.010Z","sessionId":"s"}`+"\n", quoted, quoted)
}

func makeTranscript(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "s.jsonl")
	earlier := `{"type":"user","message":{"role":"user","content":"wait for the CI of #2140"},"sessionId":"s"}` + "\n"
	if err := os.WriteFile(path, []byte(earlier), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func appendTranscript(t *testing.T, path string, records string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(records); err != nil {
		t.Fatal(err)
	}
}

// hookNotify feeds hook inputs as wavesrv's route does, notices included.
func (h *agentHarness) hookNotify(t *testing.T, block string, inputs ...string) {
	t.Helper()
	call := func(command string, route string, data any) error {
		if command != agenthook.AgentStateSetCommand {
			return nil
		}
		raw, _ := json.Marshal(data)
		var req molten.AgentStateRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Fatal(err)
		}
		signal, kind, err := h.states.report(req)
		if signal != nil {
			h.states.notify(req.BlockId, *signal, kind)
		}
		return err
	}
	for _, input := range inputs {
		if err := agenthook.RunHookEvent(agenthook.ReadHookInput(strings.NewReader(input)), "claude", block, call); err != nil {
			t.Fatalf("%s: %v", input, err)
		}
	}
}

func wantBackground(t *testing.T, h *agentHarness, block string, code string) molten.AgentStateInfo {
	t.Helper()
	info := h.info(block)
	if info.State != molten.AgentStateWorking || !info.Background || info.MessageText == nil || info.MessageText.Code != code {
		t.Fatalf("published %+v (text %+v), want working in the background with %s", info, info.MessageText, code)
	}
	return info
}

// AC-1: a turn that ends while its background command runs shows working in the background with the command's words,
// and calls nobody: no notice from the Stop, none from the terminal's own "done" signal.
func TestBackgroundCommandKeepsThePaneWorking(t *testing.T) {
	t.Parallel()
	h := makeAgentHarness()
	tr := makeTranscript(t)
	h.out("b1", cmdMark("claude"))
	h.hookNotify(t, "b1", hookMainPrompt, bgHookTool(tr, "bz4ehrk6q", "Wait for the CI"), bgHookStop(tr))
	if run, _ := h.states.runOf("b1"); run.State != molten.AgentStateDone {
		t.Fatalf("the main session's own state is its Stop: %+v", run)
	}
	info := wantBackground(t, h, "b1", "agentState.backgroundCommandNamed")
	if info.MessageText.Vars["description"] != "Wait for the CI" || info.Message != "In the background: Wait for the CI" {
		t.Fatalf("words %+v %q", info.MessageText, info.Message)
	}
	h.out("b1", "\x1b]9;Claude is waiting for your input\x07")
	if len(h.notices) != 0 || len(h.recorded) != 0 {
		t.Fatalf("nobody is called: notices %v, signals %v", h.notices, h.recorded)
	}

	// The developer looks at the pane: still the command's work.
	h.states.seen("b1", h.version("b1"))
	wantBackground(t, h, "b1", "agentState.backgroundCommandNamed")

	// A turn of the developer's own that ends while the command still runs: the command outlives it.
	appendTranscript(t, tr, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Still waiting for the CI."}]}}`+"\n")
	h.hookNotify(t, "b1", hookMainPrompt)
	if info := h.info("b1"); info.Background {
		t.Fatalf("the main session works: not background %+v", info)
	}
	h.hookNotify(t, "b1", bgHookStop(tr))
	wantBackground(t, h, "b1", "agentState.backgroundCommandNamed")
	if len(h.notices) != 0 {
		t.Fatalf("notices %v", h.notices)
	}
}

// AC-2: once the transcript tells the command's end, the turn it resumed ends as any turn: done, and the notice.
func TestBackgroundCommandEndGivesTheTurnBack(t *testing.T) {
	t.Parallel()
	for _, status := range []string{"completed", "failed", "killed"} {
		h := makeAgentHarness()
		tr := makeTranscript(t)
		h.hookNotify(t, "b1", hookMainPrompt, bgHookTool(tr, "bz4ehrk6q", "Wait for the CI"), bgHookStop(tr))
		wantBackground(t, h, "b1", "agentState.backgroundCommandNamed")

		appendTranscript(t, tr, bgNotificationRecords("bz4ehrk6q", status))
		h.hookNotify(t, "b1", bgHookPlainTool(tr), bgHookStop(tr))
		wantNoSubagents(t, h, "b1", molten.AgentStateDone)
		if len(h.notices) != 1 || !strings.HasPrefix(h.notices[0], "success:") {
			t.Fatalf("%s: the resumed turn's end calls the developer as before: %v", status, h.notices)
		}
	}

	// The user's own `molten agent state done` Stop hook may report before MoltenTerm's handler reads the end.
	h := makeAgentHarness()
	tr := makeTranscript(t)
	h.hookNotify(t, "b1", hookMainPrompt, bgHookTool(tr, "bz4ehrk6q", "Wait for the CI"), bgHookStop(tr))
	appendTranscript(t, tr, bgNotificationRecords("bz4ehrk6q", "completed"))
	h.hookNotify(t, "b1", bgHookPlainTool(tr))
	if signal, _, err := h.states.report(molten.AgentStateRequest{BlockId: "b1", State: molten.AgentStateDone, Agent: "claude"}); err != nil || signal != nil {
		t.Fatalf("the command's end is not read yet: %v %v", signal, err)
	}
	h.hookNotify(t, "b1", bgHookStop(tr))
	wantNoSubagents(t, h, "b1", molten.AgentStateDone)
	if len(h.notices) != 1 {
		t.Fatalf("the end read gives the turn back: %v", h.notices)
	}
}

// A turn that ends with nothing in the background still waits for the developer.
func TestNoBackgroundCommandNoChange(t *testing.T) {
	t.Parallel()
	h := makeAgentHarness()
	tr := makeTranscript(t)
	h.hookNotify(t, "b1", hookMainPrompt, bgHookPlainTool(tr), bgHookStop(tr))
	wantNoSubagents(t, h, "b1", molten.AgentStateDone)
	if len(h.notices) != 1 {
		t.Fatalf("notices %v", h.notices)
	}
}

// AC-3: a command whose end is never told is forgotten by the sub-agents' rules: the session's next start, the run's
// end, and a bounded set. A turn end without the transcript (a user's own `molten agent state done` hook) reads
// nothing and keeps the commands.
func TestBackgroundCommandsForgottenLikeSubagents(t *testing.T) {
	t.Parallel()
	h := makeAgentHarness()
	tr := makeTranscript(t)
	h.hookNotify(t, "b1", hookMainPrompt, bgHookTool(tr, "b1aaaaaaa", ""), bgHookTool(tr, "b2bbbbbbb", ""), bgHookStop(tr))
	info := wantBackground(t, h, "b1", "agentState.backgroundCommands")
	if info.MessageText.Vars["count"] != "2" {
		t.Fatalf("count %+v", info.MessageText)
	}
	h.send(molten.AgentStateRequest{BlockId: "b1", State: molten.AgentStateDone, Agent: "claude"})
	wantBackground(t, h, "b1", "agentState.backgroundCommands")
	appendTranscript(t, tr, bgNotificationRecords("b2bbbbbbb", "completed"))
	h.hookNotify(t, "b1", bgHookStop(tr))
	wantBackground(t, h, "b1", "agentState.backgroundCommand")

	h.hookNotify(t, "b1", hookSessionStart)
	wantNoSubagents(t, h, "b1", molten.AgentStateIdle)

	h2 := makeAgentHarness()
	for i := 0; i < maxTrackedSubagents+10; i++ {
		h2.send(molten.AgentStateRequest{BlockId: "b2", State: molten.AgentStateWorking, Agent: "claude", BackgroundTask: fmt.Sprintf("b%08d", i), Transcript: tr})
	}
	h2.send(molten.AgentStateRequest{BlockId: "b2", State: molten.AgentStateDone, Agent: "claude", Transcript: tr})
	info = wantBackground(t, h2, "b2", "agentState.backgroundCommands")
	if info.MessageText.Vars["count"] != fmt.Sprint(maxTrackedSubagents) {
		t.Fatalf("bounded: %+v", info.MessageText)
	}
	h2.states.forget("b2")
	if info := h2.info("b2"); info.State != "" {
		t.Fatalf("the run's end forgets its commands: %+v", info)
	}
}

// Sub-agents and commands together are counted as one background.
func TestBackgroundCommandsAndSubagents(t *testing.T) {
	t.Parallel()
	h := makeAgentHarness()
	tr := makeTranscript(t)
	h.hookNotify(t, "b1", hookMainPrompt, bgHookTool(tr, "bz4ehrk6q", "Wait for the CI"), bgHookStop(tr), hookSubStart, hookSubTool)
	info := wantBackground(t, h, "b1", "agentState.backgroundTasks")
	if info.MessageText.Vars["count"] != "2" || info.Subagents != 1 {
		t.Fatalf("%+v %+v", info, info.MessageText)
	}
}

// A sub-agent's own background command (its hook carries agent_id) is the sub-agent's work, not the main session's.
func TestSubagentBackgroundCommandIsTheSubagents(t *testing.T) {
	t.Parallel()
	h := makeAgentHarness()
	tr := makeTranscript(t)
	sub := strings.Replace(bgHookTool(tr, "bz4ehrk6q", "Wait"), `"session_id":"s"`, `"session_id":"s","agent_id":"a-1","agent_type":"general-purpose"`, 1)
	h.hookNotify(t, "b1", hookMainPrompt, bgHookStop(tr), sub)
	wantBackground(t, h, "b1", "agentState.subagent")
}
