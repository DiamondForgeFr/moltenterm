// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

const minute = int64(60_000)

func TestGuessCandidate(t *testing.T) {
	now := int64(1_000 * minute)
	working := molten.AgentStateWorking
	idle := molten.AgentStateIdle
	done := molten.AgentStateDone
	type tc struct {
		name   string
		free   []Candidate
		self   guessRun
		others []guessRun
		// witnesses: panes that only guessed their session.
		witnesses []guessRun
		want      string
		reason    string
	}
	cases := []tc{
		{
			name: "two new panes: each the session that started after it",
			free: []Candidate{
				{Path: "sa", Started: now - 59*minute, Modified: now - 30*minute},
				{Path: "sb", Started: now - 54*minute, Modified: now - 20*minute},
			},
			self:   guessRun{blockId: "a", started: now - 60*minute},
			others: []guessRun{{blockId: "b", started: now - 55*minute}},
			want:   "sa", reason: GuessStarted,
		},
		{
			name: "the later pane takes its own",
			free: []Candidate{
				{Path: "sa", Started: now - 59*minute, Modified: now - 30*minute},
				{Path: "sb", Started: now - 54*minute, Modified: now - 20*minute},
			},
			self:   guessRun{blockId: "b", started: now - 55*minute},
			others: []guessRun{{blockId: "a", started: now - 60*minute}},
			want:   "sb", reason: GuessStarted,
		},
		{
			name: "a /clear of the older pane goes to it when it is the one working",
			free: []Candidate{
				{Path: "sa", Started: now - 59*minute, Modified: now - 30*minute},
				{Path: "sb", Started: now - 54*minute, Modified: now - 50*minute},
				{Path: "sa2", Started: now - 5*minute, Modified: now - 1_000},
			},
			self:   guessRun{blockId: "a", started: now - 60*minute, state: working, since: now - 2*minute},
			others: []guessRun{{blockId: "b", started: now - 55*minute, state: idle, since: now - 50*minute}},
			want:   "sa2", reason: GuessActivity,
		},
		{
			name: "and the idle pane keeps the session it last wrote",
			free: []Candidate{
				{Path: "sa", Started: now - 59*minute, Modified: now - 30*minute},
				{Path: "sb", Started: now - 54*minute, Modified: now - 50*minute},
				{Path: "sa2", Started: now - 5*minute, Modified: now - 1_000},
			},
			self:   guessRun{blockId: "b", started: now - 55*minute, state: idle, since: now - 50*minute},
			others: []guessRun{{blockId: "a", started: now - 60*minute, state: working, since: now - 2*minute}},
			want:   "sb", reason: GuessActivity,
		},
		{
			name:   "a brand-new agent guesses nothing",
			free:   []Candidate{{Path: "other", Started: now - 30*minute, Modified: now - 1_000}},
			self:   guessRun{blockId: "b", started: now - 10*minute, state: idle, since: now - 10*minute},
			others: []guessRun{{blockId: "a", started: now - 60*minute, state: working, since: now - minute}},
			want:   "",
		},
		{
			name:   "a new agent does not take a session another pane started after it",
			free:   []Candidate{{Path: "a2", Started: now - 5*minute, Modified: now - 1_000}},
			self:   guessRun{blockId: "b", started: now - 10*minute, state: idle, since: now - 10*minute},
			others: []guessRun{{blockId: "a", started: now - 60*minute, state: working, since: now - 5*minute}},
			want:   "",
		},
		{
			name: "resumed sessions: the one this pane's activity explains",
			free: []Candidate{
				{Path: "r1", Started: now - 3_000*minute, Modified: now - 2*minute},
				{Path: "r2", Started: now - 2_000*minute, Modified: now - 20*minute},
			},
			self:   guessRun{blockId: "a", started: now - 60*minute, state: done, since: now - 20*minute},
			others: []guessRun{{blockId: "b", started: now - 60*minute, state: done, since: now - 2*minute}},
			want:   "r2", reason: GuessActivity,
		},
		{
			name: "resumed sessions, nothing to tell them apart: the most recently updated",
			free: []Candidate{
				{Path: "r1", Started: now - 3_000*minute, Modified: now - 20*minute},
				{Path: "r2", Started: now - 2_000*minute, Modified: now - 2*minute},
			},
			self:   guessRun{blockId: "a", started: now - 60*minute},
			others: []guessRun{{blockId: "b", started: now - 60*minute}},
			want:   "r2", reason: GuessRecent,
		},
		{
			name:   "a resumed session within the resume grace: nothing yet",
			free:   []Candidate{{Path: "r1", Started: now - 3_000*minute, Modified: now - 1_000}},
			self:   guessRun{blockId: "a", started: now - 5_000},
			others: nil,
			want:   "",
		},
		{
			name: "a session written before the agent started is not its",
			free: []Candidate{{Path: "old", Started: now - 3_000*minute, Modified: now - 61*minute}},
			self: guessRun{blockId: "a", started: now - 60*minute},
			want: "",
		},
		{
			name: "a session another pane's activity explains is left to it",
			free: []Candidate{
				{Path: "r1", Started: now - 3_000*minute, Modified: now - 1_000},
				{Path: "r2", Started: now - 2_000*minute, Modified: now - 40*minute},
			},
			self:   guessRun{blockId: "a", started: now - 60*minute, state: done, since: now - 10*minute},
			others: []guessRun{{blockId: "b", started: now - 60*minute, state: working, since: now - 3*minute}},
			want:   "r2", reason: GuessRecent,
		},
		{
			name: "two busy panes: the later one takes the session started when it began working, not the last written",
			free: []Candidate{
				{Path: "sa", Started: now - 40*minute, Modified: now - 500},
				{Path: "sb", Started: now - 30*minute, Modified: now - 1_000},
			},
			self:   guessRun{blockId: "b", started: now - 50*minute, state: working, since: now - 30*minute},
			others: []guessRun{{blockId: "a", started: now - 60*minute, state: working, since: now - 40*minute}},
			want:   "sb", reason: GuessActivity,
		},
		{
			name: "and the earlier one its own",
			free: []Candidate{
				{Path: "sa", Started: now - 40*minute, Modified: now - 500},
				{Path: "sb", Started: now - 30*minute, Modified: now - 1_000},
			},
			self:   guessRun{blockId: "a", started: now - 60*minute, state: working, since: now - 40*minute},
			others: []guessRun{{blockId: "b", started: now - 50*minute, state: working, since: now - 30*minute}},
			want:   "sa", reason: GuessActivity,
		},
		{
			name: "a session a guessing pane's activity explains is not taken",
			free: []Candidate{
				{Path: "sb", Started: now - 30*minute, Modified: now - 1_000},
				{Path: "sa", Started: now - 40*minute, Modified: now - 20*minute},
			},
			self:      guessRun{blockId: "a", started: now - 60*minute, state: idle, since: now - 20*minute},
			witnesses: []guessRun{{blockId: "b", started: now - 50*minute, state: working, since: now - 5*minute}},
			want:      "sa", reason: GuessActivity,
		},
	}
	for _, c := range cases {
		got, reason := guessCandidate(c.free, c.self, c.others, c.witnesses, now)
		gotPath := ""
		if got != nil {
			gotPath = got.Path
		}
		if gotPath != c.want || (c.want != "" && reason != c.reason) {
			t.Errorf("%s: got %q (%s), want %q (%s)", c.name, gotPath, reason, c.want, c.reason)
		}
	}
}

// Two panes run Claude Code in the same folder without hooks: each companion opens on its own session, never the
// same one; a hook report replaces a guess, and another pane's pick of the guessed session makes the pane guess again.
func TestTwoPanesGuessTheirOwnSessions(t *testing.T) {
	root := t.TempDir()
	cwd := t.TempDir()
	dir := filepath.Join(root, ClaudeSlug(cwd))
	os.MkdirAll(dir, 0o700)
	now := time.Now()
	startA := now.Add(-10 * time.Minute)
	startB := now.Add(-5 * time.Minute)
	pa := filepath.Join(dir, "a.jsonl")
	pb := filepath.Join(dir, "b.jsonl")
	writeSessionAt(t, pa, cwd, "task of a", startA.Add(time.Minute), now.Add(-3*time.Minute))
	writeSessionAt(t, pb, cwd, "task of b", startB.Add(time.Minute), now.Add(-time.Minute))
	env := &fakeEnv{
		runs: map[string]molten.AgentRunInfo{
			"a": {BlockId: "a", Agent: "claude", Started: startA.UnixMilli(), Running: true},
			"b": {BlockId: "b", Agent: "claude", Started: startB.UnixMilli(), Running: true},
		},
		cwds:  map[string]string{"a": cwd, "b": cwd},
		views: map[string]CompanionView{},
	}
	m := makeTestManager(env, root)
	defer m.Close("a", "v")
	defer m.Close("b", "v")
	m.Open("a", "v")
	va := waitView(t, env, "a", func(v CompanionView) bool { return v.Session != nil && v.Status == StatusLive })
	if filepath.Base(va.Session.Path) != "a.jsonl" || va.Session.LinkedBy != LinkGuessed || va.Session.Title != "task of a" {
		t.Fatalf("a: %+v", va.Session)
	}
	if va.Session.Started != startA.Add(time.Minute).UnixMilli() {
		t.Errorf("started: %d", va.Session.Started)
	}
	m.Open("b", "v")
	vb := waitView(t, env, "b", func(v CompanionView) bool { return v.Session != nil && v.Status == StatusLive })
	if filepath.Base(vb.Session.Path) != "b.jsonl" || vb.Session.LinkedBy != LinkGuessed {
		t.Fatalf("b: %+v", vb.Session)
	}

	// The user knows a's session is b's: picking it takes it from a's guess, and a guesses again.
	list, err := m.Sessions("b", "v")
	if err != nil || len(list) != 2 || !list[0].Current || filepath.Base(list[0].Path) != "b.jsonl" || !list[1].Elsewhere {
		t.Fatalf("history: %+v %v", list, err)
	}
	if _, err := m.Pick("b", "v", pa); err != nil {
		t.Fatal(err)
	}
	vb = waitView(t, env, "b", func(v CompanionView) bool { return v.Session != nil && v.Session.LinkedBy == LinkPicked })
	if filepath.Base(vb.Session.Path) != "a.jsonl" || vb.Session.Guess != "" {
		t.Errorf("picked: %+v", vb.Session)
	}
	va = waitView(t, env, "a", func(v CompanionView) bool {
		return v.Session != nil && filepath.Base(v.Session.Path) == "b.jsonl" && v.Status == StatusLive
	})
	if va.Session.LinkedBy != LinkGuessed {
		t.Errorf("a guesses again: %+v", va.Session)
	}
	if _, err := m.Pick("a", "v", pa); err == nil {
		t.Error("a session another terminal picked cannot be picked")
	}

	// a's hook reports its session: it replaces the guess.
	if err := m.ReportSession(molten.AgentSessionRequest{BlockId: "a", Agent: "claude", Path: pb}); err != nil {
		t.Fatal(err)
	}
	va = waitView(t, env, "a", func(v CompanionView) bool { return v.Session != nil && v.Session.LinkedBy == LinkHook })
	if va.Session.Guess != "" || filepath.Base(va.Session.Path) != "b.jsonl" {
		t.Errorf("hook: %+v", va.Session)
	}
}

// A guess follows a /clear even while another pane runs the same agent in the folder, and never takes the other
// pane's session.
func TestGuessFollowsAClearBesideAnotherPane(t *testing.T) {
	root := t.TempDir()
	cwd := t.TempDir()
	dir := filepath.Join(root, ClaudeSlug(cwd))
	os.MkdirAll(dir, 0o700)
	now := time.Now()
	startA := now.Add(-10 * time.Minute)
	startB := now.Add(-5 * time.Minute)
	writeSessionAt(t, filepath.Join(dir, "a.jsonl"), cwd, "task of a", startA.Add(time.Minute), now.Add(-3*time.Minute))
	writeSessionAt(t, filepath.Join(dir, "b.jsonl"), cwd, "task of b", startB.Add(time.Minute), now.Add(-time.Minute))
	env := &fakeEnv{
		runs: map[string]molten.AgentRunInfo{
			"a": {BlockId: "a", Agent: "claude", Started: startA.UnixMilli(), Running: true},
			"b": {BlockId: "b", Agent: "claude", Started: startB.UnixMilli(), Running: true},
		},
		cwds:  map[string]string{"a": cwd, "b": cwd},
		views: map[string]CompanionView{},
	}
	m := makeTestManager(env, root)
	defer m.Close("a", "v")
	defer m.Close("b", "v")
	m.Open("a", "v")
	m.Open("b", "v")
	waitView(t, env, "a", func(v CompanionView) bool { return v.Session != nil && filepath.Base(v.Session.Path) == "a.jsonl" })
	waitView(t, env, "b", func(v CompanionView) bool { return v.Session != nil && filepath.Base(v.Session.Path) == "b.jsonl" })

	// A /clear in one of the panes: with nothing telling whose agent wrote it, neither moves.
	pc := filepath.Join(dir, "c.jsonl")
	writeSessionAt(t, pc, cwd, "task of a after clear", time.Now(), time.Now())
	time.Sleep(rediscoverInterval + time.Second)
	va := waitView(t, env, "a", func(v CompanionView) bool { return v.Session != nil })
	vb := waitView(t, env, "b", func(v CompanionView) bool { return v.Session != nil })
	if filepath.Base(va.Session.Path) != "a.jsonl" || filepath.Base(vb.Session.Path) != "b.jsonl" {
		t.Fatalf("no activity, no move: a %s, b %s", va.Session.Path, vb.Session.Path)
	}

	// a's agent works and writes it, b's idles since its own turn: a follows, b keeps its session.
	env.lock.Lock()
	ra, rb := env.runs["a"], env.runs["b"]
	ra.State, ra.StateSince = molten.AgentStateWorking, time.Now().Add(-time.Second).UnixMilli()
	rb.State, rb.StateSince = molten.AgentStateIdle, now.Add(-time.Minute).UnixMilli()
	env.runs["a"], env.runs["b"] = ra, rb
	env.lock.Unlock()
	appendFile(t, pc, `{"type":"assistant","sessionId":"s","timestamp":"`+time.Now().UTC().Format(time.RFC3339Nano)+`","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}`+"\n")
	time.Sleep(rediscoverInterval)
	va = waitView(t, env, "a", func(v CompanionView) bool {
		return v.Session != nil && filepath.Base(v.Session.Path) == "c.jsonl" && v.Status == StatusLive
	})
	if va.Session.LinkedBy != LinkGuessed || va.Session.Guess != GuessActivity {
		t.Errorf("a after /clear: %+v", va.Session)
	}
	time.Sleep(rediscoverInterval)
	vb = waitView(t, env, "b", func(v CompanionView) bool { return v.Session != nil })
	if filepath.Base(vb.Session.Path) != "b.jsonl" {
		t.Errorf("b keeps its session: %s", vb.Session.Path)
	}
}

// A pane paired with the other pane's session, while nothing told them apart, gives it back once the agents'
// activity does; another pane's hook report takes a guessed session even while that pane's companion is closed.
func TestWrongGuessIsGivenBack(t *testing.T) {
	root := t.TempDir()
	cwd := t.TempDir()
	dir := filepath.Join(root, ClaudeSlug(cwd))
	os.MkdirAll(dir, 0o700)
	now := time.Now()
	pa := filepath.Join(dir, "a.jsonl")
	pb := filepath.Join(dir, "b.jsonl")
	writeSessionAt(t, pa, cwd, "task of a", now.Add(-8*time.Minute), now.Add(-time.Minute))
	writeSessionAt(t, pb, cwd, "task of b", now.Add(-7*time.Minute), now.Add(-3*time.Minute))
	env := &fakeEnv{
		runs: map[string]molten.AgentRunInfo{
			"a": {BlockId: "a", Agent: "claude", Started: now.Add(-10 * time.Minute).UnixMilli(), Running: true},
			"b": {BlockId: "b", Agent: "claude", Started: now.Add(-9 * time.Minute).UnixMilli(), Running: true},
		},
		cwds:  map[string]string{"a": cwd, "b": cwd},
		views: map[string]CompanionView{},
	}
	m := makeTestManager(env, root)
	defer m.Close("a", "v")
	m.Open("a", "v")
	// Without states, b (the later agent) is paired with the last written session, a's.
	waitView(t, env, "a", func(v CompanionView) bool { return v.Session != nil && filepath.Base(v.Session.Path) == "b.jsonl" })

	env.lock.Lock()
	ra, rb := env.runs["a"], env.runs["b"]
	ra.State, ra.StateSince = molten.AgentStateIdle, now.Add(-time.Minute+4*time.Second).UnixMilli()
	rb.State, rb.StateSince = molten.AgentStateIdle, now.Add(-3*time.Minute+4*time.Second).UnixMilli()
	env.runs["a"], env.runs["b"] = ra, rb
	env.lock.Unlock()
	time.Sleep(rediscoverInterval)
	va := waitView(t, env, "a", func(v CompanionView) bool { return v.Session != nil && filepath.Base(v.Session.Path) == "a.jsonl" })
	if va.Session.LinkedBy != LinkGuessed || va.Session.Guess != GuessActivity {
		t.Errorf("given back: %+v", va.Session)
	}

	if err := m.ReportSession(molten.AgentSessionRequest{BlockId: "b", Agent: "claude", Path: pa}); err != nil {
		t.Fatal(err)
	}
	waitView(t, env, "a", func(v CompanionView) bool { return v.Session == nil || filepath.Base(v.Session.Path) != "a.jsonl" })
}

func writeSessionAt(t *testing.T, path string, cwd string, prompt string, started time.Time, modified time.Time) {
	t.Helper()
	at := started.UTC().Format(time.RFC3339Nano)
	line := `{"type":"user","cwd":"` + cwd + `","sessionId":"s","timestamp":"` + at + `","message":{"role":"user","content":"` + prompt + `"}}` + "\n"
	line += `{"type":"assistant","sessionId":"s","timestamp":"` + at + `","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}` + "\n"
	if err := os.WriteFile(path, []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}
	os.Chtimes(path, modified, modified)
}
