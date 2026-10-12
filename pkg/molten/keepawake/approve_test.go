// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package keepawake

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// TC-SHELL-130: the approval follows the coffee, its grace included, and ends with it.
func TestApprovalFollowsTheCoffee(t *testing.T) {
	f := makeFakeEnv()
	k := f.keeper()
	ctx := context.Background()
	check := bash("go test ./...")
	decide := func(ws string) string {
		answer, _, _ := DecidePermission(k.HasCoffee(ws), check)
		return answer.Decision
	}
	if decide("ws-a") != "" {
		t.Fatal("coffee off: no answer")
	}
	f.work.Workspaces["ws-a"] = true
	k.SetCoffee(ctx, "ws-a", true)
	if decide("ws-a") != PermissionAllow || decide("ws-b") != "" {
		t.Fatal("coffee on: allow for its own workspace only")
	}
	f.work.Workspaces = map[string]bool{}
	f.advance(time.Second)
	k.Evaluate(ctx)
	if decide("ws-a") != PermissionAllow {
		t.Fatal("in its grace the coffee still holds")
	}
	f.advance(GracePeriod)
	k.Evaluate(ctx)
	if decide("ws-a") != "" {
		t.Fatal("coffee ended: no answer")
	}
	k.SetCoffee(ctx, "ws-a", true)
	k.SetCoffee(ctx, "ws-a", false)
	if decide("ws-a") != "" {
		t.Fatal("coffee turned off: no answer")
	}
}

func TestDecidePermission(t *testing.T) {
	if answer, outcome, logged := DecidePermission(false, bash("rm -rf ~/x")); answer.Decision != "" || logged || outcome != "" {
		t.Fatalf("no coffee: nothing at all, got %+v %s %v", answer, outcome, logged)
	}
	answer, outcome, logged := DecidePermission(true, bash("rm -rf ~/x"))
	if answer.Decision != "" || outcome != ApprovalAsked || !logged || !strings.HasPrefix(answer.Reason, reasonRemove) {
		t.Fatalf("deny list: %+v %s %v", answer, outcome, logged)
	}
	// The heredoc a PreToolUse validator answers with "ask" (TC-SHELL-131).
	heredoc := "cat > /tmp/mtauto/x.md <<'EOF'\n## Plan\nIt's done.\nEOF"
	if answer, outcome, _ := DecidePermission(true, bash(heredoc)); answer.Decision != PermissionAllow || outcome != ApprovalApproved {
		t.Fatalf("heredoc: %+v %s", answer, outcome)
	}
}

func TestApprovalsKeptNewestFirstAndCapped(t *testing.T) {
	f := makeFakeEnv()
	var logged []Approval
	env := f.keeper().env
	env.LogApproval = func(a Approval) { logged = append(logged, a) }
	k := MakeKeeper(env)
	for i := 0; i < MaxApprovals+5; i++ {
		k.RecordApproval(Approval{BlockId: "b", Tool: "Bash", Detail: string(rune('a' + i%26)), Outcome: ApprovalApproved})
	}
	state := k.State()
	if len(state.Approvals) != MaxApprovals || len(logged) != MaxApprovals+5 {
		t.Fatalf("kept %d, logged %d", len(state.Approvals), len(logged))
	}
	if state.Approvals[0].Id != logged[len(logged)-1].Id || state.Approvals[0].At != f.now.UnixMilli() {
		t.Fatalf("newest first: %+v", state.Approvals[0])
	}
	if len(f.published) == 0 || len(f.published[len(f.published)-1].Approvals) != MaxApprovals {
		t.Fatal("each approval is published")
	}
}

func TestSessionsListedForCoffeesOnly(t *testing.T) {
	f := makeFakeEnv()
	env := f.keeper().env
	env.Sessions = func(ctx context.Context, wsIds []string) []AutoApproveSession {
		var rtn []AutoApproveSession
		for _, ws := range wsIds {
			rtn = append(rtn, AutoApproveSession{WorkspaceId: ws, BlockId: "b-" + ws, Agent: "claude", Approved: true})
		}
		return append(rtn, AutoApproveSession{WorkspaceId: "ws-b", BlockId: "b-other", Agent: "codex"})
	}
	k := MakeKeeper(env)
	ctx := context.Background()
	k.Evaluate(ctx)
	if got := k.State().AutoApprove; len(got) != 0 {
		t.Fatalf("no coffee, no sessions: %+v", got)
	}
	f.work.Workspaces["ws-a"] = true
	k.SetCoffee(ctx, "ws-a", true)
	got := k.State().AutoApprove
	if len(got) != 1 || got[0].BlockId != "b-ws-a" {
		t.Fatalf("only the coffee's workspace: %+v", got)
	}
	k.SetCoffee(ctx, "ws-a", false)
	if got := k.State().AutoApprove; len(got) != 0 {
		t.Fatalf("coffee off: %+v", got)
	}
}

// AC6: which sessions are approved, and why not.
func TestSessionApproval(t *testing.T) {
	added := molten.AgentIntegrationReport{Added: []molten.IntegrationItem{{Kind: molten.IntegrationCoffeeApproval}}}
	old := molten.AgentIntegrationReport{Added: []molten.IntegrationItem{{Kind: molten.IntegrationStateHooks}}}
	managed := molten.AgentIntegrationReport{Skipped: []molten.IntegrationItem{{Kind: molten.IntegrationCoffeeApproval, Reason: "managed only"}}}
	cases := []struct {
		agent     string
		remote    bool
		report    molten.AgentIntegrationReport
		hasReport bool
		hookRan   bool
		approved  bool
		reason    string
	}{
		{"claude", false, added, true, false, true, ""},
		{"claude", true, added, true, false, false, "remote"},
		{"claude", false, molten.AgentIntegrationReport{}, false, false, false, "outside MoltenTerm's launcher"},
		{"claude", false, old, true, false, false, "restart it"},
		{"claude", false, managed, true, false, false, "managed only"},
		// FR-SHELL-064-AC3: Codex asks until its hook ran once, the sign the developer trusted it in /hooks.
		{"codex", false, added, true, false, false, "/hooks"},
		{"codex", false, added, true, true, true, ""},
		{"codex", false, managed, true, true, false, "managed only"},
		{"codex", false, molten.AgentIntegrationReport{}, false, true, false, "outside MoltenTerm's launcher"},
		{"gemini", false, molten.AgentIntegrationReport{}, false, false, false, "cannot answer"},
	}
	for _, tc := range cases {
		approved, reason := SessionApproval(tc.agent, tc.remote, tc.report, tc.hasReport, tc.hookRan)
		if approved != tc.approved || !strings.Contains(reason, tc.reason) {
			t.Errorf("%s remote=%v: %v %q, want %v %q", tc.agent, tc.remote, approved, reason, tc.approved, tc.reason)
		}
	}
}

func TestApprovalDetail(t *testing.T) {
	if got := approvalDetail(PermissionRequest{ToolInput: map[string]any{"command": "ls", "description": "x"}}); got != "ls" {
		t.Fatalf("command: %q", got)
	}
	if got := approvalDetail(PermissionRequest{ToolInput: map[string]any{"file_path": "/a"}}); got != "/a" {
		t.Fatalf("path: %q", got)
	}
	if got := approvalDetail(PermissionRequest{ToolInput: map[string]any{"q": 1}}); got != `{"q":1}` {
		t.Fatalf("input: %q", got)
	}
	long := approvalDetail(PermissionRequest{ToolInput: map[string]any{"command": strings.Repeat("x", 500)}})
	if len(long) > maxApprovalDetail+len("…") {
		t.Fatalf("clipped: %d", len(long))
	}
}

func TestApprovalLogAppendsAndRotates(t *testing.T) {
	dir := t.TempDir()
	l := makeApprovalLog(dir)
	for i := 0; i < 3; i++ {
		if err := l.append(Approval{Id: "p", BlockId: "b", Tool: "Bash", Outcome: ApprovalApproved}); err != nil {
			t.Fatal(err)
		}
	}
	path := filepath.Join(dir, ApprovalLogDir, ApprovalLogFile)
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	lines := 0
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		var a Approval
		if json.Unmarshal(scanner.Bytes(), &a) != nil || a.Outcome != ApprovalApproved {
			t.Fatalf("line %q", scanner.Text())
		}
		lines++
	}
	f.Close()
	if lines != 3 {
		t.Fatalf("%d lines", lines)
	}
	if err := os.WriteFile(path, make([]byte, maxApprovalLogBytes), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := l.append(Approval{Id: "q", BlockId: "b", Tool: "Read", Outcome: ApprovalAsked}); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(path + ".1"); err != nil || info.Size() != maxApprovalLogBytes {
		t.Fatalf("rotated: %v", err)
	}
	if data, _ := os.ReadFile(path); !strings.Contains(string(data), `"id":"q"`) || strings.Count(string(data), "\n") != 1 {
		t.Fatalf("new file: %q", data)
	}
}
