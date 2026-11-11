// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func copyFixture(t *testing.T, fixture string, dest string) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", fixture))
	if err != nil {
		t.Fatal(err)
	}
	os.MkdirAll(filepath.Dir(dest), 0o755)
	if err := os.WriteFile(dest, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestSessionReaderClaudeDigest(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "-work-demo", "11111111-2222-3333-4444-555555555555.jsonl")
	copyFixture(t, "claude-session.jsonl", path)
	r, err := OpenAdapterSessionReader(MakeClaudeAdapter([]string{root}), path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	d, err := r.Poll()
	if err != nil {
		t.Fatal(err)
	}
	if d.Id != "11111111-2222-3333-4444-555555555555" {
		t.Fatalf("id: %q", d.Id)
	}
	if d.FirstPrompt == nil || d.FirstPrompt.Text != "Add a greeting to hello.go" || d.FirstPrompt.At == 0 {
		t.Fatalf("first prompt: %+v", d.FirstPrompt)
	}
	if len(d.Prompts) != 2 || d.Prompts[1].Text != "Now delete notes.md" {
		t.Fatalf("prompts: %+v", d.Prompts)
	}
	if len(d.Todos) != 2 || d.TodosAt == 0 {
		t.Fatalf("todos: %+v at %d", d.Todos, d.TodosAt)
	}
	if len(d.Files) != 2 || d.Files[0].Path != "/work/demo/notes.md" {
		t.Fatalf("files: %+v", d.Files)
	}
	if r.session.diffBytes != 0 {
		t.Fatal("a reader keeps no diff")
	}

	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString(`{"type":"user","message":{"role":"user","content":"<system-reminder>x</system-reminder>Third prompt"},"sessionId":"11111111-2222-3333-4444-555555555555","timestamp":"2026-10-04T10:02:00.000Z"}` + "\n")
	f.Close()
	d, _ = r.Poll()
	if len(d.Prompts) != 3 || d.Prompts[2].Text != "Third prompt" || d.FirstPrompt.Text != "Add a greeting to hello.go" {
		t.Fatalf("appended prompt: %+v", d.Prompts)
	}
}

// Brokk's field shows the answer of his session (#2028): the reader gives the last answer it read, and a new one once the
// agent writes it.
func TestSessionReaderLatestAnswer(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "-work-demo", "11111111-2222-3333-4444-555555555555.jsonl")
	copyFixture(t, "claude-session.jsonl", path)
	r, err := OpenAdapterSessionReader(MakeClaudeAdapter([]string{root}), path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if _, ok := r.LatestAnswer(); ok {
		t.Fatal("nothing is read before the first poll")
	}
	r.Poll()
	first, ok := r.LatestAnswer()
	if !ok || first.Markdown == "" || first.At == 0 {
		t.Fatalf("latest answer: %+v %v", first, ok)
	}

	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString(`{"type":"user","message":{"role":"user","content":"How many agents run?"},"sessionId":"11111111-2222-3333-4444-555555555555","timestamp":"2026-10-04T10:05:00.000Z"}` + "\n")
	f.WriteString(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Two agents run now."}]},"sessionId":"11111111-2222-3333-4444-555555555555","timestamp":"2026-10-04T10:05:03.000Z"}` + "\n")
	f.Close()
	r.Poll()
	next, ok := r.LatestAnswer()
	if !ok || next.Markdown != "Two agents run now." || next.Index <= first.Index || next.At <= first.At {
		t.Fatalf("new answer: %+v (first %+v)", next, first)
	}
}

// Brokk's session (#2257): a call without its result (a running tool, a permission question) keeps the agent off its
// prompt; once the result is there, it is at rest.
func TestSessionReaderPendingCalls(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "-work-demo", "11111111-2222-3333-4444-555555555555.jsonl")
	copyFixture(t, "claude-session.jsonl", path)
	r, err := OpenAdapterSessionReader(MakeClaudeAdapter([]string{root}), path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString(`{"type":"user","message":{"role":"user","content":"List the files"},"sessionId":"11111111-2222-3333-4444-555555555555","timestamp":"2026-10-04T10:05:00.000Z"}` + "\n")
	f.WriteString(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_9","name":"Bash","input":{"command":"ls"}}]},"sessionId":"11111111-2222-3333-4444-555555555555","timestamp":"2026-10-04T10:05:01.000Z"}` + "\n")
	f.Close()
	r.Poll()
	if n := r.PendingCalls(); n != 1 {
		t.Fatalf("a call without its result: %d pending", n)
	}
	f, _ = os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString(`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_9","content":"a.txt"}]},"sessionId":"11111111-2222-3333-4444-555555555555","timestamp":"2026-10-04T10:05:02.000Z"}` + "\n")
	f.WriteString(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"One file."}]},"sessionId":"11111111-2222-3333-4444-555555555555","timestamp":"2026-10-04T10:05:03.000Z"}` + "\n")
	f.Close()
	r.Poll()
	if n := r.PendingCalls(); n != 0 {
		t.Fatalf("the call has its result: %d pending", n)
	}
	// No call pending, but the turn goes on (generating, or between two calls): not at the prompt yet.
	if !r.TurnOpen() {
		t.Fatal("a turn whose end is not recorded is open")
	}
	f, _ = os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString(`{"type":"system","subtype":"turn_duration","durationMs":2000,"sessionId":"11111111-2222-3333-4444-555555555555","timestamp":"2026-10-04T10:05:04.000Z"}` + "\n")
	f.Close()
	r.Poll()
	if r.TurnOpen() {
		t.Fatal("the turn's end is recorded")
	}
}

// Brokk's window keeps each answer apart (#2033): the first one stays readable by its turn once a second message started
// a newer one.
func TestSessionReaderAnswerAtReadsATurnWhateverCameAfterIt(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "-work-demo", "11111111-2222-3333-4444-555555555555.jsonl")
	copyFixture(t, "claude-session.jsonl", path)
	r, err := OpenAdapterSessionReader(MakeClaudeAdapter([]string{root}), path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	r.Poll()
	first, ok := r.AnswerAt(0)
	if !ok {
		t.Fatal("the fixture holds an answer")
	}

	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString(`{"type":"user","message":{"role":"user","content":"How many agents run?"},"sessionId":"11111111-2222-3333-4444-555555555555","timestamp":"2026-10-04T10:05:00.000Z"}` + "\n")
	f.WriteString(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Two agents run now."}]},"sessionId":"11111111-2222-3333-4444-555555555555","timestamp":"2026-10-04T10:05:03.000Z"}` + "\n")
	f.Close()
	r.Poll()

	latest, _ := r.AnswerAt(0)
	if latest.Markdown != "Two agents run now." {
		t.Fatalf("latest answer: %+v", latest)
	}
	earlier, ok := r.AnswerAt(first.Index)
	if !ok || earlier.Markdown != first.Markdown || earlier.Latest {
		t.Fatalf("answer of turn %d: %+v %v, want the first answer, no longer the latest", first.Index, earlier, ok)
	}
	if _, ok := r.AnswerAt(first.Index + 100); ok {
		t.Fatal("a turn that does not exist has no answer")
	}
}

func TestSessionReaderCodexTurns(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "2026", "10", "04", "rollout-2026-10-04T09-00-00-0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000.jsonl")
	copyFixture(t, "codex-session.jsonl", path)
	r, err := OpenAdapterSessionReader(MakeCodexAdapter([]string{root}), path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	d, _ := r.Poll()
	if d.Id != "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000" || d.FirstPrompt == nil || d.FirstPrompt.Text != "Fix the typo in README.md" || d.Cwd != "/work/demo" {
		t.Fatalf("digest: %+v", d)
	}
	if d.TurnsEnded != 0 {
		t.Fatalf("turns: %d", d.TurnsEnded)
	}
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString(`{"timestamp":"2026-10-04T09:01:00.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"t1"}}` + "\n")
	f.Close()
	if d, _ = r.Poll(); d.TurnsEnded != 1 {
		t.Fatalf("a task_complete ends a turn: %d", d.TurnsEnded)
	}
}

func TestSessionReaderRefusesPathsOutsideRoots(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "-x", "s.jsonl")
	copyFixture(t, "claude-session.jsonl", outside)
	if _, err := OpenAdapterSessionReader(MakeClaudeAdapter([]string{root}), outside); err == nil {
		t.Fatal("a transcript outside the agent's session folder must be refused")
	}
	if _, err := OpenSessionReader("unknown-agent", outside); err == nil {
		t.Fatal("an agent without a reader must be refused")
	}
}

func TestSessionPromptsAreCapped(t *testing.T) {
	s := MakeSession()
	s.AddPrompt("first", 1)
	for i := 0; i < MaxPrompts+10; i++ {
		s.AddPrompt(strings.Repeat("p", MaxPromptBytes+10), int64(i+2))
	}
	d := s.Digest()
	if d.FirstPrompt.Text != "first" || len(d.Prompts) != MaxPrompts || len(d.Prompts[0].Text) != MaxPromptBytes {
		t.Fatalf("caps: first %q, %d prompts", d.FirstPrompt.Text, len(d.Prompts))
	}
	s.AddPrompt("   ", 99)
	if len(s.Digest().Prompts) != MaxPrompts {
		t.Fatal("an empty prompt is not kept")
	}
}

func TestLinkedSession(t *testing.T) {
	root := t.TempDir()
	cwd := t.TempDir()
	path := filepath.Join(root, ClaudeSlug(cwd), "s1.jsonl")
	copyFixture(t, "claude-session.jsonl", path)
	data, _ := os.ReadFile(path)
	os.WriteFile(path, []byte(strings.ReplaceAll(string(data), "/work/demo", cwd)), 0o644)
	now := time.Now()
	m := MakeManager()
	m.adapterFor = func(agent string) Adapter { return MakeClaudeAdapter([]string{root}) }
	started := now.Add(-time.Minute).UnixMilli()
	m.runOf = func(blockId string) (molten.AgentRunInfo, bool) {
		return molten.AgentRunInfo{BlockId: blockId, Agent: molten.AgentIdClaude, Started: started, Running: true}, true
	}
	m.allRuns = func() []molten.AgentRunInfo {
		return []molten.AgentRunInfo{{BlockId: "b1", Agent: molten.AgentIdClaude, Started: started, Running: true}}
	}
	m.blockInfo = func(blockId string) (blockInfo, error) { return blockInfo{cwd: cwd, term: true}, nil }
	// Discovery: the only session of the folder written since the agent started, which started before it (resumed).
	os.Chtimes(path, now, now)
	agent, got, ok := m.LinkedSession("b1")
	resolved, _ := filepath.EvalSymlinks(path)
	if !ok || agent != molten.AgentIdClaude || got != resolved {
		t.Fatalf("discovery: %q %q %v", agent, got, ok)
	}
	// A hook's report wins.
	other := filepath.Join(root, ClaudeSlug(cwd), "s2.jsonl")
	copyFixture(t, "claude-session.jsonl", other)
	if err := m.ReportSession(molten.AgentSessionRequest{BlockId: "b1", Agent: molten.AgentIdClaude, Path: other}); err != nil {
		t.Fatal(err)
	}
	resolvedOther, _ := filepath.EvalSymlinks(other)
	if _, got, ok = m.LinkedSession("b1"); !ok || got != resolvedOther {
		t.Fatalf("report: %q %v", got, ok)
	}
	if m.claimOwner(resolvedOther) != "" || m.claimOwner(resolved) != "" {
		t.Fatal("LinkedSession claims nothing")
	}
	m.runOf = func(string) (molten.AgentRunInfo, bool) { return molten.AgentRunInfo{}, false }
	if _, _, ok = m.LinkedSession("b1"); ok {
		t.Fatal("no run, no session")
	}
}
