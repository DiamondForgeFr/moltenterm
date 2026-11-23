// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/keepawake"
)

// A PermissionRequest input as Claude Code 2.1.296 sends it, for the heredoc a PreToolUse validator asks about.
const recordedPermissionInput = `{"session_id":"abc123","transcript_path":"/Users/me/.claude/projects/x/abc123.jsonl",` +
	`"cwd":"/Users/me/work/app","permission_mode":"default","hook_event_name":"PermissionRequest","tool_name":"Bash",` +
	`"tool_input":{"command":"cat > /tmp/x.md <<'EOF'\nhi\nEOF","description":"Write the note"},` +
	`"permission_suggestions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"cat:*"}],"behavior":"allow","destination":"localSettings"}]}`

func TestAgentPermissionPrintsOnlyAnAllow(t *testing.T) {
	var sent keepawake.PermissionRequest
	allow := func(req keepawake.PermissionRequest) (keepawake.PermissionAnswer, error) {
		sent = req
		return keepawake.PermissionAnswer{Decision: keepawake.PermissionAllow}, nil
	}
	var out bytes.Buffer
	runAgentPermission(strings.NewReader(recordedPermissionInput), &out, "block-1", "claude", allow)
	var parsed map[string]any
	if err := json.Unmarshal(out.Bytes(), &parsed); err != nil {
		t.Fatalf("output %q: %v", out.String(), err)
	}
	want := `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` + "\n"
	if out.String() != want {
		t.Fatalf("output %q, want %q", out.String(), want)
	}
	if sent.BlockId != "block-1" || sent.Agent != "claude" || sent.SessionId != "abc123" || sent.Cwd != "/Users/me/work/app" ||
		sent.ToolName != "Bash" || !strings.Contains(sent.ToolInput["command"].(string), "<<'EOF'") {
		t.Fatalf("sent %+v", sent)
	}

	cases := map[string]func(keepawake.PermissionRequest) (keepawake.PermissionAnswer, error){
		"no decision": func(keepawake.PermissionRequest) (keepawake.PermissionAnswer, error) {
			return keepawake.PermissionAnswer{Reason: "deny list"}, nil
		},
		"error": func(keepawake.PermissionRequest) (keepawake.PermissionAnswer, error) {
			return keepawake.PermissionAnswer{Decision: keepawake.PermissionAllow}, errors.New("timeout")
		},
	}
	for name, send := range cases {
		out.Reset()
		runAgentPermission(strings.NewReader(recordedPermissionInput), &out, "block-1", "claude", send)
		if out.Len() != 0 {
			t.Errorf("%s: printed %q", name, out.String())
		}
	}
	for name, input := range map[string]string{"not json": "nope", "no tool": `{"cwd":"/x"}`, "too large": strings.Repeat(" ", moltenAgentPermissionMaxStdin+1)} {
		called := false
		out.Reset()
		runAgentPermission(strings.NewReader(input), &out, "block-1", "claude", func(keepawake.PermissionRequest) (keepawake.PermissionAnswer, error) {
			called = true
			return keepawake.PermissionAnswer{Decision: keepawake.PermissionAllow}, nil
		})
		if called || out.Len() != 0 {
			t.Errorf("%s: sent %v, printed %q", name, called, out.String())
		}
	}
	out.Reset()
	runAgentPermission(strings.NewReader(recordedPermissionInput), &out, "", "claude", allow)
	if out.Len() != 0 {
		t.Fatal("outside a terminal nothing is sent")
	}
}

// #988, FR-SHELL-064 AC5: a request the hook leaves to the developer turns the pane waiting (Codex has no
// Notification event); an approved one, or an input that is no request, does not.
func TestAgentPermissionReportsWaiting(t *testing.T) {
	var waits []string
	previous := reportPermissionWaiting
	reportPermissionWaiting = func(blockId string, agent string) { waits = append(waits, blockId+"/"+agent) }
	t.Cleanup(func() { reportPermissionWaiting = previous })
	var out bytes.Buffer
	answer := func(decision string, err error) func(keepawake.PermissionRequest) (keepawake.PermissionAnswer, error) {
		return func(keepawake.PermissionRequest) (keepawake.PermissionAnswer, error) {
			return keepawake.PermissionAnswer{Decision: decision}, err
		}
	}
	runAgentPermission(strings.NewReader(recordedPermissionInput), &out, "block-1", "codex", answer("", nil))
	runAgentPermission(strings.NewReader(recordedPermissionInput), &out, "block-1", "claude", answer(keepawake.PermissionAllow, errors.New("timeout")))
	runAgentPermission(strings.NewReader(recordedPermissionInput), &out, "block-1", "codex", answer(keepawake.PermissionAllow, nil))
	runAgentPermission(strings.NewReader("nope"), &out, "block-1", "codex", answer("", nil))
	if strings.Join(waits, ",") != "block-1/codex,block-1/claude" {
		t.Fatalf("waiting reports %v", waits)
	}
}

// #2257: Brokk's own session answers in his layer: a deny with its reason, an "always allow" with the agent's own
// suggested rules, and the hook may wait for the developer as long as its budget allows.
func TestAgentPermissionPrintsTheDevelopersAnswer(t *testing.T) {
	var sent keepawake.PermissionRequest
	var out bytes.Buffer
	runAgentPermission(strings.NewReader(recordedPermissionInput), &out, "block-1", "claude", func(req keepawake.PermissionRequest) (keepawake.PermissionAnswer, error) {
		sent = req
		return keepawake.PermissionAnswer{Decision: keepawake.PermissionDeny, Message: "denied in MoltenTerm"}, nil
	})
	if out.String() != `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"denied in MoltenTerm"}}}`+"\n" {
		t.Fatalf("deny printed %q", out.String())
	}
	if len(sent.Suggestions) != 1 {
		t.Fatalf("the agent's suggestions were not sent: %+v", sent.Suggestions)
	}
	// #2474: any terminal's request may be held for the companion, within the hook's budget; wavesrv decides.
	if want := permissionHoldMs("claude", false); sent.HoldMs != want || want <= 0 || want >= int64(molten.ClaudePermissionHookTimeout)*1000 {
		t.Fatalf("a terminal's request asked to be held %d ms, want %d", sent.HoldMs, want)
	}
	out.Reset()
	runAgentPermission(strings.NewReader(recordedPermissionInput), &out, "block-1", "claude", func(req keepawake.PermissionRequest) (keepawake.PermissionAnswer, error) {
		return keepawake.PermissionAnswer{Decision: keepawake.PermissionAllow, Updated: req.Suggestions}, nil
	})
	if !strings.Contains(out.String(), `"behavior":"allow","updatedPermissions":[{"behavior":"allow","destination":"localSettings","rules":[{"ruleContent":"cat:*","toolName":"Bash"}],"type":"addRules"}]`) {
		t.Fatalf("always allow printed %q", out.String())
	}
	// His own session may wait for the developer; the hold always leaves the hook time to print before its agent kills
	// it. Any other terminal is answered at once.
	if h := permissionHoldMs("claude", true); h < 60_000 || h >= int64(molten.ClaudeOwnSessionPermissionHookTimeout)*1000 {
		t.Fatalf("his Claude Code session holds %d ms", h)
	}
	if h := permissionHoldMs("codex", true); h <= 0 || h >= int64(molten.CodexPermissionHookTimeout)*1000 {
		t.Fatalf("his Codex session holds %d ms", h)
	}
	// #2474: another terminal's hook holds for the companion's grace delay (2 minutes) and leaves the margin; Codex's
	// hook definition is fixed by the developer's trust, so its budget stays the short one.
	if h := permissionHoldMs("claude", false); h < int64(keepawake.GateGrace/time.Millisecond) || h >= int64(molten.ClaudePermissionHookTimeout)*1000 {
		t.Fatalf("another terminal's Claude Code hook holds %d ms, its grace is %v", h, keepawake.GateGrace)
	}
	if h := permissionHoldMs("codex", false); h <= 0 || h >= int64(molten.CodexPermissionHookTimeout)*1000 {
		t.Fatalf("another terminal's Codex hook holds %d ms", h)
	}
	if permissionHoldMs("", false) != 0 || permissionHoldMs("kimi", false) != 0 {
		t.Fatal("a request of an agent MoltenTerm does not answer is held")
	}
	if molten.CodexPermissionHookTimeout != 15 {
		t.Fatalf("Codex's hook budget changed to %d s: the developer would have to trust it again in /hooks", molten.CodexPermissionHookTimeout)
	}
}

// #2382: the developer's answers to a question of Brokk's agent go back as the hook's allow with the tool's updated
// input; a deny never carries an input.
func TestAgentPermissionPrintsTheAnswersToAQuestion(t *testing.T) {
	input := `{"session_id":"abc123","cwd":"/Users/me/brokk","hook_event_name":"PermissionRequest","tool_name":"AskUserQuestion",` +
		`"tool_input":{"questions":[{"question":"Where are the projects?","header":"Folder","options":[{"label":"Documents","description":"the usual place"},{"label":"Elsewhere","description":"another folder"}],"multiSelect":false}]}}`
	var out bytes.Buffer
	runAgentPermission(strings.NewReader(input), &out, "block-1", "claude", func(req keepawake.PermissionRequest) (keepawake.PermissionAnswer, error) {
		updated := map[string]any{"questions": req.ToolInput["questions"], "answers": map[string]any{"Where are the projects?": "Documents"}}
		return keepawake.PermissionAnswer{Decision: keepawake.PermissionAllow, Input: updated}, nil
	})
	var parsed struct {
		HookSpecificOutput struct {
			Decision struct {
				Behavior     string         `json:"behavior"`
				UpdatedInput map[string]any `json:"updatedInput"`
			} `json:"decision"`
		} `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal(out.Bytes(), &parsed); err != nil {
		t.Fatalf("output %q: %v", out.String(), err)
	}
	decision := parsed.HookSpecificOutput.Decision
	answers, _ := decision.UpdatedInput["answers"].(map[string]any)
	if decision.Behavior != "allow" || answers["Where are the projects?"] != "Documents" || decision.UpdatedInput["questions"] == nil {
		t.Fatalf("printed %q", out.String())
	}
	out.Reset()
	runAgentPermission(strings.NewReader(input), &out, "block-1", "claude", func(req keepawake.PermissionRequest) (keepawake.PermissionAnswer, error) {
		return keepawake.PermissionAnswer{Decision: keepawake.PermissionDeny, Message: "no", Input: map[string]any{"x": 1}}, nil
	})
	if strings.Contains(out.String(), "updatedInput") {
		t.Fatalf("a deny printed an input: %q", out.String())
	}
}

// FR-SHELL-064: Codex's PermissionRequest input (its documented fields, an apply_patch) gets the same answer, in the
// output shape Codex documents.
func TestAgentPermissionCodexInput(t *testing.T) {
	input := `{"session_id":"019a-thread","transcript_path":null,"cwd":"/Users/me/work/app","hook_event_name":"PermissionRequest",` +
		`"model":"gpt-5.4","permission_mode":"default","turn_id":"t-3","tool_name":"apply_patch",` +
		`"tool_input":{"command":"*** Begin Patch\n*** Update File: src/a.go\n@@\n-a\n+b\n*** End Patch","description":null}}`
	var sent keepawake.PermissionRequest
	var out bytes.Buffer
	runAgentPermission(strings.NewReader(input), &out, "block-2", "codex", func(req keepawake.PermissionRequest) (keepawake.PermissionAnswer, error) {
		sent = req
		return keepawake.PermissionAnswer{Decision: keepawake.PermissionAllow}, nil
	})
	if out.String() != `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`+"\n" {
		t.Fatalf("output %q", out.String())
	}
	if sent.Agent != "codex" || sent.SessionId != "019a-thread" || sent.ToolName != "apply_patch" || !strings.Contains(sent.ToolInput["command"].(string), "Update File: src/a.go") {
		t.Fatalf("sent %+v", sent)
	}
}

type recordedPermissionCall struct {
	command   string
	data      any
	timeoutMs int64
}

// The review of #2474 (PR #2479): a request that is not held is answered within the short time a hook always had,
// however long the hook is willing to wait, so that a slow wavesrv never costs the agent more than that.
func TestAgentPermissionAsksWithTheShortTimeoutUnlessHeld(t *testing.T) {
	req, ok := readPermissionRequest(strings.NewReader(recordedPermissionInput), "block-1", "claude")
	if !ok || req.HoldMs <= 0 || req.Pid <= 0 {
		t.Fatalf("request %+v", req)
	}
	var calls []recordedPermissionCall
	notHeld := func(command string, data any, timeoutMs int64) (keepawake.PermissionAnswer, error) {
		calls = append(calls, recordedPermissionCall{command, data, timeoutMs})
		return keepawake.PermissionAnswer{}, nil
	}
	if _, err := exchangePermission(notHeld, req, false); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 1 || calls[0].command != keepawake.PermissionCommand || calls[0].timeoutMs != moltenAgentPermissionTimeoutMs {
		t.Fatalf("a request that is not held was asked with %+v", calls)
	}
}

// A held request is awaited in a second call, for what wavesrv said at most, plus the reply margin; the hook never waits
// past its own budget.
func TestAgentPermissionAwaitsAHeldRequestInASecondCall(t *testing.T) {
	req, _ := readPermissionRequest(strings.NewReader(recordedPermissionInput), "block-1", "claude")
	var calls []recordedPermissionCall
	call := func(command string, data any, timeoutMs int64) (keepawake.PermissionAnswer, error) {
		calls = append(calls, recordedPermissionCall{command, data, timeoutMs})
		if command == keepawake.PermissionCommand {
			return keepawake.PermissionAnswer{Wait: "req-1", WaitMs: 90_000}, nil
		}
		return keepawake.PermissionAnswer{Decision: keepawake.PermissionAllow}, nil
	}
	answer, err := exchangePermission(call, req, false)
	if err != nil || answer.Decision != keepawake.PermissionAllow {
		t.Fatalf("answer %+v, %v", answer, err)
	}
	if len(calls) != 2 || calls[0].timeoutMs != moltenAgentPermissionTimeoutMs {
		t.Fatalf("calls %+v", calls)
	}
	wait, isWait := calls[1].data.(keepawake.PermissionWait)
	if calls[1].command != keepawake.PermissionWaitCommand || !isWait || wait.Id != "req-1" || wait.BlockId != "block-1" ||
		calls[1].timeoutMs != 90_000+moltenAgentPermissionReplyMs {
		t.Fatalf("the second call %+v", calls[1])
	}

	calls = nil
	tooLong := func(command string, data any, timeoutMs int64) (keepawake.PermissionAnswer, error) {
		calls = append(calls, recordedPermissionCall{command, data, timeoutMs})
		return keepawake.PermissionAnswer{Wait: "req-2", WaitMs: 10 * req.HoldMs}, nil
	}
	exchangePermission(tooLong, req, false)
	if len(calls) != 2 || calls[1].timeoutMs != req.HoldMs+moltenAgentPermissionReplyMs {
		t.Fatalf("the hook waits past its own budget: %+v", calls)
	}

	calls = nil
	noTime := func(command string, data any, timeoutMs int64) (keepawake.PermissionAnswer, error) {
		calls = append(calls, recordedPermissionCall{command, data, timeoutMs})
		return keepawake.PermissionAnswer{Wait: "req-3", WaitMs: 0}, nil
	}
	if answer, err := exchangePermission(noTime, req, false); err != nil || answer.Decision != "" || len(calls) != 1 {
		t.Fatalf("a request with no time left: %+v %v, %d calls", answer, err, len(calls))
	}

	failing := func(command string, data any, timeoutMs int64) (keepawake.PermissionAnswer, error) {
		if command == keepawake.PermissionWaitCommand {
			return keepawake.PermissionAnswer{}, errors.New("timeout")
		}
		return keepawake.PermissionAnswer{Wait: "req-4", WaitMs: 1000}, nil
	}
	if _, err := exchangePermission(failing, req, false); err == nil {
		t.Fatal("a wait that failed is not told: the pane would not show the agent waiting")
	}
}

// Brokk's own session asks in one call that waits for his answer, with the long timeout: his layer answers it, not the
// companion.
func TestAgentPermissionOwnSessionAsksInOneLongCall(t *testing.T) {
	req := keepawake.PermissionRequest{BlockId: "block-1", Agent: "claude", ToolName: "Bash", HoldMs: permissionHoldMs("claude", true)}
	var calls []recordedPermissionCall
	call := func(command string, data any, timeoutMs int64) (keepawake.PermissionAnswer, error) {
		calls = append(calls, recordedPermissionCall{command, data, timeoutMs})
		return keepawake.PermissionAnswer{Decision: keepawake.PermissionAllow}, nil
	}
	if answer, err := exchangePermission(call, req, true); err != nil || answer.Decision != keepawake.PermissionAllow {
		t.Fatalf("answer %+v, %v", answer, err)
	}
	if len(calls) != 1 || calls[0].timeoutMs != req.HoldMs+moltenAgentPermissionReplyMs {
		t.Fatalf("calls %+v", calls)
	}
}
