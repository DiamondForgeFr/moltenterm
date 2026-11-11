// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brokksession

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/keepawake"
)

// fakePermits is a broker over a fake agent: its own terminal is "brokk-1", ids count up, the clock stands still.
type fakePermits struct {
	lock  sync.Mutex
	auto  bool
	moved bool
	n     int
}

func (f *fakePermits) broker() *PermitBroker {
	return MakePermitBroker(PermitEnv{
		IsOwn: func(_ context.Context, blockId string) bool { return blockId == "brokk-1" },
		AutoApprove: func() bool {
			f.lock.Lock()
			defer f.lock.Unlock()
			return f.auto
		},
		Guard: func(ask PermissionAsk) string {
			return GuardReason(ask, PermitGuardEnv{Home: "/home/dev", DataDirs: []string{"/home/dev/.molten/data"}, OwnFolder: "/home/dev/.molten/data/brokk"})
		},
		Moved: func(string, int64) bool {
			f.lock.Lock()
			defer f.lock.Unlock()
			return f.moved
		},
		NewId: func() string {
			f.lock.Lock()
			defer f.lock.Unlock()
			f.n++
			return fmt.Sprintf("req-%d", f.n)
		},
		Now: func() time.Time { return time.UnixMilli(1_000_000) },
	})
}

func bashRequest(command string) keepawake.PermissionRequest {
	return keepawake.PermissionRequest{
		BlockId: "brokk-1", FromBlock: true, Agent: "claude", ToolName: "Bash",
		ToolInput: map[string]any{"command": command, "description": "synthetic"},
	}
}

type asked struct {
	answer  keepawake.PermissionAnswer
	handled bool
}

// ask runs a request in the background, as the hook's call does, and waits until the broker keeps it.
func ask(t *testing.T, b *PermitBroker, ctx context.Context, req keepawake.PermissionRequest) (<-chan asked, *PermissionAsk) {
	t.Helper()
	before := b.Pending(req.BlockId)
	done := make(chan asked, 1)
	go func() {
		answer, handled := b.Ask(ctx, req)
		done <- asked{answer, handled}
	}()
	deadline := time.Now().Add(time.Minute)
	for {
		if p := b.Pending(req.BlockId); p != nil && (before == nil || p.Id != before.Id) {
			return done, p
		}
		select {
		case got := <-done:
			done <- got
			return done, nil
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("the request was never kept")
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func waitAsked(t *testing.T, done <-chan asked) asked {
	t.Helper()
	select {
	case got := <-done:
		return got
	case <-time.After(time.Minute):
		t.Fatal("the request never ended")
		return asked{}
	}
}

// #2257: his agent's request waits for the developer's answer in his layer, and the hook gets that answer.
func TestAPermissionRequestWaitsForTheDevelopersAnswer(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		decision string
		want     string
	}{
		{PermitAllow, keepawake.PermissionAllow},
		{PermitDeny, keepawake.PermissionDeny},
	} {
		f := &fakePermits{}
		b := f.broker()
		done, p := ask(t, b, context.Background(), bashRequest("ls -la"))
		if p == nil || p.Kind != PermitKindCommand || p.Subject != "ls -la" || p.Always {
			t.Fatalf("kept %+v", p)
		}
		if got := b.Answer(PermitRequest{Id: p.Id, BlockId: "brokk-1", Decision: tc.decision}); got.Status != PermitAnswered {
			t.Fatalf("%s: answered %+v", tc.decision, got)
		}
		got := waitAsked(t, done)
		if !got.handled || got.answer.Decision != tc.want {
			t.Fatalf("%s: the hook got %+v", tc.decision, got)
		}
		if tc.decision == PermitDeny && got.answer.Message == "" {
			t.Error("a deny tells the agent why")
		}
		if b.Pending("brokk-1") != nil {
			t.Error("an answered request is still kept")
		}
	}
}

// #2257: an answer counts only for the request waiting under its id in its terminal: a wrong id, another terminal,
// an answer given twice or after the request ended are gone, and nothing reaches a newer request.
func TestAnAnswerReachesOnlyItsOwnRequest(t *testing.T) {
	t.Parallel()
	f := &fakePermits{}
	b := f.broker()
	done, p := ask(t, b, context.Background(), bashRequest("make test"))
	for _, wrong := range []PermitRequest{
		{Id: "req-999", BlockId: "brokk-1", Decision: PermitAllow},
		{Id: p.Id, BlockId: "other-block", Decision: PermitAllow},
		{Id: "", BlockId: "brokk-1", Decision: PermitAllow},
		{Id: p.Id, BlockId: "brokk-1", Decision: PermitAlways},
		{Id: p.Id, BlockId: "brokk-1", Decision: "maybe"},
	} {
		if got := b.Answer(wrong); got.Status == PermitAnswered {
			t.Fatalf("%+v reached the request", wrong)
		}
	}
	// A newer request of the same agent: the older one was answered in his terminal.
	done2, p2 := ask(t, b, context.Background(), bashRequest("make build"))
	if got := waitAsked(t, done); !got.handled || got.answer.Decision != "" {
		t.Fatalf("the older request got %+v, want it left to his agent's prompt", got)
	}
	if got := b.Answer(PermitRequest{Id: p.Id, BlockId: "brokk-1", Decision: PermitAllow}); got.Status != PermitGone {
		t.Fatalf("an answer to the older request: %+v", got)
	}
	if b.Pending("brokk-1").Id != p2.Id {
		t.Fatal("the newer request was lost")
	}
	b.Answer(PermitRequest{Id: p2.Id, BlockId: "brokk-1", Decision: PermitDeny})
	if got := waitAsked(t, done2); got.answer.Decision != keepawake.PermissionDeny {
		t.Fatalf("the newer request got %+v", got)
	}
	if got := b.Answer(PermitRequest{Id: p2.Id, BlockId: "brokk-1", Decision: PermitAllow}); got.Status != PermitGone {
		t.Fatalf("an answer given twice: %+v", got)
	}
}

// #2257: when the hook gives up (its budget, a restart of wavesrv) or his agent went on (answered in his terminal),
// the request is over: the hook prints nothing, and a late answer reaches nothing.
func TestARequestEndsWithItsHookOrWhenHisAgentGoesOn(t *testing.T) {
	t.Parallel()
	f := &fakePermits{}
	b := f.broker()
	ctx, cancel := context.WithCancel(context.Background())
	done, p := ask(t, b, ctx, bashRequest("git status"))
	cancel()
	if got := waitAsked(t, done); !got.handled || got.answer.Decision != "" {
		t.Fatalf("a hook that gave up got %+v", got)
	}
	if got := b.Answer(PermitRequest{Id: p.Id, BlockId: "brokk-1", Decision: PermitAllow}); got.Status != PermitGone {
		t.Fatalf("a late answer: %+v", got)
	}
	g := &fakePermits{}
	b = g.broker()
	done, p = ask(t, b, context.Background(), bashRequest("git status"))
	g.lock.Lock()
	g.moved = true
	g.lock.Unlock()
	if got := waitAsked(t, done); got.answer.Decision != "" {
		t.Fatalf("a request answered in his terminal got %+v", got)
	}
	if got := b.Answer(PermitRequest{Id: p.Id, BlockId: "brokk-1", Decision: PermitAllow}); got.Status != PermitGone {
		t.Fatalf("an answer after his agent went on: %+v", got)
	}
}

// #2257: "always allow" exists only when his agent offers it, and gives back its own suggested rules.
func TestAlwaysAllowOnlyWhenHisAgentOffersIt(t *testing.T) {
	t.Parallel()
	f := &fakePermits{}
	b := f.broker()
	req := bashRequest("npm test")
	req.Suggestions = []any{map[string]any{"type": "addRules", "rules": []any{map[string]any{"toolName": "Bash", "ruleContent": "npm test"}}}}
	done, p := ask(t, b, context.Background(), req)
	if !p.Always {
		t.Fatal("his agent offered to always allow")
	}
	b.Answer(PermitRequest{Id: p.Id, BlockId: "brokk-1", Decision: PermitAlways})
	got := waitAsked(t, done)
	if got.answer.Decision != keepawake.PermissionAllow || len(got.answer.Updated) != 1 {
		t.Fatalf("always allow gave %+v", got.answer)
	}
}

// #2257: other terminals, an unverified caller, and a request MoltenTerm cannot read for sure are never his layer's.
func TestOnlyHisOwnReadableRequestsComeToHisLayer(t *testing.T) {
	t.Parallel()
	f := &fakePermits{}
	b := f.broker()
	other := bashRequest("ls")
	other.BlockId = "other-block"
	if _, handled := b.Ask(context.Background(), other); handled {
		t.Fatal("another terminal's request was taken: the coffee approvals answer it")
	}
	forged := bashRequest("ls")
	forged.FromBlock = false
	if _, handled := b.Ask(context.Background(), forged); handled {
		t.Fatal("a caller whose token does not name his terminal was taken")
	}
	for _, req := range []keepawake.PermissionRequest{
		{BlockId: "brokk-1", FromBlock: true, ToolName: "mcp__server__tool", ToolInput: map[string]any{"x": 1}},
		{BlockId: "brokk-1", FromBlock: true, ToolName: "Bash", ToolInput: map[string]any{"command": 42}},
		{BlockId: "brokk-1", FromBlock: true, ToolName: "Edit", ToolInput: map[string]any{}},
	} {
		answer, handled := b.Ask(context.Background(), req)
		if !handled || answer.Decision != "" || b.Pending("brokk-1") != nil {
			t.Fatalf("%+v: got %+v %v, want his agent's own prompt, never a guess and never a coffee", req, answer, handled)
		}
	}
}

// #2257: boss:autoapprove off asks; on approves at once and keeps a line for his talk window; a guarded request asks
// even then; turning it off applies to the next request.
func TestAutoApprove(t *testing.T) {
	t.Parallel()
	f := &fakePermits{}
	b := f.broker()
	done, p := ask(t, b, context.Background(), bashRequest("npm test"))
	if p == nil {
		t.Fatal("with the option off, the request asks")
	}
	b.Answer(PermitRequest{Id: p.Id, BlockId: "brokk-1", Decision: PermitDeny})
	waitAsked(t, done)
	f.lock.Lock()
	f.auto = true
	f.lock.Unlock()
	answer, handled := b.Ask(context.Background(), bashRequest("npm test"))
	if !handled || answer.Decision != keepawake.PermissionAllow || b.Pending("brokk-1") != nil {
		t.Fatalf("with the option on: %+v", answer)
	}
	lines := b.AutoApproved(0)
	if len(lines) != 1 || lines[0].Subject != "npm test" || lines[0].Kind != PermitKindCommand {
		t.Fatalf("the window's lines: %+v", lines)
	}
	done, p = ask(t, b, context.Background(), bashRequest("git push --force origin main"))
	if p == nil {
		t.Fatal("a guarded request was approved without asking")
	}
	b.Answer(PermitRequest{Id: p.Id, BlockId: "brokk-1", Decision: PermitDeny})
	waitAsked(t, done)
	f.lock.Lock()
	f.auto = false
	f.lock.Unlock()
	done, p = ask(t, b, context.Background(), bashRequest("npm test"))
	if p == nil {
		t.Fatal("turned off, the next request asks again")
	}
	b.Answer(PermitRequest{Id: p.Id, BlockId: "brokk-1", Decision: PermitAllow})
	waitAsked(t, done)
}

func TestMapPermission(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		tool  string
		input map[string]any
		kind  string
		subj  string
	}{
		{"Bash", map[string]any{"command": "ls -la"}, PermitKindCommand, "ls -la"},
		{"shell", map[string]any{"command": []any{"git", "status"}}, PermitKindCommand, "git status"},
		{"Edit", map[string]any{"file_path": "/w/a.go"}, PermitKindEdit, "/w/a.go"},
		{"MultiEdit", map[string]any{"file_path": "/w/a.go"}, PermitKindEdit, "/w/a.go"},
		{"Write", map[string]any{"file_path": "/w/b.go"}, PermitKindWrite, "/w/b.go"},
		{"NotebookEdit", map[string]any{"notebook_path": "/w/n.ipynb"}, PermitKindEdit, "/w/n.ipynb"},
		{"Read", map[string]any{"file_path": "/w/c.md"}, PermitKindRead, "/w/c.md"},
		{"WebFetch", map[string]any{"url": "https://example.com"}, PermitKindFetch, "https://example.com"},
		{"WebSearch", map[string]any{"query": "kids video apps"}, PermitKindSearch, "kids video apps"},
		{"apply_patch", map[string]any{"command": "*** Begin Patch\n*** Update File: src/a.go\n@@\n-a\n+b\n*** Add File: src/b.go\n+x\n*** End Patch"}, PermitKindPatch, "update src/a.go\nadd src/b.go"},
	} {
		got, ok := MapPermission(keepawake.PermissionRequest{ToolName: tc.tool, ToolInput: tc.input})
		if !ok || got.Kind != tc.kind || got.Subject != tc.subj {
			t.Errorf("%s: %+v %v", tc.tool, got, ok)
		}
	}
	for _, tc := range []keepawake.PermissionRequest{
		{ToolName: "Task", ToolInput: map[string]any{"prompt": "x"}},
		{ToolName: "Bash", ToolInput: map[string]any{"command": []any{"git", 3}}},
		{ToolName: "Bash", ToolInput: map[string]any{"command": "  "}},
		{ToolName: "apply_patch", ToolInput: map[string]any{"command": "no header here"}},
	} {
		if _, ok := MapPermission(tc); ok {
			t.Errorf("%+v was read as sure", tc)
		}
	}
}

func TestGuardedRequests(t *testing.T) {
	t.Parallel()
	env := PermitGuardEnv{Home: "/home/dev", DataDirs: []string{"/home/dev/.molten/data", "/home/dev/.config/molten"}, OwnFolder: "/home/dev/.molten/data/brokk"}
	for _, tc := range []struct {
		kind string
		subj string
		want string
	}{
		{PermitKindCommand, "cat ~/.ssh/id_ed25519", GuardSsh},
		{PermitKindRead, "/home/dev/.ssh/config", GuardSsh},
		{PermitKindCommand, "ls $HOME/.aws", GuardCredentials},
		{PermitKindWrite, "/home/dev/.netrc", GuardCredentials},
		{PermitKindCommand, "security find-generic-password -s x", GuardKeychain},
		{PermitKindCommand, "gh auth token", GuardKeychain},
		{PermitKindRead, "/home/dev/Library/Keychains/login.keychain-db", GuardKeychain},
		{PermitKindCommand, "sqlite3 /home/dev/.molten/data/db/waveterm.db", GuardOwnData},
		{PermitKindEdit, "/home/dev/.config/molten/settings.json", GuardOwnData},
		{PermitKindEdit, "/home/dev/.molten/data/brokk/CLAUDE.md", GuardOwnData},
		{PermitKindCommand, "echo hi >> AGENTS.md", GuardOwnData},
		{PermitKindCommand, "git push --force origin main", GuardRemoteGit},
		{PermitKindCommand, "git push -f", GuardRemoteGit},
		{PermitKindCommand, "git push --force-with-lease origin feature", GuardRemoteGit},
		{PermitKindCommand, "git push origin --delete old-branch", GuardRemoteGit},
		{PermitKindCommand, "git push origin :old-branch", GuardRemoteGit},
		{PermitKindCommand, "git push origin +main", GuardRemoteGit},
		{PermitKindCommand, "cd /w && git -C /w push -d origin x", GuardRemoteGit},
		// What stays free.
		{PermitKindCommand, "git push origin feature", ""},
		{PermitKindCommand, "git status && ls -la", ""},
		{PermitKindWrite, "/home/dev/.molten/data/brokk/notes.md", ""},
		{PermitKindRead, "/home/dev/.molten/data/brokk/CLAUDE.md", ""},
		{PermitKindEdit, "/home/dev/projects/app/src/main.go", ""},
		{PermitKindFetch, "https://example.com/.ssh", ""},
	} {
		if got := GuardReason(PermissionAsk{Kind: tc.kind, Subject: tc.subj}, env); got != tc.want {
			t.Errorf("%s %q: %q, want %q", tc.kind, tc.subj, got, tc.want)
		}
	}
}
