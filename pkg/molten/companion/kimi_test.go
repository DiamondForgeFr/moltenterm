// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

const kimiFixtureSessionId = "11111111-2222-3333-4444-555555555555"

func writeKimiFixture(t *testing.T, cwd string) (string, string) {
	t.Helper()
	home := t.TempDir()
	sessionDir := filepath.Join(home, "sessions", "wd_synthetic", kimiFixtureSessionId)
	mainDir := filepath.Join(sessionDir, "agents", "main")
	if err := os.MkdirAll(mainDir, 0o700); err != nil {
		t.Fatal(err)
	}
	wire := filepath.Join(mainDir, "wire.jsonl")
	copyFixture := func(source string, target string) {
		data, err := os.ReadFile(filepath.Join("testdata", source))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	copyFixture("kimi-session.jsonl", wire)
	stateData, err := os.ReadFile(filepath.Join("testdata", "kimi-state.json"))
	if err != nil {
		t.Fatal(err)
	}
	var state kimiState
	if json.Unmarshal(stateData, &state) != nil {
		t.Fatal("invalid synthetic state fixture")
	}
	state.Cwd = cwd
	stateData, _ = json.Marshal(state)
	if err := os.WriteFile(filepath.Join(sessionDir, "state.json"), stateData, 0o600); err != nil {
		t.Fatal(err)
	}
	index := map[string]string{"sessionDir": sessionDir, "sessionId": kimiFixtureSessionId, "workDir": cwd}
	indexData, _ := json.Marshal(index)
	if err := os.WriteFile(filepath.Join(home, "session_index.jsonl"), append(indexData, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	subDir := filepath.Join(sessionDir, "agents", "agent-1")
	if err := os.MkdirAll(subDir, 0o700); err != nil {
		t.Fatal(err)
	}
	copyFixture("kimi-subagent.jsonl", filepath.Join(subDir, "wire.jsonl"))
	return home, wire
}

func TestKimiSession(t *testing.T) {
	cwd := t.TempDir()
	home, path := writeKimiFixture(t, cwd)
	a := MakeKimiAdapter([]string{filepath.Join(home, "sessions")})
	s := MakeSession()
	a.InitSession(path, s)
	parseFile(t, a, s, "kimi-session.jsonl")
	if s.Unsupported() || s.Format != "Kimi Code wire 1.5" || s.Id != kimiFixtureSessionId || s.Cwd != cwd {
		t.Fatalf("session identity: unsupported %v, format %q, id %q, cwd %q", s.Unsupported(), s.Format, s.Id, s.Cwd)
	}
	if s.Name() != "Synthetic Kimi session" {
		t.Errorf("name: %q", s.Name())
	}
	digest := s.Digest()
	if len(digest.Prompts) != 1 || digest.Prompts[0].Text != "Fix the synthetic demo" {
		t.Errorf("real prompt once, injections and turn.prompt ignored: %+v", digest.Prompts)
	}
	if len(s.Answers()) != 1 {
		t.Fatalf("compaction and turn bookkeeping duplicate no answer: %+v", s.Answers())
	}
	answer, ok := s.Answer(0)
	if !ok || answer.Markdown != "The synthetic demo is fixed." || strings.Contains(answer.Markdown, "hidden reasoning") {
		t.Errorf("answer: %+v", answer)
	}
	if s.Activity() == nil || s.Activity().Tool != "Agent" {
		t.Errorf("activity: %+v", s.Activity())
	}
	if got := s.CommandCounts(); got["go"] != 1 {
		t.Errorf("shell commands: %+v", got)
	}
	todos := s.Todos()
	if len(todos) != 2 || todos[0].Status != TodoCompleted || todos[1].Status != TodoInProgress {
		t.Errorf("todos: %+v", todos)
	}
	pending := s.Pending()
	if len(pending) != 1 || pending[0].Id != "bash-2" || !pending[0].Approval || pending[0].Tool != "Bash" {
		t.Errorf("pending approval: %+v", pending)
	}
	files := s.Files()
	if len(files) != 2 {
		t.Fatalf("files: %+v", files)
	}
	byPath := map[string]FileInfo{}
	for _, file := range files {
		byPath[file.Path] = file
	}
	edit := byPath[filepath.Join(cwd, "hello.txt")]
	if edit.Kind != FileUpdated || edit.Added != 1 || edit.Removed != 1 {
		t.Errorf("edit: %+v", edit)
	}
	diff, _ := s.Diff(edit.Path)
	if !strings.Contains(diff.Diff, "-before") || !strings.Contains(diff.Diff, "+after") {
		t.Errorf("edit diff: %q", diff.Diff)
	}
	write := byPath[filepath.Join(cwd, "notes.md")]
	if write.Kind != FileAdded || write.Added != 2 {
		t.Errorf("write: %+v", write)
	}
	agents := s.Subagents()
	if len(agents) != 1 || agents[0].Id != "agent-call" || agents[0].State != SubagentRunning || !agents[0].Background {
		t.Errorf("sub-agent: %+v", agents)
	}
	if agent := s.subagent("agent-call"); agent == nil || agent.agentId != "agent-1" {
		t.Errorf("sub-agent wire id: %+v", agent)
	}
	if len(s.Topics()) != 1 || s.Topics()[0].Files != 2 {
		t.Errorf("topics: %+v", s.Topics())
	}
	settings, ok := a.ReadSettings(path)
	if !ok || settings.Model != "kimi-code/k3" || settings.Effort != "high" {
		t.Errorf("settings: %+v %v", settings, ok)
	}
	if folder, ok := a.WorkFolder(path); !ok || folder != cwd {
		t.Errorf("work folder: %q %v", folder, ok)
	}
	if name, ok := a.SessionName(path, kimiFixtureSessionId); !ok || name != "Synthetic Kimi session" {
		t.Errorf("session name: %q %v", name, ok)
	}
	if a.SubagentWritten(path, "agent-1") == 0 || a.SubagentWritten(path, "../escape") != 0 {
		t.Error("sub-agent transcript writes are bounded to a safe agent id")
	}
	facts, ok := a.ReadSubagent(path, "agent-1")
	if !ok || facts.Model != "kimi-code/k3" || facts.Effort != "medium" || facts.Worktree != cwd || !facts.Ended {
		t.Errorf("sub-agent facts: %+v %v", facts, ok)
	}
}

func TestKimiDiscoveryAndSessionLookup(t *testing.T) {
	cwd := t.TempDir()
	home, path := writeKimiFixture(t, cwd)
	a := MakeKimiAdapter([]string{filepath.Join(home, "sessions")})
	got := a.Discover(cwd, time.Now().Add(-time.Minute))
	if len(got) != 1 || got[0].Path != path || got[0].Id != kimiFixtureSessionId || got[0].Prompt != "Fix the synthetic demo" {
		t.Fatalf("discovery: %+v", got)
	}
	if got := a.Discover(t.TempDir(), time.Now().Add(-time.Minute)); len(got) != 0 {
		t.Errorf("another folder's sessions: %+v", got)
	}
	if found, ok := a.FindSession(kimiFixtureSessionId); !ok || !samePath(found, path) || !a.SessionMatches(found, kimiFixtureSessionId) {
		t.Errorf("index lookup: %q %v", found, ok)
	}
	if a.IsSubagent(path) || !a.IsSubagent(filepath.Join(kimiSessionDir(path), "agents", "agent-1", "wire.jsonl")) {
		t.Error("main and sub-agent paths are distinguished")
	}
	if _, err := ValidateSessionPath(a, path); err != nil {
		t.Errorf("valid main transcript: %v", err)
	}
	if got := SessionIdFromPath(molten.AgentIdKimi, path); got != kimiFixtureSessionId {
		t.Errorf("resume id: %q", got)
	}
	if got := SessionIdFromPath(molten.AgentIdKimi, filepath.Join(kimiSessionDir(path), "agents", "agent-1", "wire.jsonl")); got != "" {
		t.Errorf("a sub-agent is not resumable as the pane's session: %q", got)
	}
}

func TestKimiReaderReplaysStateAndWire(t *testing.T) {
	cwd := t.TempDir()
	home, path := writeKimiFixture(t, cwd)
	a := MakeKimiAdapter([]string{filepath.Join(home, "sessions")})
	reader, err := OpenAdapterSessionReader(a, path)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	digest, err := reader.Poll()
	if err != nil {
		t.Fatal(err)
	}
	if digest.Id != kimiFixtureSessionId || digest.Cwd != cwd || len(digest.Prompts) != 1 || len(digest.Files) != 2 || len(digest.Todos) != 2 {
		t.Errorf("digest: %+v", digest)
	}
	answer, ok := reader.LatestAnswer()
	if !ok || answer.Markdown != "The synthetic demo is fixed." {
		t.Errorf("latest answer: %+v %v", answer, ok)
	}
}

func TestKimiAgentResultText(t *testing.T) {
	for _, test := range []struct {
		name   string
		output string
	}{
		{name: "string", output: `"task_id: agent-call\nstatus: running\nagent_id: agent-1\nactual_subagent_type: explore"`},
		{name: "text parts", output: `[{"type":"text","text":"task_id: agent-call\nstatus: running\nagent_id: agent-1\nactual_subagent_type: explore"}]`},
	} {
		t.Run(test.name, func(t *testing.T) {
			a := MakeKimiAdapter([]string{"/nowhere"})
			s := MakeSession()
			s.StartSubagent("agent-call", "Inspect", "explore", "", "", true, 1)
			parseRecordLine(a, s, []byte(`{"type":"context.append_loop_event","event":{"type":"tool.result","toolCallId":"agent-call","result":{"output":`+test.output+`}}}`))
			agent := s.subagent("agent-call")
			if agent == nil || agent.agentId != "agent-1" || agent.state != SubagentRunning || !agent.background {
				t.Fatalf("Kimi's textual Agent result was not replayed: %+v", agent)
			}
			parseRecordLine(a, s, []byte(`{"type":"subagent.completed","subagentId":"agent-1"}`))
			if agent.state != SubagentDone {
				t.Fatalf("Kimi's native terminal record did not complete the Agent: %+v", agent)
			}
		})
	}
}

func TestKimiRefusesUnknownMalformedAndIncompatibleRecords(t *testing.T) {
	a := MakeKimiAdapter([]string{"/nowhere"})
	for name, records := range map[string][]string{
		"unknown":      {`{"type":"metadata","protocol_version":"1.5"}`, `{"type":"future.record","value":1}`},
		"incompatible": {`{"type":"metadata","protocol_version":"2.0"}`},
		"event":        {`{"type":"context.append_loop_event","event":{"type":"future.event"}}`},
	} {
		t.Run(name, func(t *testing.T) {
			s := MakeSession()
			for _, line := range records {
				parseRecordLine(a, s, []byte(line))
			}
			if !s.Unsupported() {
				t.Fatal("the companion must become terminal-only")
			}
		})
	}
	s := MakeSession()
	parseRecordLine(a, s, []byte(`{"type":`))
	if !s.Unsupported() {
		t.Fatal("malformed JSON is incompatible")
	}
}

func TestKimiSessionPathEscapes(t *testing.T) {
	cwd := t.TempDir()
	home, path := writeKimiFixture(t, cwd)
	root := filepath.Join(home, "sessions")
	a := MakeKimiAdapter([]string{root})
	outside := filepath.Join(t.TempDir(), "outside.jsonl")
	if err := os.WriteFile(outside, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(filepath.Dir(path), "link.jsonl")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := ValidateSessionPath(a, link); err == nil {
		t.Error("a symlink outside the session root is refused")
	}
	otherId := "22222222-2222-3333-4444-555555555555"
	index := `{"sessionDir":` + strconvQuote(filepath.Dir(outside)) + `,"sessionId":"` + otherId + `","workDir":"/work/demo"}` + "\n"
	if err := os.WriteFile(filepath.Join(home, "session_index.jsonl"), []byte(index), 0o600); err != nil {
		t.Fatal(err)
	}
	if found, ok := a.FindSession(otherId); ok {
		t.Errorf("an index escape was accepted: %q", found)
	}
}

func strconvQuote(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func kimiToolCwdRecord(agentId string, field string, cwd string) string {
	return `{"type":"context.append_loop_event","agentId":` + strconvQuote(agentId) +
		`,"event":{"type":"tool.call","toolCallId":"call","name":"Bash","` + field +
		`":{"cwd":` + strconvQuote(cwd) + `}}}`
}

func TestKimiSubagentWorktreeBranchAndTicket(t *testing.T) {
	for _, test := range []struct {
		name        string
		branch      string
		description string
		field       string
		ticket      int
	}{
		{name: "fix branch from arguments", branch: "fix/2406-local-ci-url-path", description: "Corriger chemins CI #2406", field: "args", ticket: 2406},
		{name: "feature branch from display", branch: "feature/2393-kimi-managed-usage", description: "Finish Kimi usage delivery", field: "display", ticket: 2393},
	} {
		t.Run(test.name, func(t *testing.T) {
			parent := t.TempDir()
			makeRepo(t, parent, "develop")
			_, session := writeKimiFixture(t, parent)
			child := filepath.Join(parent, "worktrees", "child")
			makeWorktree(t, parent, child, test.branch)
			previous := filepath.Join(parent, "worktrees", "previous")
			makeWorktree(t, parent, previous, "fix/9999-previous")
			wire := filepath.Join(kimiSessionDir(session), "agents", "agent-1", "wire.jsonl")
			writeLines(t, wire,
				`{"type":"profile.bind","agentId":"agent-1","modelAlias":"kimi-code/k3","thinkingEffort":"medium"}`,
				kimiToolCwdRecord("agent-1", "args", previous),
				kimiToolCwdRecord("agent-1", test.field, child),
				kimiToolCwdRecord("agent-1", "args", "relative/newer"),
				`{"type":"turn.ended","agentId":"agent-1"}`,
			)

			facts, ok := MakeKimiAdapter(nil).ReadSubagent(session, "agent-1")
			if !ok || facts.Worktree != child || facts.Branch != test.branch {
				t.Fatalf("child worktree facts: %+v %v, want %q on %q", facts, ok, child, test.branch)
			}
			s := MakeSession()
			s.StartSubagent("call-1", test.description, "general-purpose", "", "", true, 1)
			s.SetSubagentId("call-1", "agent-1")
			s.SetSubagentFacts("call-1", facts)
			s.ResolveTickets(nil)
			subagents := s.Subagents()
			if len(subagents) != 1 || subagents[0].Ticket != test.ticket || subagents[0].Branch != test.branch || subagents[0].Worktree != child {
				t.Errorf("child ticket association: %+v, want ticket %d on %q in %q", subagents, test.ticket, test.branch, child)
			}
		})
	}
}

func TestKimiSubagentWorktreeFallback(t *testing.T) {
	parent := t.TempDir()
	makeRepo(t, parent, "develop")
	_, session := writeKimiFixture(t, parent)
	facts, ok := MakeKimiAdapter(nil).ReadSubagent(session, "agent-1")
	if !ok || facts.Worktree != parent || facts.Branch != "develop" {
		t.Fatalf("session directory fallback: %+v %v, want %q on develop", facts, ok, parent)
	}
}

func TestKimiSubagentRejectsInvalidAndForeignToolCwd(t *testing.T) {
	otherChild := t.TempDir()
	makeRepo(t, otherChild, "fix/9998-other-child")
	parentEvidence := t.TempDir()
	makeRepo(t, parentEvidence, "fix/9997-parent")
	for _, test := range []struct {
		name    string
		agentId string
		field   string
		cwd     string
	}{
		{name: "relative", agentId: "agent-1", field: "args", cwd: "worktrees/child"},
		{name: "malformed", agentId: "agent-1", field: "display", cwd: "/tmp/\x00child"},
		{name: "another child", agentId: "agent-2", field: "args", cwd: otherChild},
		{name: "parent", agentId: "main", field: "display", cwd: parentEvidence},
	} {
		t.Run(test.name, func(t *testing.T) {
			parent := t.TempDir()
			makeRepo(t, parent, "develop")
			_, session := writeKimiFixture(t, parent)
			wire := filepath.Join(kimiSessionDir(session), "agents", "agent-1", "wire.jsonl")
			writeLines(t, wire,
				`{"type":"profile.bind","agentId":"agent-1","modelAlias":"kimi-code/k3","thinkingEffort":"medium"}`,
				kimiToolCwdRecord(test.agentId, test.field, test.cwd),
			)
			facts, ok := MakeKimiAdapter(nil).ReadSubagent(session, "agent-1")
			if !ok || facts.Worktree != parent || facts.Branch != "develop" {
				t.Errorf("no child directory evidence: %+v %v, want fallback %q on develop", facts, ok, parent)
			}
		})
	}
}
