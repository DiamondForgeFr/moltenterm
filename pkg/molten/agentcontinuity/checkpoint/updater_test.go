// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package checkpoint

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/companion"
)

type scheduled struct {
	delay time.Duration
	fn    func()
}

type fakeScheduler struct {
	lock  sync.Mutex
	tasks []scheduled
}

func (s *fakeScheduler) after(d time.Duration, fn func()) func() bool {
	s.lock.Lock()
	defer s.lock.Unlock()
	s.tasks = append(s.tasks, scheduled{delay: d, fn: fn})
	return func() bool { return true }
}

func (s *fakeScheduler) take() []scheduled {
	s.lock.Lock()
	defer s.lock.Unlock()
	rtn := s.tasks
	s.tasks = nil
	return rtn
}

func gitCmd(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"}, args...)...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return string(out)
}

func makeRepo(t *testing.T, branch string) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	repo := filepath.Join(t.TempDir(), "app")
	os.MkdirAll(filepath.Join(repo, "src"), 0o755)
	gitCmd(t, repo, "init", "-q", "-b", branch)
	os.WriteFile(filepath.Join(repo, "src", "login.go"), []byte("x\n"), 0o644)
	gitCmd(t, repo, "add", ".")
	gitCmd(t, repo, "commit", "-q", "-m", "init")
	return repo
}

// writeFixture copies a transcript fixture with the repository's path in place of __CWD__.
func writeFixture(t *testing.T, fixture string, dest string, repo string) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", fixture))
	if err != nil {
		t.Fatal(err)
	}
	os.MkdirAll(filepath.Dir(dest), 0o755)
	if err := os.WriteFile(dest, []byte(strings.ReplaceAll(string(data), "__CWD__", repo)), 0o644); err != nil {
		t.Fatal(err)
	}
}

type testPane struct {
	blockId string
	wsId    string
	agent   string
	path    string
	folder  string
	state   string
}

type updaterHarness struct {
	u      *Updater
	store  *Store
	clock  *fakeClock
	sched  *fakeScheduler
	lock   sync.Mutex
	panes  map[string]*testPane
	claude companion.Adapter
	codex  companion.Adapter
}

func makeHarness(t *testing.T, roots string) *updaterHarness {
	store, clock := makeTestStore(t)
	h := &updaterHarness{
		store: store, clock: clock, sched: &fakeScheduler{}, panes: map[string]*testPane{},
		claude: companion.MakeClaudeAdapter([]string{filepath.Join(roots, "claude", "projects")}),
		codex:  companion.MakeCodexAdapter([]string{filepath.Join(roots, "codex", "sessions")}),
	}
	u := MakeUpdater(store)
	u.now = clock.now
	u.afterFunc = h.sched.after
	u.home = "/nonexistent-home"
	u.runs = func() []molten.AgentRunInfo {
		h.lock.Lock()
		defer h.lock.Unlock()
		var rtn []molten.AgentRunInfo
		for _, p := range h.panes {
			rtn = append(rtn, molten.AgentRunInfo{BlockId: p.blockId, Agent: p.agent, Running: true, State: p.state})
		}
		return rtn
	}
	u.linked = func(blockId string) (string, string, bool) {
		h.lock.Lock()
		defer h.lock.Unlock()
		p := h.panes[blockId]
		if p == nil || p.path == "" {
			return "", "", false
		}
		return p.agent, p.path, true
	}
	u.workspaceOf = func(blockId string) (string, error) {
		h.lock.Lock()
		defer h.lock.Unlock()
		return h.panes[blockId].wsId, nil
	}
	u.folderOf = func(blockId string) (blockFolder, error) {
		h.lock.Lock()
		defer h.lock.Unlock()
		return blockFolder{cwd: h.panes[blockId].folder}, nil
	}
	u.openReader = func(agent string, path string) (sessionReader, error) {
		adapter := h.claude
		if agent == molten.AgentIdCodex {
			adapter = h.codex
		}
		return companion.OpenAdapterSessionReader(adapter, path)
	}
	h.u = u
	return h
}

func (h *updaterHarness) addPane(p *testPane) {
	h.lock.Lock()
	defer h.lock.Unlock()
	h.panes[p.blockId] = p
}

// runScheduled runs what the updater scheduled and returns the delays it asked for.
func (h *updaterHarness) runScheduled() []time.Duration {
	var delays []time.Duration
	for _, s := range h.sched.take() {
		delays = append(delays, s.delay)
		s.fn()
	}
	return delays
}

func TestUpdaterClaudeTurn(t *testing.T) {
	repo := makeRepo(t, "feature/42-login")
	roots := t.TempDir()
	transcript := filepath.Join(roots, "claude", "projects", companion.ClaudeSlug(repo), "aaaaaaaa-1111-2222-3333-444444444444.jsonl")
	writeFixture(t, "claude-turn.jsonl", transcript, repo)
	statusBefore := gitCmd(t, repo, "status", "--porcelain")
	h := makeHarness(t, roots)
	h.addPane(&testPane{blockId: "b1", wsId: "ws-1", agent: "claude", path: transcript, folder: repo, state: molten.AgentStateDone})

	h.u.TurnEnded("b1", "claude")
	delays := h.runScheduled()
	if len(delays) != 1 || delays[0] != TriggerDelay {
		t.Fatalf("first update after %v: %v", TriggerDelay, delays)
	}
	view, err := h.store.View("ws-1", "")
	if err != nil || !view.Exists {
		t.Fatalf("no checkpoint: %+v %v", view, err)
	}
	md := view.Markdown
	for _, want := range []string{
		"Plan the login page in three steps",
		"#42, on branch `feature/42-login`",
		"- [x] Write the login form",
		"- [ ] Test the login form (in progress)",
		"- [ ] Document the login",
		"- `src/login.go` (modified)",
		"- `src/login_test.go` (added)",
		"`aaaaaaaa-1111-2222-3333-444444444444`",
		"Claude Code",
	} {
		if !strings.Contains(md, want) {
			t.Errorf("checkpoint lacks %q:\n%s", want, md)
		}
	}
	for _, secret := range []string{"sk-test-abcdefghijklmnop1234", "abcdefghijklmnopqrstuvwxyz0123", "hunter2", "fake-stripe-value"} {
		if strings.Contains(md, secret) {
			t.Errorf("secret %q in the checkpoint", secret)
		}
	}
	if view.Redactions < 2 {
		t.Errorf("redactions: %d", view.Redactions)
	}
	if view.Transcript == nil || view.Transcript.Path != transcript || view.Transcript.Agent != "claude" {
		t.Errorf("pointer: %+v", view.Transcript)
	}
	if after := gitCmd(t, repo, "status", "--porcelain"); after != statusBefore {
		t.Fatalf("git status changed: %q -> %q", statusBefore, after)
	}
	entries, _ := os.ReadDir(repo)
	for _, e := range entries {
		if e.Name() != ".git" && e.Name() != "src" {
			t.Fatalf("something written in the workspace folder: %s", e.Name())
		}
	}

	// A second turn right away waits for the 10 s window.
	h.clock.add(2 * time.Second)
	h.u.TurnEnded("b1", "claude")
	h.u.TurnEnded("b1", "claude")
	delays = h.runScheduled()
	if len(delays) != 1 || delays[0] < WorkspaceInterval-3*time.Second {
		t.Fatalf("at most once per %v: %v", WorkspaceInterval, delays)
	}
}

func TestUpdaterKeepsUserEdits(t *testing.T) {
	repo := makeRepo(t, "feature/42-login")
	roots := t.TempDir()
	transcript := filepath.Join(roots, "claude", "projects", companion.ClaudeSlug(repo), "aaaaaaaa-1111-2222-3333-444444444444.jsonl")
	writeFixture(t, "claude-turn.jsonl", transcript, repo)
	h := makeHarness(t, roots)
	h.addPane(&testPane{blockId: "b1", wsId: "ws-1", agent: "claude", path: transcript, folder: repo, state: molten.AgentStateDone})
	h.u.TurnEnded("b1", "claude")
	h.runScheduled()

	// The user edits Goal and Next steps in the editor and saves (TC-CONT-009).
	path, _ := h.store.Path("ws-1")
	data, _ := os.ReadFile(path)
	text := string(data)
	start := strings.Index(text, "## Goal\n")
	end := strings.Index(text, "## Ticket\n")
	text = text[:start] + "## Goal\n<!-- by auto at 2026-10-07T10:00:00Z sha 00000000 -->\n\nMy goal, rewritten\n\n" + text[end:]
	text = strings.Replace(text, "## Next steps\n", "## Next steps\n\nRun the e2e suite\n", 1)
	os.WriteFile(path, []byte(text), 0o600)

	f, _ := os.OpenFile(transcript, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString(`{"type":"assistant","message":{"id":"m9","role":"assistant","content":[{"type":"tool_use","id":"toolu_9","name":"TodoWrite","input":{"todos":[{"content":"Write the login form","status":"completed"},{"content":"Test the login form","status":"completed"}]}}]},"sessionId":"aaaaaaaa-1111-2222-3333-444444444444","timestamp":"2026-10-07T10:05:00.000Z"}` + "\n")
	f.WriteString(`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_10","content":"ok"}]},"toolUseResult":{"type":"create","filePath":"` + repo + `/docs/login.md","content":"x","structuredPatch":[]},"sessionId":"aaaaaaaa-1111-2222-3333-444444444444","timestamp":"2026-10-07T10:05:01.000Z"}` + "\n")
	f.Close()
	for i := 0; i < 2; i++ {
		h.clock.add(WorkspaceInterval)
		h.u.TurnEnded("b1", "claude")
		h.runScheduled()
	}
	c, _, _ := h.store.Read("ws-1")
	if c.Section(SectionGoal).Body != "My goal, rewritten" || c.Section(SectionNext).Body != "Run the e2e suite" {
		t.Fatalf("user edits overwritten:\n%s", c.Render())
	}
	if !strings.Contains(c.Section(SectionPlan).Body, "2 of 2 done.") || !strings.Contains(c.Section(SectionFiles).Body, "docs/login.md") {
		t.Fatalf("auto sections not updated:\n%s", c.Render())
	}
}

func TestUpdaterCodexFromTranscript(t *testing.T) {
	repo := makeRepo(t, "fix/ABC-12-rate-limit")
	roots := t.TempDir()
	transcript := filepath.Join(roots, "codex", "sessions", "2026", "10", "07", "rollout-2026-10-07T11-00-00-0199bbbb-cccc-7ddd-8eee-ffff00001111.jsonl")
	writeFixture(t, "codex-turn.jsonl", transcript, repo)
	h := makeHarness(t, roots)
	h.addPane(&testPane{blockId: "b2", wsId: "ws-2", agent: "codex", path: transcript, folder: repo, state: molten.AgentStateIdle})

	// No hook: the poll links the session and updates.
	h.u.Tick()
	h.runScheduled()
	c, exists, _ := h.store.Read("ws-2")
	if !exists {
		t.Fatal("no checkpoint from the transcript")
	}
	md := string(c.Render())
	for _, want := range []string{"Add rate limiting to the login endpoint", "ABC-12, on branch `fix/ABC-12-rate-limit`", "- [x] Read the login handler", "- [ ] Add the limiter (in progress)", "`src/limiter.go` (added)", "`src/login.go` (modified)", "`0199bbbb-cccc-7ddd-8eee-ffff00001111`", "Codex"} {
		if !strings.Contains(md, want) {
			t.Errorf("checkpoint lacks %q:\n%s", want, md)
		}
	}

	// A turn ends in the transcript while the agent works: the turn end triggers on its own.
	h.lock.Lock()
	h.panes["b2"].state = molten.AgentStateWorking
	h.lock.Unlock()
	h.clock.add(time.Minute)
	f, _ := os.OpenFile(transcript, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString(`{"timestamp":"2026-10-07T11:01:00.000Z","type":"event_msg","payload":{"type":"plan_update","plan":[{"step":"Read the login handler","status":"completed"},{"step":"Add the limiter","status":"completed"}]}}` + "\n")
	f.WriteString(`{"timestamp":"2026-10-07T11:01:01.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"t2"}}` + "\n")
	f.Close()
	h.u.Tick()
	if delays := h.runScheduled(); len(delays) != 1 {
		t.Fatalf("a transcript turn end triggers: %v", delays)
	}
	c, _, _ = h.store.Read("ws-2")
	if !strings.Contains(c.Section(SectionPlan).Body, "2 of 2 done.") {
		t.Fatalf("plan: %q", c.Section(SectionPlan).Body)
	}
	// Nothing new: no update.
	h.clock.add(time.Minute)
	h.u.Tick()
	if delays := h.runScheduled(); len(delays) != 0 {
		t.Fatalf("no news, no update: %v", delays)
	}
}

func TestUpdaterTwoWorkspacesSameFolder(t *testing.T) {
	repo := makeRepo(t, "feature/42-login")
	roots := t.TempDir()
	claudeT := filepath.Join(roots, "claude", "projects", companion.ClaudeSlug(repo), "aaaaaaaa-1111-2222-3333-444444444444.jsonl")
	writeFixture(t, "claude-turn.jsonl", claudeT, repo)
	codexT := filepath.Join(roots, "codex", "sessions", "2026", "10", "07", "rollout-2026-10-07T11-00-00-0199bbbb-cccc-7ddd-8eee-ffff00001111.jsonl")
	writeFixture(t, "codex-turn.jsonl", codexT, repo)
	h := makeHarness(t, roots)
	h.addPane(&testPane{blockId: "b1", wsId: "ws-a", agent: "claude", path: claudeT, folder: repo, state: molten.AgentStateDone})
	h.addPane(&testPane{blockId: "b2", wsId: "ws-b", agent: "codex", path: codexT, folder: repo, state: molten.AgentStateDone})
	h.u.TurnEnded("b1", "claude")
	h.u.TurnEnded("b2", "codex")
	h.runScheduled()
	a, _, _ := h.store.Read("ws-a")
	b, _, _ := h.store.Read("ws-b")
	if !strings.Contains(a.Section(SectionGoal).Body, "login page") || !strings.Contains(b.Section(SectionGoal).Body, "rate limiting") {
		t.Fatalf("each workspace has its own checkpoint:\n%s\n%s", a.Render(), b.Render())
	}
}

func TestUpdaterConcurrentTriggers(t *testing.T) {
	repo := makeRepo(t, "feature/42-login")
	roots := t.TempDir()
	transcript := filepath.Join(roots, "claude", "projects", companion.ClaudeSlug(repo), "aaaaaaaa-1111-2222-3333-444444444444.jsonl")
	writeFixture(t, "claude-turn.jsonl", transcript, repo)
	h := makeHarness(t, roots)
	h.addPane(&testPane{blockId: "b1", wsId: "ws-1", agent: "claude", path: transcript, folder: repo, state: molten.AgentStateDone})
	h.addPane(&testPane{blockId: "b3", wsId: "ws-1", agent: "claude", path: transcript, folder: repo, state: molten.AgentStateIdle})
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(3)
		go func() { defer wg.Done(); h.u.TurnEnded("b1", "claude") }()
		go func() { defer wg.Done(); h.u.Tick() }()
		go func() { defer wg.Done(); h.runScheduled() }()
	}
	wg.Wait()
	h.runScheduled()
	h.u.ForgetBlock("b1")
	h.u.ForgetBlock("b3")
	c, exists, err := h.store.Read("ws-1")
	if err != nil || !exists || !strings.Contains(c.Section(SectionGoal).Body, "login page") {
		t.Fatalf("after concurrent triggers: %v %v", exists, err)
	}
}

func TestReadGitState(t *testing.T) {
	repo := makeRepo(t, "feature/7-x")
	g := ReadGitState(repo)
	if !g.Repo || g.Branch != "feature/7-x" || g.HasUpstream {
		t.Fatalf("git state: %+v", g)
	}
	gitCmd(t, repo, "checkout", "-q", "--detach")
	g = ReadGitState(repo)
	if g.Branch != "" || g.Detached == "" {
		t.Fatalf("detached: %+v", g)
	}
	if g := ReadGitState(t.TempDir()); g.Repo {
		t.Fatalf("not a repository: %+v", g)
	}
}
