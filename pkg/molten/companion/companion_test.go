// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// The fixtures in testdata are written by hand: invented content in the shape of the agents' transcripts.

func parseFile(t *testing.T, a Adapter, s *Session, name string) {
	t.Helper()
	f, err := os.Open(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		var rec map[string]any
		if json.Unmarshal(scanner.Bytes(), &rec) != nil {
			s.countLine(false, false)
			continue
		}
		s.countLine(true, a.Parse(rec, s))
	}
}

func TestClaudeSession(t *testing.T) {
	s := MakeSession()
	parseFile(t, MakeClaudeAdapter([]string{"/nowhere"}), s, "claude-session.jsonl")
	if s.Unsupported() {
		t.Fatal("a Claude Code transcript must be supported")
	}
	if s.Format != "Claude Code 2.1.300" {
		t.Errorf("format: %q", s.Format)
	}
	answers := s.Answers()
	if len(answers) != 1 {
		t.Fatalf("answers: %+v", answers)
	}
	latest, ok := s.Answer(0)
	if !ok || !strings.HasPrefix(latest.Markdown, "Done. Run it with:") || strings.Contains(latest.Markdown, "Let me look") {
		t.Errorf("the answer is the text after the turn's last tool call: %q", latest.Markdown)
	}
	todos := s.Todos()
	if len(todos) != 2 || todos[0].Status != TodoInProgress || todos[1].Text != "Run the tests" {
		t.Errorf("todos: %+v", todos)
	}
	files := s.Files()
	if len(files) != 2 || files[0].Path != "/work/demo/notes.md" || files[0].Kind != FileAdded || files[0].Added != 2 {
		t.Fatalf("files, newest first: %+v", files)
	}
	if files[1].Path != "/work/demo/hello.go" || files[1].Added != 2 || files[1].Removed != 1 {
		t.Errorf("hello.go: %+v", files[1])
	}
	diff, _ := s.Diff("/work/demo/hello.go")
	if !strings.HasPrefix(diff.Diff, "@@ -3,2 +3,3 @@\n func main() {\n") {
		t.Errorf("diff: %q", diff.Diff)
	}
	pending := s.Pending()
	if len(pending) != 1 || pending[0].Tool != "Bash" || !strings.Contains(pending[0].Args, "rm notes.md") {
		t.Errorf("pending: %+v", pending)
	}
}

func TestCodexSession(t *testing.T) {
	a := MakeCodexAdapter([]string{"/nowhere"})
	s := MakeSession()
	parseFile(t, a, s, "codex-session.jsonl")
	if s.Format != "Codex 0.160.0" {
		t.Errorf("format: %q", s.Format)
	}
	pending := s.Pending()
	if len(pending) != 1 || !pending[0].Approval || pending[0].Tool != "exec" {
		t.Fatalf("an approval request is a pending permission: %+v", pending)
	}
	todos := s.Todos()
	if len(todos) != 2 || todos[0].Status != TodoCompleted || todos[1].Status != TodoInProgress {
		t.Errorf("plan: %+v", todos)
	}
	parseFile(t, a, s, "codex-session-more.jsonl")
	if len(s.Pending()) != 0 {
		t.Errorf("the output ends the request: %+v", s.Pending())
	}
	files := s.Files()
	if len(files) != 2 {
		t.Fatalf("files: %+v", files)
	}
	byPath := map[string]FileInfo{}
	for _, f := range files {
		byPath[f.Path] = f
	}
	readme := byPath["/work/demo/README.md"]
	if readme.Edits != 1 || readme.Added != 1 || readme.Removed != 1 {
		t.Errorf("the same patch reported twice counts once: %+v", readme)
	}
	if byPath["/work/demo/docs/new.md"].Kind != FileAdded {
		t.Errorf("relative paths join the session folder: %+v", files)
	}
	latest, _ := s.Answer(0)
	if latest.Markdown != "Fixed the typo in `README.md`." {
		t.Errorf("answer: %q", latest.Markdown)
	}
	if len(s.Answers()) != 1 {
		t.Errorf("one prompt makes one turn: %+v", s.Answers())
	}
}

func TestUnsupportedFormat(t *testing.T) {
	s := MakeSession()
	a := MakeClaudeAdapter([]string{"/nowhere"})
	for i := 0; i < unsupportedMinLines; i++ {
		var rec map[string]any
		json.Unmarshal([]byte(`{"kind":"message","body":"x"}`), &rec)
		s.countLine(true, a.Parse(rec, s))
	}
	if !s.Unsupported() {
		t.Error("records of no known shape make an unsupported format")
	}
	s = MakeSession()
	for i := 0; i < 3*unsupportedMinLines; i++ {
		s.countLine(false, false)
	}
	s.countLine(true, true)
	if !s.Unsupported() {
		t.Error("mostly non-JSON lines make an unsupported format")
	}
}

func TestSessionCaps(t *testing.T) {
	s := MakeSession()
	for i := 0; i < MaxAnswers+20; i++ {
		s.StartTurn(int64(i))
		s.AddText(fmt.Sprintf("answer %d", i), int64(i))
	}
	if n := len(s.Answers()); n != MaxAnswers {
		t.Errorf("answers kept: %d", n)
	}
	for i := 0; i < MaxFiles+5; i++ {
		s.AddFileEdit(fmt.Sprintf("/f/%d", i), FileUpdated, "+x\n", int64(i))
	}
	files := s.Files()
	if len(files) != MaxFiles || files[0].Path != fmt.Sprintf("/f/%d", MaxFiles+4) {
		t.Errorf("files kept: %d, newest %s", len(files), files[0].Path)
	}
	big := "+" + strings.Repeat("y", MaxDiffBytes/2) + "\n"
	for i := 0; i < 4; i++ {
		s.AddFileEdit("/big", FileUpdated, big, 0)
	}
	d, _ := s.Diff("/big")
	if len(d.Diff) > MaxDiffBytes || !d.Truncated {
		t.Errorf("diff size %d, truncated %v", len(d.Diff), d.Truncated)
	}
	s.AddToolCall("t", "Edit", strings.Repeat("z", 3*MaxArgsBytes), 0)
	if p := s.Pending(); len(p[len(p)-1].Args) > MaxArgsBytes {
		t.Error("arguments are cut")
	}
}

func appendFile(t *testing.T, path string, data string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(data); err != nil {
		t.Fatal(err)
	}
}

func TestFollower(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	appendFile(t, path, `{"a":1}`+"\n"+`{"b":`)
	f, err := openFollower(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.close()
	var lines []string
	emit := func(line []byte) { lines = append(lines, string(line)) }
	f.poll(emit)
	if len(lines) != 1 || lines[0] != `{"a":1}` {
		t.Fatalf("a half-written line waits: %q", lines)
	}
	appendFile(t, path, "2}\n")
	f.poll(emit)
	if len(lines) != 2 || lines[1] != `{"b":2}` {
		t.Fatalf("completed line: %q", lines)
	}
	// A line longer than the cap is skipped whole, the next one is read.
	appendFile(t, path, strings.Repeat("x", tailLineMax+10)+"\n"+`{"c":3}`+"\n")
	for i := 0; i < 8; i++ {
		f.poll(emit)
	}
	if len(lines) != 3 || lines[2] != `{"c":3}` {
		t.Fatalf("after a long line: %d lines", len(lines))
	}
	// Truncated: read from the start again.
	os.WriteFile(path, []byte(`{"d":4}`+"\n"), 0o600)
	reset, _, _ := f.poll(emit)
	if !reset {
		t.Error("a truncated file resets")
	}
	f.poll(emit)
	if lines[len(lines)-1] != `{"d":4}` {
		t.Errorf("after truncation: %q", lines[len(lines)-1])
	}
	// Replaced by another file (rotation).
	tmp := filepath.Join(dir, "new.jsonl")
	os.WriteFile(tmp, []byte(`{"e":5}`+"\n"+`{"f":6}`+"\n"), 0o600)
	os.Rename(tmp, path)
	reset, _, _ = f.poll(emit)
	if !reset {
		t.Error("a replaced file resets")
	}
	f.poll(emit)
	if lines[len(lines)-1] != `{"f":6}` {
		t.Errorf("after replacement: %q", lines)
	}
}

func TestValidateSessionPath(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	a := MakeClaudeAdapter([]string{root})
	good := filepath.Join(root, "-work-demo", "abc.jsonl")
	os.MkdirAll(filepath.Dir(good), 0o700)
	os.WriteFile(good, []byte("{}\n"), 0o600)
	if _, err := ValidateSessionPath(a, good); err != nil {
		t.Errorf("a session under the root: %v", err)
	}
	secret := filepath.Join(outside, "secret.jsonl")
	os.WriteFile(secret, []byte("{}\n"), 0o600)
	link := filepath.Join(root, "-work-demo", "link.jsonl")
	os.Symlink(secret, link)
	deep := filepath.Join(root, "-work-demo", "abc", "subagents", "x.jsonl")
	os.MkdirAll(filepath.Dir(deep), 0o700)
	os.WriteFile(deep, []byte("{}\n"), 0o600)
	txt := filepath.Join(root, "-work-demo", "notes.txt")
	os.WriteFile(txt, []byte("x"), 0o600)
	for _, bad := range []string{
		secret,
		link,
		filepath.Join(root, "-work-demo", "..", "..", filepath.Base(outside), "secret.jsonl"),
		deep,
		txt,
		"relative/abc.jsonl",
		filepath.Join(root, "-work-demo", "missing.jsonl"),
	} {
		if _, err := ValidateSessionPath(a, bad); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
	c := MakeCodexAdapter([]string{root})
	if !c.ValidLayout("2026/10/04/rollout-2026-10-04T09-00-00-x.jsonl") || c.ValidLayout("2026/10/rollout-x.jsonl") {
		t.Error("codex layout")
	}
}

func TestChooseCandidate(t *testing.T) {
	start := int64(100_000)
	before := Candidate{Path: "old", Started: start - 60_000}
	after := Candidate{Path: "new", Started: start + 1_000, Modified: start + 1_500}
	other := Candidate{Path: "other", Started: start + 2_000, Modified: start + 2_500}
	if c, amb := chooseCandidate([]Candidate{after}, 1, start, 1); c == nil || amb {
		t.Error("the only session started after the agent is linked")
	}
	if _, amb := chooseCandidate([]Candidate{before}, 0, start, 1); !amb {
		t.Error("a session neither started nor written since the agent started is never linked without the user")
	}
	if c, amb := chooseCandidate([]Candidate{after, before}, 1, start, 1); c == nil || c.Path != "new" || amb {
		t.Error("the only session started after the agent is linked")
	}
	if _, amb := chooseCandidate([]Candidate{after, other}, 2, start, 1); !amb {
		t.Error("two new sessions are ambiguous")
	}
	if _, amb := chooseCandidate([]Candidate{after}, 1, start, 2); !amb {
		t.Error("two agents in the same folder are ambiguous, even with one session")
	}

	// Resumed sessions (claude --resume): started before the agent, written since.
	resumed := Candidate{Path: "resumed", Started: start - 3_600_000, Modified: start + 5_000}
	unknown := Candidate{Path: "unknown", Modified: start + 5_000}
	if c, amb := chooseCandidate([]Candidate{resumed}, 1, start, 1); c == nil || c.Path != "resumed" || amb {
		t.Error("the only session written since the agent started is its resumed session")
	}
	if c, amb := chooseCandidate([]Candidate{unknown}, 1, start, 1); c == nil || amb {
		t.Error("a session of unknown start written since the agent started is linked when it is the only one")
	}
	if _, amb := chooseCandidate([]Candidate{resumed, unknown}, 2, start, 1); !amb {
		t.Error("two sessions written since the agent started are ambiguous")
	}
	if _, amb := chooseCandidate([]Candidate{resumed}, 2, start, 1); !amb {
		t.Error("another terminal's session written since the agent started makes the resumed one ambiguous")
	}
	if _, amb := chooseCandidate([]Candidate{resumed}, 1, start, 2); !amb {
		t.Error("another pane running the agent in the folder makes the resumed session ambiguous")
	}
	if _, amb := chooseCandidate([]Candidate{{Path: "slack", Started: start - 60_000, Modified: start - 1_000}}, 0, start, 1); !amb {
		t.Error("a session last written just before the agent started is not taken as resumed")
	}
}

func TestClaudeDiscover(t *testing.T) {
	root := t.TempDir()
	cwd := t.TempDir()
	dir := filepath.Join(root, ClaudeSlug(cwd))
	os.MkdirAll(dir, 0o700)
	start := time.Now()
	line := func(dir string) string {
		return fmt.Sprintf(`{"type":"user","cwd":%q,"sessionId":"s","timestamp":%q,"message":{"role":"user","content":"hello"}}`+"\n", dir, start.UTC().Format(time.RFC3339Nano))
	}
	os.WriteFile(filepath.Join(dir, "mine.jsonl"), []byte(line(cwd)), 0o600)
	os.WriteFile(filepath.Join(dir, "elsewhere.jsonl"), []byte(line("/some/other/dir")), 0o600)
	old := filepath.Join(dir, "old.jsonl")
	os.WriteFile(old, []byte(line(cwd)), 0o600)
	os.Chtimes(old, start.Add(-time.Hour), start.Add(-time.Hour))
	got := MakeClaudeAdapter([]string{root}).Discover(cwd, start)
	if len(got) != 1 || filepath.Base(got[0].Path) != "mine.jsonl" || got[0].Prompt != "hello" {
		t.Errorf("discover: %+v", got)
	}
}

type fakeEnv struct {
	lock  sync.Mutex
	runs  map[string]molten.AgentRunInfo
	cwds  map[string]string
	views map[string]CompanionView
}

func makeTestManager(env *fakeEnv, root string) *Manager {
	m := MakeManager()
	m.tick = 10 * time.Millisecond
	m.runOf = func(blockId string) (molten.AgentRunInfo, bool) {
		env.lock.Lock()
		defer env.lock.Unlock()
		r, ok := env.runs[blockId]
		return r, ok
	}
	m.allRuns = func() []molten.AgentRunInfo {
		env.lock.Lock()
		defer env.lock.Unlock()
		var rtn []molten.AgentRunInfo
		for _, r := range env.runs {
			rtn = append(rtn, r)
		}
		return rtn
	}
	m.blockInfo = func(blockId string) (blockInfo, error) {
		env.lock.Lock()
		defer env.lock.Unlock()
		return blockInfo{cwd: env.cwds[blockId], term: true}, nil
	}
	m.publish = func(v CompanionView) {
		env.lock.Lock()
		defer env.lock.Unlock()
		env.views[v.BlockId] = v
	}
	m.adapterFor = func(agent string) Adapter {
		if agent == "claude" {
			return MakeClaudeAdapter([]string{root})
		}
		return nil
	}
	return m
}

func waitView(t *testing.T, env *fakeEnv, blockId string, ok func(CompanionView) bool) CompanionView {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
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

func TestManagerFollowsSession(t *testing.T) {
	root := t.TempDir()
	cwd := t.TempDir()
	dir := filepath.Join(root, ClaudeSlug(cwd))
	os.MkdirAll(dir, 0o700)
	start := time.Now().Add(-time.Second)
	env := &fakeEnv{
		runs:  map[string]molten.AgentRunInfo{"b1": {BlockId: "b1", Agent: "claude", Started: start.UnixMilli(), Running: true}, "b3": {BlockId: "b3", Agent: "gemini", Running: true}},
		cwds:  map[string]string{"b1": cwd, "b2": cwd, "b3": cwd},
		views: map[string]CompanionView{},
	}
	m := makeTestManager(env, root)
	defer m.Close("b1", "v")
	defer m.Close("b2", "v")
	defer m.Close("b3", "v")

	m.Open("b3", "v")
	waitView(t, env, "b3", func(v CompanionView) bool { return v.Status == StatusUnsupportedAgent })

	m.Open("b1", "v")
	waitView(t, env, "b1", func(v CompanionView) bool { return v.Status == StatusSearching })
	session := filepath.Join(dir, "s1.jsonl")
	data, _ := os.ReadFile(filepath.Join("testdata", "claude-session.jsonl"))
	text := strings.ReplaceAll(string(data), `"cwd":"/work/demo"`, fmt.Sprintf("%q:%q", "cwd", cwd))
	text = regexp.MustCompile(`2026-10-04T10:0\d:\d\d\.000Z`).ReplaceAllString(text, time.Now().UTC().Format(time.RFC3339Nano))
	os.WriteFile(session, []byte(text), 0o600)
	v := waitView(t, env, "b1", func(v CompanionView) bool { return v.Status == StatusLive && len(v.Files) == 2 })
	if v.Session == nil || v.Session.LinkedBy != LinkDiscovery || v.Latest == nil {
		t.Fatalf("linked: %+v", v)
	}
	appendFile(t, session, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"All gone."}]},"sessionId":"s","timestamp":"2026-10-04T10:01:02.000Z"}`+"\n")
	v = waitView(t, env, "b1", func(v CompanionView) bool { return v.Latest != nil && v.Latest.Markdown == "All gone." })
	if len(v.Answers) != 2 {
		t.Errorf("answers: %+v", v.Answers)
	}
	if _, err := m.Diff("b1", v.Files[0].Path); err != nil {
		t.Error(err)
	}
	if a, err := m.Answer("b1", v.Answers[0].Index); err != nil || !strings.HasPrefix(a.Markdown, "Done.") {
		t.Errorf("earlier answer: %+v %v", a, err)
	}

	// A second Claude Code in the same folder: its companion never takes the first one's session; with two agents in
	// the folder it cannot be sure, so it opens on its guess, and the user's pick replaces it.
	env.lock.Lock()
	env.runs["b2"] = molten.AgentRunInfo{BlockId: "b2", Agent: "claude", Started: start.UnixMilli(), Running: true}
	env.lock.Unlock()
	m.Open("b2", "v")
	waitView(t, env, "b2", func(v CompanionView) bool { return v.Status == StatusSearching })
	session2 := filepath.Join(dir, "s2.jsonl")
	os.WriteFile(session2, []byte(text), 0o600)
	v2 := waitView(t, env, "b2", func(v CompanionView) bool { return v.Session != nil && v.Status == StatusLive })
	if v2.Session.Path != canonicalPath(session2) || v2.Session.LinkedBy != LinkGuessed || v2.Session.Guess != GuessStarted {
		t.Fatalf("guessed: %+v", v2.Session)
	}
	if list, err := m.Sessions("b2", "v"); err != nil || len(list) != 1 || !list[0].Current || list[0].Path != canonicalPath(session2) {
		t.Fatalf("history: %+v %v", list, err)
	}
	if _, err := m.Pick("b2", "v", session); err == nil {
		t.Error("another terminal's session cannot be picked")
	}
	if _, err := m.Pick("b2", "v", session2); err != nil {
		t.Fatal(err)
	}
	v2 = waitView(t, env, "b2", func(v CompanionView) bool { return v.Session != nil && v.Session.LinkedBy == LinkPicked })
	if v2.Session.Guess != "" {
		t.Errorf("picked: %+v", v2.Session)
	}

	// A hook's report wins over discovery; a path outside the session folder is refused.
	if err := m.ReportSession(molten.AgentSessionRequest{BlockId: "b1", Agent: "claude", Path: "/etc/passwd.jsonl"}); err == nil {
		t.Error("a path outside the session root is refused")
	}
	session3 := filepath.Join(dir, "s3.jsonl")
	os.WriteFile(session3, []byte(text), 0o600)
	if err := m.ReportSession(molten.AgentSessionRequest{BlockId: "b1", Path: session3}); err != nil {
		t.Fatal(err)
	}
	waitView(t, env, "b1", func(v CompanionView) bool {
		return v.Session != nil && v.Session.LinkedBy == LinkHook && filepath.Base(v.Session.Path) == "s3.jsonl"
	})

	// The agent exits: its last session stays, marked ended.
	env.lock.Lock()
	delete(env.runs, "b1")
	env.lock.Unlock()
	m.ForgetBlock("b1")
	if len(m.OpenBlocks()) != 2 {
		t.Errorf("open: %v", m.OpenBlocks())
	}
}

func TestUnsupportedFile(t *testing.T) {
	root := t.TempDir()
	cwd := t.TempDir()
	dir := filepath.Join(root, ClaudeSlug(cwd))
	os.MkdirAll(dir, 0o700)
	env := &fakeEnv{
		runs:  map[string]molten.AgentRunInfo{"b1": {BlockId: "b1", Agent: "claude", Started: time.Now().Add(-time.Minute).UnixMilli(), Running: true}},
		cwds:  map[string]string{"b1": cwd},
		views: map[string]CompanionView{},
	}
	m := makeTestManager(env, root)
	defer m.Close("b1", "v")
	os.WriteFile(filepath.Join(dir, "s.jsonl"), []byte(strings.Repeat(`{"kind":"x"}`+"\n", 8)), 0o600)
	m.Open("b1", "v")
	// A transcript without timestamps has no known start, but it is the only session written since the agent started.
	v := waitView(t, env, "b1", func(v CompanionView) bool { return v.Status == StatusUnsupportedFormat })
	if len(v.Files) != 0 || v.Latest != nil {
		t.Errorf("nothing shown of an unsupported format: %+v", v)
	}
}

func writeNowSession(t *testing.T, path string, cwd string, text string) {
	t.Helper()
	line := fmt.Sprintf(`{"type":"user","cwd":%q,"sessionId":"s","timestamp":%q,"message":{"role":"user","content":"go"}}`+"\n", cwd, time.Now().UTC().Format(time.RFC3339Nano))
	line += fmt.Sprintf(`{"type":"assistant","sessionId":"s","timestamp":%q,"message":{"role":"assistant","content":[{"type":"text","text":%q}]}}`+"\n", time.Now().UTC().Format(time.RFC3339Nano), text)
	os.WriteFile(path, []byte(line), 0o600)
}

// A session discovery linked to the wrong pane goes to the pane whose hook reports it.
func TestDiscoveryGivesWayToReport(t *testing.T) {
	root := t.TempDir()
	cwd := t.TempDir()
	dir := filepath.Join(root, ClaudeSlug(cwd))
	os.MkdirAll(dir, 0o700)
	start := time.Now().Add(-time.Second).UnixMilli()
	env := &fakeEnv{
		runs:  map[string]molten.AgentRunInfo{"a": {BlockId: "a", Agent: "claude", Started: start, Running: true}},
		cwds:  map[string]string{"a": cwd, "b": cwd},
		views: map[string]CompanionView{},
	}
	m := makeTestManager(env, root)
	defer m.Close("a", "v")
	defer m.Close("b", "v")
	p := filepath.Join(dir, "p.jsonl")
	writeNowSession(t, p, cwd, "from b")
	m.Open("a", "v")
	waitView(t, env, "a", func(v CompanionView) bool { return v.Session != nil && v.Session.LinkedBy == LinkDiscovery })
	env.lock.Lock()
	env.runs["b"] = molten.AgentRunInfo{BlockId: "b", Agent: "claude", Started: start, Running: true}
	env.lock.Unlock()
	if err := m.ReportSession(molten.AgentSessionRequest{BlockId: "b", Agent: "claude", Path: p}); err != nil {
		t.Fatal(err)
	}
	m.Open("b", "v")
	waitView(t, env, "b", func(v CompanionView) bool { return v.Session != nil && v.Session.LinkedBy == LinkHook })
	waitView(t, env, "a", func(v CompanionView) bool { return v.Session == nil })
	if err := m.ReportSession(molten.AgentSessionRequest{BlockId: "a", Agent: "claude", Path: p}); err == nil {
		t.Error("a session another terminal's hook reported cannot be reported again")
	}
}

// Each view holds its own lease: closing one keeps the follower of the other; the latest answer's markdown is sent
// again only when it changes.
func TestLeasesAndElidedAnswer(t *testing.T) {
	root := t.TempDir()
	cwd := t.TempDir()
	dir := filepath.Join(root, ClaudeSlug(cwd))
	os.MkdirAll(dir, 0o700)
	env := &fakeEnv{
		runs:  map[string]molten.AgentRunInfo{"a": {BlockId: "a", Agent: "claude", Started: time.Now().Add(-time.Second).UnixMilli(), Running: true}},
		cwds:  map[string]string{"a": cwd},
		views: map[string]CompanionView{},
	}
	m := makeTestManager(env, root)
	p := filepath.Join(dir, "p.jsonl")
	writeNowSession(t, p, cwd, "first")
	m.Open("a", "v1")
	m.Open("a", "v2")
	waitView(t, env, "a", func(v CompanionView) bool { return v.Latest != nil && v.Latest.Markdown == "first" })
	m.Close("a", "v1")
	if len(m.OpenBlocks()) != 1 {
		t.Fatal("the other view keeps the follower")
	}
	appendFile(t, p, `{"type":"assistant","sessionId":"s","message":{"role":"assistant","content":[{"type":"tool_use","id":"x","name":"Bash","input":{}}]}}`+"\n")
	v := waitView(t, env, "a", func(v CompanionView) bool { return len(v.Pending) == 1 })
	if v.Latest == nil || !v.Latest.Elided || v.Latest.Markdown != "" {
		t.Errorf("unchanged answer elided: %+v", v.Latest)
	}
	if full, _ := m.Open("a", "v2"); full.Latest == nil || full.Latest.Markdown != "first" {
		t.Errorf("open returns the whole answer: %+v", full.Latest)
	}
	m.Close("a", "v2")
	if len(m.OpenBlocks()) != 0 {
		t.Error("the last view stops the follower")
	}
}

func TestLargeRecordsAndArgs(t *testing.T) {
	w := &watcher{adapter: MakeClaudeAdapter([]string{"/nowhere"})}
	s := MakeSession()
	s.AddToolCall("big", "Read", "{}", 0)
	huge := `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"big","content":"` + strings.Repeat("z", largeRecordBytes+10) + `"}]}}`
	w.parseLine(s, []byte(huge))
	if len(s.Pending()) != 0 {
		t.Error("a large tool result still ends its call")
	}
	args := argsJSON(map[string]any{"file_path": "/a", "content": strings.Repeat("c", 10_000)})
	if len(args) > 2*argStringMax || !strings.Contains(args, "/a") {
		t.Errorf("long arguments are cut before marshalling: %d bytes", len(args))
	}
}
