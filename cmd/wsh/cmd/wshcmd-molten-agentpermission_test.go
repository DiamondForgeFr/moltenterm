// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"

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
	// Review: outside Brokk's own session nothing waits for a human (this terminal is not his).
	if sent.HoldMs != 0 {
		t.Fatalf("a terminal that is not his own session asked to be held %d ms", sent.HoldMs)
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
	if permissionHoldMs("claude", false) != 0 || permissionHoldMs("codex", false) != 0 {
		t.Fatal("another terminal's request is held")
	}
	if molten.ClaudePermissionHookTimeout != 15 {
		t.Fatalf("every terminal's hook budget is %d s", molten.ClaudePermissionHookTimeout)
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
