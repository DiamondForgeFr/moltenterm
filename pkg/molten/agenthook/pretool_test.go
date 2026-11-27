// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agenthook

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

// A PreToolUse input as Claude Code 2.1.x sends it for a Bash call; agentId "" is the lead's (no agent_id field).
func preToolUseInput(agentId string, command string) string {
	fields := map[string]any{
		"session_id": "11111111-2222-3333-4444-555555555555", "transcript_path": "/sessions/lead.jsonl",
		"cwd": "/work", "permission_mode": "default", "hook_event_name": "PreToolUse", "tool_name": "Bash",
		"tool_input":  map[string]any{"command": command, "description": "Publish the plan", "timeout": 120000},
		"tool_use_id": "toolu_01ABC",
	}
	if agentId != "" {
		fields["agent_id"], fields["agent_type"] = agentId, "sf-fix"
	}
	data, _ := json.Marshal(fields)
	return string(data)
}

func TestSubagentPlanCommandNamesTheSubagent(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		`molten agent plan set "Read" "Write"`:               `molten agent plan set --subagent a1b2 "Read" "Write"`,
		`molten agent plan done 3`:                           `molten agent plan done --subagent a1b2 3`,
		`molten agent plan`:                                  `molten agent plan --subagent a1b2`,
		`git status && molten  agent plan start 2 | cat`:     `git status && molten  agent plan start --subagent a1b2 2 | cat`,
		`/opt/bin/molten agent plan show --json`:             `/opt/bin/molten agent plan show --subagent a1b2 --json`,
		`molten agent plan add x; molten agent plan done 1`:  `molten agent plan add --subagent a1b2 x; molten agent plan done --subagent a1b2 1`,
		`molten agent plan settle`:                           `molten agent plan --subagent a1b2 settle`,
		"molten agent plan done --subagent a1b2 1":           "",
		"molten agent plan done --subagent=other 1":          "",
		`molten agent state working`:                         "",
		`echo molten agent planner`:                          "",
		`xmolten agent plan done 1`:                          "",
		`git commit -m "fix" && molten agent session --show`: "",
	}
	for command, want := range cases {
		got, changed := SubagentPlanCommand(command, "a1b2")
		if want == "" {
			if changed || got != command {
				t.Errorf("%q changed to %q", command, got)
			}
			continue
		}
		if !changed || got != want {
			t.Errorf("%q\n got %q\nwant %q", command, got, want)
		}
	}
}

// The id goes into a shell command: anything but letters, digits, dashes and underscores is refused.
func TestSubagentPlanCommandRefusesAnUnsafeId(t *testing.T) {
	t.Parallel()
	for _, id := range []string{"", "a b", "a;rm -rf x", "$(id)", "a`b`", strings.Repeat("a", maxSubagentId+1)} {
		if got, changed := SubagentPlanCommand("molten agent plan done 1", id); changed || got != "molten agent plan done 1" {
			t.Errorf("id %q changed the command to %q", id, got)
		}
	}
}

func TestPreToolUseOutputHandsBackTheSubagentsCall(t *testing.T) {
	t.Parallel()
	input := ReadHookInput(strings.NewReader(preToolUseInput("a4e95569a24e07cb3", `molten agent plan set "Read the ticket"`)))
	out, ok := PreToolUseOutput(input)
	if !ok {
		t.Fatal("a sub-agent's plan call was not changed")
	}
	var parsed struct {
		HookSpecificOutput struct {
			HookEventName      string         `json:"hookEventName"`
			PermissionDecision string         `json:"permissionDecision"`
			UpdatedInput       map[string]any `json:"updatedInput"`
		} `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatalf("output %s: %v", out, err)
	}
	h := parsed.HookSpecificOutput
	if h.HookEventName != "PreToolUse" || h.PermissionDecision != "" {
		t.Fatalf("output %s", out)
	}
	if h.UpdatedInput["command"] != `molten agent plan set --subagent a4e95569a24e07cb3 "Read the ticket"` {
		t.Fatalf("command = %v", h.UpdatedInput["command"])
	}
	// updatedInput replaces the whole input: the other fields come back as they were.
	if h.UpdatedInput["description"] != "Publish the plan" || h.UpdatedInput["timeout"] != float64(120000) {
		t.Fatalf("the other fields were lost: %v", h.UpdatedInput)
	}
}

func TestPreToolUseOutputLeavesTheLeadAndOtherCallsAlone(t *testing.T) {
	t.Parallel()
	inputs := map[string]string{
		"the lead's plan call":          preToolUseInput("", "molten agent plan done 3"),
		"a sub-agent's other command":   preToolUseInput("a4e9", "go test ./pkg/..."),
		"another tool":                  strings.Replace(preToolUseInput("a4e9", "molten agent plan done 3"), `"tool_name":"Bash"`, `"tool_name":"Monitor"`, 1),
		"another event":                 strings.Replace(preToolUseInput("a4e9", "molten agent plan done 3"), `"PreToolUse"`, `"PostToolUse"`, 1),
		"a sub-agent with an unsafe id": preToolUseInput("a;b", "molten agent plan done 3"),
	}
	for name, raw := range inputs {
		if out, ok := PreToolUseOutput(ReadHookInput(strings.NewReader(raw))); ok {
			t.Errorf("%s: printed %s", name, out)
		}
	}
}

// The hook answers a PreToolUse itself: it prints the changed call and reports nothing to wavesrv.
func TestRunHookAnswersAPreToolUseWithoutReporting(t *testing.T) {
	t.Parallel()
	var stdout, stderr bytes.Buffer
	env := Env{
		Getenv: func(key string) string {
			return map[string]string{"WAVETERM_JWT": "not-a-jwt", "WAVETERM_BLOCKID": "block-1"}[key]
		},
		Stdin:  strings.NewReader(preToolUseInput("a4e9", "molten agent plan done 2")),
		Stdout: &stdout, Stderr: &stderr,
	}
	handled, code := runHook(HookArgs{Agent: "claude"}, env)
	if !handled || code != 0 || stderr.Len() != 0 {
		t.Fatalf("handled %v, code %d, stderr %q", handled, code, stderr.String())
	}
	if !strings.Contains(stdout.String(), `molten agent plan done --subagent a4e9 2`) {
		t.Fatalf("stdout %q", stdout.String())
	}
	stdout.Reset()
	env.Stdin = strings.NewReader(preToolUseInput("", "molten agent plan done 2"))
	if handled, code := runHook(HookArgs{Agent: "claude"}, env); !handled || code != 0 || stdout.Len() != 0 {
		t.Fatalf("the lead's call: handled %v, code %d, stdout %q", handled, code, stdout.String())
	}
}
