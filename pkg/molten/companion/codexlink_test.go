// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// The record shapes of codex-cli 0.162 (#799): the prompt is an item_completed UserMessage, no user_message is
// written; a /model change writes thread_settings_applied.
const (
	codexLinkThread = "01a14561-7aba-7d21-98ba-f3c6c5b67925"
	codexLinkOther  = "01a14563-86a5-7a00-996e-76816e569f2a"
)

func codexMeta(id string, cwd string, started time.Time, extra string) string {
	return fmt.Sprintf(`{"timestamp":%q,"type":"session_meta","payload":{"id":%q,"session_id":%q,"timestamp":%q,"cwd":%q,"originator":"codex-tui","cli_version":"0.162.0","source":"cli","thread_source":"user"%s}}`,
		started.UTC().Format(time.RFC3339Nano), id, id, started.UTC().Format(time.RFC3339Nano), cwd, extra)
}

func codexUserMessage(at time.Time, text string) string {
	content, _ := json.Marshal([]map[string]any{{"type": "text", "text": text, "text_elements": []any{}}})
	return fmt.Sprintf(`{"timestamp":%q,"type":"event_msg","payload":{"type":"item_completed","thread_id":%q,"turn_id":"t1","item":{"type":"UserMessage","id":"u1","content":%s}}}`,
		at.UTC().Format(time.RFC3339Nano), codexLinkThread, content)
}

func codexTurnContext(model string, effort string) string {
	return fmt.Sprintf(`{"timestamp":"2026-10-16T15:44:25Z","type":"turn_context","payload":{"turn_id":"t1","cwd":"/tmp","model":%q,"effort":%q,"summary":"none"}}`, model, effort)
}

func codexThreadSettingsLine(thread string, model string, effort string) string {
	return fmt.Sprintf(`{"timestamp":"2026-10-16T15:50:00Z","type":"event_msg","payload":{"type":"thread_settings_applied","thread_id":%q,"thread_settings":{"model":%q,"reasoning_effort":%q,"collaboration_mode":{"mode":"default"}}}}`, thread, model, effort)
}

func codexRolloutPath(root string, day time.Time, id string) string {
	dir := filepath.Join(root, day.Format("2006"), day.Format("01"), day.Format("02"))
	return filepath.Join(dir, "rollout-"+day.Format("2006-01-02T15-04-05")+"-"+id+".jsonl")
}

func writeCodexLines(t *testing.T, path string, lines ...string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestCodexNewPromptShape(t *testing.T) {
	root := t.TempDir()
	cwd := t.TempDir()
	now := time.Now()
	path := codexRolloutPath(root, now, codexLinkThread)
	writeCodexLines(t, path,
		codexMeta(codexLinkThread, cwd, now.Add(-time.Minute), ""),
		fmt.Sprintf(`{"timestamp":%q,"type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}`, now.UTC().Format(time.RFC3339Nano)),
		codexTurnContext("gpt-6-astra", "high"),
		codexUserMessage(now, "Audit the whole project"),
		fmt.Sprintf(`{"timestamp":%q,"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"On it."}]}}`, now.UTC().Format(time.RFC3339Nano)),
	)
	a := MakeCodexAdapter([]string{root})
	found := a.Discover(cwd, now.Add(-time.Hour))
	if len(found) != 1 || found[0].Prompt != "Audit the whole project" {
		t.Fatalf("discovered: %+v", found)
	}
	s := MakeSession()
	parsePath(t, a, s, path)
	if s.Title() != "Audit the whole project" || len(s.prompts) != 1 {
		t.Fatalf("title %q, prompts %+v", s.Title(), s.prompts)
	}
	if s.Model() != "gpt-6-astra" || s.Effort() != "high" {
		t.Fatalf("settings: %q %q", s.Model(), s.Effort())
	}
	if len(s.Answers()) != 1 {
		t.Fatalf("answers: %+v", s.Answers())
	}
	// A version writing both shapes of one prompt counts it once; the same prompt in the next turn counts.
	both := MakeSession()
	parseLines(t, a, both,
		`{"type":"event_msg","payload":{"type":"task_started"}}`,
		`{"type":"event_msg","payload":{"type":"user_message","message":"Fix it"}}`,
		codexUserMessage(now, "Fix it"),
		`{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done."}]}}`,
		`{"type":"event_msg","payload":{"type":"task_complete"}}`,
		`{"type":"event_msg","payload":{"type":"task_started"}}`,
		codexUserMessage(now, "Fix it"),
	)
	if len(both.prompts) != 2 {
		t.Fatalf("prompts: %+v", both.prompts)
	}
}

func parseLines(t *testing.T, a Adapter, s *Session, lines ...string) {
	t.Helper()
	for _, line := range lines {
		var rec map[string]any
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			t.Fatal(err)
		}
		a.Parse(rec, s)
	}
}

func parsePath(t *testing.T, a Adapter, s *Session, path string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	parseLines(t, a, s, strings.Split(strings.TrimSpace(string(data)), "\n")...)
}

// A sub-agent's rollout copies its parent's history after its own header, the parent's session_meta included: it
// stays a sub-agent's, never a candidate, and its session keeps its own id. Four candidates made every Codex pane
// whose agent delegated guess (#799).
func TestCodexSubagentWithParentHeader(t *testing.T) {
	root := t.TempDir()
	cwd := t.TempDir()
	now := time.Now()
	subId := "01a14563-a515-7ea2-bdcd-adae799270ea"
	main := codexRolloutPath(root, now, codexLinkThread)
	sub := codexRolloutPath(root, now.Add(time.Second), subId)
	writeCodexLines(t, main, codexMeta(codexLinkThread, cwd, now, ""), codexUserMessage(now, "Audit"))
	writeCodexLines(t, sub,
		codexMeta(subId, cwd, now, `,"thread_source":"subagent","parent_thread_id":"`+codexLinkThread+`","source":{"subagent":{"thread_spawn":{"parent_thread_id":"`+codexLinkThread+`"}}}`),
		codexMeta(codexLinkThread, cwd, now, ""),
		codexUserMessage(now, "Audit"),
	)
	a := MakeCodexAdapter([]string{root})
	found := a.Discover(cwd, now.Add(-time.Hour))
	if len(found) != 1 || found[0].Path != main {
		t.Fatalf("candidates: %+v", found)
	}
	if !a.IsSubagent(sub) || a.IsSubagent(main) {
		t.Fatal("sub-agent detection")
	}
	s := MakeSession()
	parsePath(t, a, s, sub)
	if s.Id != "" {
		t.Fatalf("a sub-agent's session takes its parent's id: %q", s.Id)
	}
}

func TestCodexThreadSettingsApplied(t *testing.T) {
	root := t.TempDir()
	path := codexRolloutPath(root, time.Now(), codexLinkThread)
	writeCodexLines(t, path,
		codexMeta(codexLinkThread, "/tmp", time.Now(), ""),
		codexTurnContext("gpt-6-astra", "high"),
		codexThreadSettingsLine(codexLinkThread, "gpt-6.1-sol", "low"),
		codexThreadSettingsLine(codexLinkOther, "gpt-other", "minimal"),
	)
	a := MakeCodexAdapter([]string{root})
	got, ok := a.ReadSettings(path)
	if !ok || got != (molten.AgentSettings{Model: "gpt-6.1-sol", Effort: "low"}) {
		t.Fatalf("got %+v %v", got, ok)
	}
	s := MakeSession()
	parsePath(t, a, s, path)
	if s.Model() != "gpt-6.1-sol" || s.Effort() != "low" {
		t.Fatalf("session settings: %q %q", s.Model(), s.Effort())
	}
}

func TestCodexReadSettingsFrom(t *testing.T) {
	root := t.TempDir()
	path := codexRolloutPath(root, time.Now(), codexLinkThread)
	writeCodexLines(t, path, codexMeta(codexLinkThread, "/tmp", time.Now(), ""), codexTurnContext("gpt-6-astra", "high"))
	a := MakeCodexAdapter([]string{root})
	got, ok, next := a.ReadSettingsFrom(path, 0)
	info, _ := os.Stat(path)
	if !ok || got.Effort != "high" || next != info.Size() {
		t.Fatalf("first read: %+v %v %d", got, ok, next)
	}
	if _, ok, again := a.ReadSettingsFrom(path, next); ok || again != next {
		t.Fatalf("nothing new: %v %d", ok, again)
	}
	// A record being written is read once complete.
	line := codexTurnContext("gpt-6-astra", "ultra")
	appendFile(t, path, line[:20])
	if _, ok, partial := a.ReadSettingsFrom(path, next); ok || partial != next {
		t.Fatalf("partial line: %v %d", ok, partial)
	}
	appendFile(t, path, line[20:]+"\n")
	got, ok, next = a.ReadSettingsFrom(path, next)
	if !ok || got.Effort != "ultra" {
		t.Fatalf("appended: %+v %v", got, ok)
	}
	// Another file at the path starts over.
	writeCodexLines(t, path, codexTurnContext("m", "low"))
	if _, ok, reset := a.ReadSettingsFrom(path, next); ok || reset != 0 {
		t.Fatalf("shrunk: %v %d", ok, reset)
	}
}

type codexLinkEnv struct {
	*fakeEnv
	sink  *settingsSink
	files map[int32][]string
}

func makeCodexLinkManager(t *testing.T, root string) (*Manager, *codexLinkEnv) {
	env := &codexLinkEnv{
		fakeEnv: &fakeEnv{runs: map[string]molten.AgentRunInfo{}, cwds: map[string]string{}, views: map[string]CompanionView{}},
		sink:    &settingsSink{got: map[string]molten.AgentSettings{}},
		files:   map[int32][]string{},
	}
	m := makeTestManager(env.fakeEnv, root)
	codex := MakeCodexAdapter([]string{root})
	m.adapterFor = func(agent string) Adapter {
		if agent == molten.AgentIdCodex {
			return codex
		}
		return nil
	}
	var setLock sync.Mutex
	m.setSettings = func(blockId string, agent string, settings molten.AgentSettings) {
		env.sink.set(blockId, agent, settings)
		setLock.Lock()
		defer setLock.Unlock()
		env.lock.Lock()
		defer env.lock.Unlock()
		if r, ok := env.runs[blockId]; ok {
			r.Settings = settings
			env.runs[blockId] = r
		}
	}
	m.openFiles = func(pid int32) []string {
		env.lock.Lock()
		defer env.lock.Unlock()
		return env.files[pid]
	}
	return m, env
}

// waitViewLong is waitView with a deadline that only bounds a failing run on a loaded machine.
func waitViewLong(t *testing.T, env *fakeEnv, blockId string, ok func(CompanionView) bool) CompanionView {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		env.lock.Lock()
		v, found := env.views[blockId]
		env.lock.Unlock()
		if found && ok(v) {
			return v
		}
		time.Sleep(5 * time.Millisecond)
	}
	env.lock.Lock()
	defer env.lock.Unlock()
	t.Fatalf("view of %s never matched; last: %+v", blockId, env.views[blockId])
	return CompanionView{}
}

func waitSettings(t *testing.T, m *Manager, sink *settingsSink, key string, want molten.AgentSettings) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		m.followRuns()
		if got, _ := sink.of(key); got == want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	got, _ := sink.of(key)
	t.Fatalf("settings of %s: %+v, want %+v", key, got, want)
}

// Two Codex panes in one folder, no notify yet (a long first turn): each pane's process holds its own rollout, which
// links it for sure, and its settings reach the pane at once and follow a /model change.
func TestCodexProcessLinkAndSettings(t *testing.T) {
	root := t.TempDir()
	cwd := t.TempDir()
	now := time.Now()
	start := now.Add(-time.Minute).UnixMilli()
	mine := codexRolloutPath(root, now, codexLinkThread)
	other := codexRolloutPath(root, now.Add(time.Second), codexLinkOther)
	sub := codexRolloutPath(root, now.Add(2*time.Second), "01a14563-a515-7ea2-bdcd-adae799270ea")
	writeCodexLines(t, mine, codexMeta(codexLinkThread, cwd, now, ""), codexTurnContext("gpt-6-astra", "high"), codexUserMessage(now, "Audit"))
	writeCodexLines(t, other, codexMeta(codexLinkOther, cwd, now, ""), codexTurnContext("gpt-6.1-sol", "low"), codexUserMessage(now, "Other"))
	writeCodexLines(t, sub, codexMeta("01a14563-a515-7ea2-bdcd-adae799270ea", cwd, now, `,"parent_thread_id":"`+codexLinkThread+`"`), codexTurnContext("gpt-sub", "minimal"))

	m, env := makeCodexLinkManager(t, root)
	defer m.Close("a", "v")
	env.lock.Lock()
	env.runs["a"] = molten.AgentRunInfo{BlockId: "a", Agent: molten.AgentIdCodex, Started: start, Running: true, Pid: 101}
	env.runs["b"] = molten.AgentRunInfo{BlockId: "b", Agent: molten.AgentIdCodex, Started: start, Running: true, Pid: 202}
	env.cwds["a"], env.cwds["b"] = cwd, cwd
	env.files[101] = []string{"/dev/null", sub, mine}
	env.files[202] = []string{other}
	env.lock.Unlock()

	m.Open("a", "v")
	v := waitViewLong(t, env.fakeEnv, "a", func(v CompanionView) bool {
		return v.Session != nil && v.Session.LinkedBy == LinkProcess && v.Status == StatusLive
	})
	if v.Session.Path != canonicalPath(mine) || v.Session.Title != "Audit" {
		t.Fatalf("linked: %+v", v.Session)
	}
	waitSettings(t, m, env.sink, "a:codex", molten.AgentSettings{Model: "gpt-6-astra", Effort: "high"})
	waitSettings(t, m, env.sink, "b:codex", molten.AgentSettings{Model: "gpt-6.1-sol", Effort: "low"})
	if r, ok := m.report("b"); !ok || r.path != canonicalPath(other) || r.linkKind() != LinkProcess {
		t.Fatalf("b's report: %+v %v", r, ok)
	}

	appendFile(t, mine, codexThreadSettingsLine(codexLinkThread, "gpt-6-astra", "ultra")+"\n")
	waitSettings(t, m, env.sink, "a:codex", molten.AgentSettings{Model: "gpt-6-astra", Effort: "ultra"})

	// A new session (/new): the process opens a new rollout, the pane moves on and keeps the old one in its history.
	next := codexRolloutPath(root, now.Add(3*time.Second), "01a14570-0000-7000-8000-000000000001")
	writeCodexLines(t, next, codexMeta("01a14570-0000-7000-8000-000000000001", cwd, now, ""), codexTurnContext("gpt-6-astra", "medium"), codexUserMessage(now, "Next"))
	later := time.Now().Add(time.Minute)
	os.Chtimes(next, later, later)
	env.lock.Lock()
	env.files[101] = []string{mine, next}
	env.lock.Unlock()
	waitSettings(t, m, env.sink, "a:codex", molten.AgentSettings{Model: "gpt-6-astra", Effort: "medium"})
	waitViewLong(t, env.fakeEnv, "a", func(v CompanionView) bool {
		return v.Session != nil && v.Session.Path == canonicalPath(next) && v.Session.Title == "Next" && len(v.Earlier) == 1
	})

	// The run ends: its track goes.
	env.lock.Lock()
	delete(env.runs, "b")
	env.lock.Unlock()
	m.followRuns()
	m.lock.Lock()
	_, kept := m.tracks["b"]
	m.lock.Unlock()
	if kept {
		t.Fatal("an ended run's track is dropped")
	}
}

// A guess made before discovery could tell becomes discovery's link once it can.
func TestGuessBecomesDiscovery(t *testing.T) {
	root := t.TempDir()
	cwd := t.TempDir()
	now := time.Now()
	m, env := makeCodexLinkManager(t, root)
	defer m.Close("a", "v")
	// The agent started long before the session's first record: a resumed session, which discovery links only past
	// the resume grace and when it is the folder's one session written since.
	start := now.Add(-time.Hour).UnixMilli()
	env.lock.Lock()
	env.runs["a"] = molten.AgentRunInfo{BlockId: "a", Agent: molten.AgentIdCodex, Started: start, Running: true, State: molten.AgentStateWorking, StateSince: start}
	env.cwds["a"] = cwd
	env.lock.Unlock()
	path := codexRolloutPath(root, now, codexLinkThread)
	writeCodexLines(t, path, codexMeta(codexLinkThread, cwd, now.Add(-2*time.Hour), ""), codexUserMessage(now, "Resumed"))
	w := makeWatcher(m, "a")
	w.adapter = m.adapterFor(molten.AgentIdCodex)
	w.info = blockInfo{cwd: cwd, term: true}
	w.infoAt = now
	w.follow(path, LinkGuessed, now.Add(-2*time.Hour).UnixMilli(), GuessRecent)
	defer w.closeFollower()
	run, _ := m.runOf("a")
	w.link(run)
	if by, guess := w.linkKind(); by != LinkDiscovery || guess != "" {
		t.Fatalf("link: %q %q", by, guess)
	}
}
