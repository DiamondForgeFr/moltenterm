// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brokksession

import (
	"context"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/keepawake"
	"github.com/wavetermdev/waveterm/pkg/molten/metaguard"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
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
			return GuardReason(ask, PermitGuardEnv{OwnFolder: testOwnFolder})
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
		BlockId: "brokk-1", FromBlock: true, Agent: "claude", ToolName: "Bash", Cwd: testOwnFolder,
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
		{BlockId: "brokk-1", FromBlock: true, ToolName: "ExitPlanMode", ToolInput: map[string]any{"plan": "synthetic"}},
		{BlockId: "brokk-1", FromBlock: true, ToolName: "AskUserQuestion", ToolInput: map[string]any{"questions": "one?"}},
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

// #2257, review: boss:autoapprove counts only with the developer's confirmation the window recorded; the setting
// alone (an agent writing settings.json by hand) is off.
func TestAutoApproveNeedsTheDevelopersConfirmation(t *testing.T) {
	t.Parallel()
	confirmed := map[string]any{AutoApproveConsentKey: float64(1_700_000_000_000)}
	if !AutoApproveOn(true, confirmed) {
		t.Fatal("the setting with its confirmation is on")
	}
	for name, meta := range map[string]map[string]any{
		"no confirmation":      {},
		"a forged true":        {AutoApproveConsentKey: true},
		"a forged string":      {AutoApproveConsentKey: "yes"},
		"a confirmation taken": {AutoApproveConsentKey: nil},
		"no meta":              nil,
	} {
		if AutoApproveOn(true, meta) {
			t.Errorf("%s: on", name)
		}
	}
	if AutoApproveOn(false, confirmed) {
		t.Fatal("the setting off with an old confirmation is on")
	}
	// A terminal cannot write the confirmation: only wavesrv and the window set MoltenTerm's keys on the client.
	terminal := metaguard.Caller{Local: true, BlockId: "brokk-1"}
	if err := metaguard.CheckWrite(terminal, waveobj.MakeORef(waveobj.OType_Client, "client-1"), waveobj.MetaMapType{AutoApproveConsentKey: float64(1)}); err == nil {
		t.Fatal("a terminal wrote the developer's confirmation")
	}
}

// #2257, second review: each approval made without asking is written to the file of his folder before his agent gets
// the allow; a burst and a restart lose none, and an approval that cannot be written asks instead.
func TestAutoApprovalsAreWrittenDownFirst(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	log := MakeApprovalLog(dir)
	f := &fakePermits{auto: true}
	b := f.broker()
	b.env.Approvals = log
	for i := 0; i < 30; i++ {
		if answer, _ := b.Ask(context.Background(), bashRequest("ls -la")); answer.Decision != keepawake.PermissionAllow {
			t.Fatalf("approval %d: %+v", i, answer)
		}
	}
	// A restart: a new broker over the same file.
	g := &fakePermits{auto: true, n: 100}
	again := g.broker()
	again.env.Approvals = MakeApprovalLog(dir)
	if got := again.AutoApproved(0); len(got) != 30 || got[0].Subject != "ls -la" {
		t.Fatalf("after a restart the window reads %d approvals", len(got))
	}
	// A log that cannot be written: nothing runs unseen, the request asks.
	h := &fakePermits{auto: true}
	broken := h.broker()
	broken.env.Approvals = MakeApprovalLog(filepath.Join(dir, "missing", "folder"))
	done, p := ask(t, broken, context.Background(), bashRequest("ls -la"))
	if p == nil {
		t.Fatal("an approval that could not be written down went without asking")
	}
	broken.Answer(PermitRequest{Id: p.Id, BlockId: "brokk-1", Decision: PermitDeny})
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
		// #2382: the searches a "which projects use…" message leads to, and an MCP server's tool.
		{"Glob", map[string]any{"pattern": "**/.manifest.json", "path": "/w/projects/"}, PermitKindFind, "/w/projects/**/.manifest.json"},
		{"Glob", map[string]any{"pattern": "*.md"}, PermitKindFind, "*.md"},
		{"Grep", map[string]any{"pattern": "Toolkit", "path": "/w/projects", "glob": "*.json"}, PermitKindGrep, "Toolkit\n/w/projects\n*.json"},
		{"LS", map[string]any{"path": "/w/projects"}, PermitKindRead, "/w/projects"},
		{"mcp__notes__search", map[string]any{"q": "plans"}, PermitKindTool, "mcp__notes__search\n{\"q\":\"plans\"}"},
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
		{ToolName: "ExitPlanMode", ToolInput: map[string]any{"plan": "x"}},
		{ToolName: "Glob", ToolInput: map[string]any{"path": "/w"}},
		{ToolName: "mcp__", ToolInput: map[string]any{}},
		// Review of #2382: the card shows the pattern, the folder and the filter one per line, so a line break in any of
		// them would read as another folder: never read.
		{ToolName: "Grep", ToolInput: map[string]any{"pattern": "Toolkit\n/w/elsewhere", "path": "/w/projects"}},
		{ToolName: "Grep", ToolInput: map[string]any{"pattern": "Toolkit", "path": "/w/projects\r\n/w/other"}},
		{ToolName: "Grep", ToolInput: map[string]any{"pattern": "Toolkit", "glob": "*.json\n/w/other"}},
		{ToolName: "Grep", ToolInput: map[string]any{"pattern": "Toolkit", "path": 7}},
		{ToolName: "Glob", ToolInput: map[string]any{"pattern": "*.md\n/w/other"}},
		{ToolName: "Glob", ToolInput: map[string]any{"pattern": "*.md", "path": "/w\n/x"}},
		{ToolName: "LS", ToolInput: map[string]any{"path": "/w\n/x"}},
	} {
		if _, ok := MapPermission(tc); ok {
			t.Errorf("%+v was read as sure", tc)
		}
	}
	// An empty or absent optional field is no line of the card.
	if got, ok := MapPermission(keepawake.PermissionRequest{ToolName: "Grep", ToolInput: map[string]any{"pattern": "Toolkit", "path": "", "glob": nil}}); !ok || got.Subject != "Toolkit" {
		t.Errorf("grep with empty fields: %+v %v", got, ok)
	}
}

func questionInput(questions ...map[string]any) map[string]any {
	list := make([]any, len(questions))
	for i, q := range questions {
		list[i] = q
	}
	return map[string]any{"questions": list}
}

func choiceQuestion(text string, multi bool, labels ...string) map[string]any {
	options := make([]any, len(labels))
	for i, label := range labels {
		options[i] = map[string]any{"label": label, "description": "about " + label}
	}
	return map[string]any{"question": text, "header": "Pick", "options": options, "multiSelect": multi}
}

// #2382: his agent's question (AskUserQuestion) is read with its choices, or not at all.
func TestAQuestionOfHisAgentIsReadWithItsChoices(t *testing.T) {
	t.Parallel()
	got, ok := MapPermission(keepawake.PermissionRequest{
		ToolName:    "AskUserQuestion",
		ToolInput:   questionInput(choiceQuestion("Where are the projects?", false, "Documents", "Elsewhere"), choiceQuestion("Which ones?", true, "All", "Active")),
		Suggestions: []any{"x"},
	})
	if !ok || got.Kind != PermitKindQuestion || got.Always || len(got.Questions) != 2 {
		t.Fatalf("read %+v %v", got, ok)
	}
	first := got.Questions[0]
	if first.Question != "Where are the projects?" || first.Header != "Pick" || first.MultiSelect || len(first.Options) != 2 ||
		first.Options[1] != (AgentChoice{Label: "Elsewhere", Description: "about Elsewhere"}) {
		t.Fatalf("first question %+v", first)
	}
	if !got.Questions[1].MultiSelect || got.Subject != "Where are the projects?\nWhich ones?" {
		t.Fatalf("second question %+v, subject %q", got.Questions[1], got.Subject)
	}
	eleven := []string{"a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"}
	for name, input := range map[string]map[string]any{
		"no list":        {"questions": "Where?"},
		"empty list":     questionInput(),
		"five questions": questionInput(choiceQuestion("a", false, "x", "y"), choiceQuestion("b", false, "x", "y"), choiceQuestion("c", false, "x", "y"), choiceQuestion("d", false, "x", "y"), choiceQuestion("e", false, "x", "y")),
		"same question":  questionInput(choiceQuestion("a", false, "x", "y"), choiceQuestion("a", false, "y", "z")),
		"same choice":    questionInput(choiceQuestion("a", false, "x", "x")),
		"empty question": questionInput(choiceQuestion(" ", false, "x", "y")),
		"control char":   questionInput(choiceQuestion("a\x1b[2J", false, "x", "y")),
		"not a bool":     questionInput(map[string]any{"question": "a", "options": []any{map[string]any{"label": "x"}, map[string]any{"label": "y"}}, "multiSelect": "yes"}),
		"bad option":     questionInput(map[string]any{"question": "a", "options": []any{"x", "y"}}),
		// A multiple-choice question has two to ten choices (minChoices, maxChoices).
		"no choice":      questionInput(map[string]any{"question": "a", "options": []any{}}),
		"one choice":     questionInput(choiceQuestion("a", false, "x")),
		"eleven choices": questionInput(choiceQuestion("a", false, eleven...)),
	} {
		if _, ok := MapPermission(keepawake.PermissionRequest{ToolName: "AskUserQuestion", ToolInput: input}); ok {
			t.Errorf("%s was read as sure", name)
		}
	}
}

// #2382: the developer's answers go back to his agent as its own answer: the hook's allow with the tool's input and
// the answers, for that question alone; a question takes answers to every one of its questions, never an allow.
func TestAQuestionIsAnsweredWithTheDevelopersAnswers(t *testing.T) {
	t.Parallel()
	f := &fakePermits{}
	b := f.broker()
	changes := 0
	var changesLock sync.Mutex
	b.OnChange(func() {
		changesLock.Lock()
		defer changesLock.Unlock()
		changes++
	})
	input := questionInput(choiceQuestion("Where are the projects?", false, "Documents", "Elsewhere"), choiceQuestion("Which ones?", true, "All", "Active"))
	req := keepawake.PermissionRequest{BlockId: "brokk-1", FromBlock: true, Agent: "claude", ToolName: "AskUserQuestion", ToolInput: input}
	f.auto = true
	done, p := ask(t, b, context.Background(), req)
	if p == nil || p.Kind != PermitKindQuestion {
		t.Fatalf("kept %+v: a question asks even with boss:autoapprove on", p)
	}
	if pending := b.PendingAny(); pending == nil || pending.Id != p.Id || len(pending.Questions) != 2 {
		t.Fatalf("pending %+v", pending)
	}
	for name, bad := range map[string]PermitRequest{
		"an allow":       {Id: p.Id, BlockId: "brokk-1", Decision: PermitAllow},
		"always":         {Id: p.Id, BlockId: "brokk-1", Decision: PermitAlways},
		"one answer":     {Id: p.Id, BlockId: "brokk-1", Decision: PermitAnswer, Answers: map[string]string{"Where are the projects?": "Documents"}},
		"another key":    {Id: p.Id, BlockId: "brokk-1", Decision: PermitAnswer, Answers: map[string]string{"Where are the projects?": "x", "Other?": "y"}},
		"an empty value": {Id: p.Id, BlockId: "brokk-1", Decision: PermitAnswer, Answers: map[string]string{"Where are the projects?": " ", "Which ones?": "All"}},
	} {
		if got := b.Answer(bad); got.Status != PermitInvalid {
			t.Errorf("%s: %+v", name, got)
		}
	}
	answers := map[string]string{"Where are the projects?": "In ~/work, mostly\x07", "Which ones?": "All, Active"}
	if got := b.Answer(PermitRequest{Id: p.Id, BlockId: "brokk-1", Decision: PermitAnswer, Answers: answers}); got.Status != PermitAnswered {
		t.Fatalf("answered %+v", got)
	}
	got := waitAsked(t, done)
	if !got.handled || got.answer.Decision != keepawake.PermissionAllow {
		t.Fatalf("the hook got %+v", got)
	}
	sent, _ := got.answer.Input["answers"].(map[string]any)
	if sent["Where are the projects?"] != "In ~/work, mostly" || sent["Which ones?"] != "All, Active" {
		t.Fatalf("answers %+v", got.answer.Input)
	}
	if _, ok := got.answer.Input["questions"].([]any); !ok {
		t.Fatalf("the tool's own input is not given back: %+v", got.answer.Input)
	}
	changesLock.Lock()
	defer changesLock.Unlock()
	if changes < 2 {
		t.Fatalf("the talk was told %d times, want the request's coming and going", changes)
	}
}
