// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// #2142: discovery and the work folders read a transcript again only when it may say something new. The tests count
// the transcripts opened (openTranscript); every transcript is synthetic, under t.TempDir().

type openCounter struct {
	lock   sync.Mutex
	counts map[string]int
}

// countOpens counts the transcripts the companion's readers open until the test ends.
func countOpens(t *testing.T) *openCounter {
	c := &openCounter{counts: map[string]int{}}
	prev := openTranscript
	openTranscript = func(path string) (*os.File, error) {
		c.lock.Lock()
		c.counts[path]++
		c.lock.Unlock()
		return os.Open(path)
	}
	t.Cleanup(func() { openTranscript = prev })
	return c
}

func (c *openCounter) of(path string) int {
	c.lock.Lock()
	defer c.lock.Unlock()
	return c.counts[path]
}

func (c *openCounter) total() int {
	c.lock.Lock()
	defer c.lock.Unlock()
	n := 0
	for _, v := range c.counts {
		n += v
	}
	return n
}

func (c *openCounter) reset() {
	c.lock.Lock()
	defer c.lock.Unlock()
	c.counts = map[string]int{}
}

// forgetTranscriptCaches empties the caches, so a read gives what the files say now.
func forgetTranscriptCaches() {
	discoveryHeads = makeFileCache[headFacts](maxDiscoveryHeads)
	workTails = makeFileCache[workTail](maxWorkTails)
}

func appendLines(t *testing.T, path string, lines ...string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(strings.Join(lines, "\n") + "\n"); err != nil {
		t.Fatal(err)
	}
}

// replaceFile puts content at path through another file, as an atomic save does.
func replaceFile(t *testing.T, path string, content string, mod time.Time) {
	t.Helper()
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	if !mod.IsZero() {
		if err := os.Chtimes(tmp, mod, mod); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Rename(tmp, path); err != nil {
		t.Fatal(err)
	}
}

func candidatePaths(cs []Candidate) []string {
	var rtn []string
	for _, c := range cs {
		rtn = append(rtn, filepath.Base(c.Path)+":"+c.Prompt)
	}
	return rtn
}

// AC-3: discovery of an unchanged session folder reads no transcript again; a session only appended to is checked by
// its first bytes, never decoded again.
func TestDiscoveryReadsAnUnchangedFolderOnce(t *testing.T) {
	adapter, cwd, paths := claudeTestFolder(t, 5, 64*1024)
	since := time.Now().Add(-time.Hour)
	opens := countOpens(t)
	first := adapter.Discover(cwd, since)
	if len(first) != 5 || opens.total() != 5 {
		t.Fatalf("first discovery: %d candidates, %d transcripts opened", len(first), opens.total())
	}
	opens.reset()
	for i := 0; i < 3; i++ {
		again := adapter.Discover(cwd, since)
		if !reflect.DeepEqual(again, first) {
			t.Fatalf("unchanged folder: %v, want %v", candidatePaths(again), candidatePaths(first))
		}
	}
	if opens.total() != 0 {
		t.Fatalf("an unchanged folder opened %d transcripts", opens.total())
	}

	// The agent writes on: the session is opened once to check its head, which is not decoded again.
	appendLines(t, paths[0], claudeTestRecord(cwd, "assistant", "more work", 32*1024))
	grown := adapter.Discover(cwd, since)
	if opens.of(paths[0]) != 1 || opens.total() != 1 {
		t.Fatalf("a grown session: %v opened", opens.counts)
	}
	if len(grown) != 5 || grown[0].Path != paths[0] || grown[0].Prompt != "fix the build" {
		t.Fatalf("a grown session: %v", candidatePaths(grown))
	}
	opens.reset()
	adapter.Discover(cwd, since)
	if opens.total() != 0 {
		t.Fatalf("a session checked since it grew is opened again: %v", opens.counts)
	}
}

// A session whose head was not complete is read again when it grows, a replaced one whatever its size and date, one
// rewritten in place when its first bytes changed: the cache never gives what the file said before.
func TestDiscoveryReadsAChangedHeadAgain(t *testing.T) {
	adapter, cwd, paths := claudeTestFolder(t, 2, 4*1024)
	since := time.Now().Add(-time.Hour)
	elsewhere := filepath.Join(filepath.Dir(cwd), "e")

	// No prompt yet: the head is read again once the first prompt is written.
	fresh := filepath.Join(filepath.Dir(paths[0]), "fresh.jsonl")
	writeWorkFolderLines(t, fresh, fmt.Sprintf(`{"type":"system","cwd":%q,"timestamp":%q}`, cwd, time.Now().UTC().Format(time.RFC3339Nano)))
	if got := promptOf(adapter.Discover(cwd, since), fresh); got != "" {
		t.Fatalf("no prompt yet: %q", got)
	}
	appendLines(t, fresh, claudeTestRecord(cwd, "user", "write the tests", 0))
	if got := promptOf(adapter.Discover(cwd, since), fresh); got != "write the tests" {
		t.Fatalf("first prompt written: %q", got)
	}

	// Replaced by another folder's session of the same size and date: another file, read again.
	info, _ := os.Stat(paths[0])
	data, _ := os.ReadFile(paths[0])
	replaceFile(t, paths[0], strings.ReplaceAll(string(data), cwd, padTo(elsewhere, len(cwd))), info.ModTime())
	if got := promptOf(adapter.Discover(cwd, since), paths[0]); got != "-" {
		t.Fatalf("replaced by another folder's session: still listed (%q)", got)
	}

	// Rewritten in place, longer, with another first prompt.
	var b strings.Builder
	b.WriteString(claudeTestRecord(cwd, "user", "another task", 0) + "\n")
	data, _ = os.ReadFile(paths[1])
	b.Write(data)
	if err := os.WriteFile(paths[1], []byte(b.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := promptOf(adapter.Discover(cwd, since), paths[1]); got != "another task" {
		t.Fatalf("rewritten in place: %q", got)
	}
}

// padTo makes a folder path of n bytes when it is shorter: a replaced session keeps its size.
func padTo(dir string, n int) string {
	if len(dir) >= n {
		return dir
	}
	padded := dir + strings.Repeat("x", n-len(dir))
	os.MkdirAll(padded, 0o755)
	return padded
}

// promptOf: the prompt discovery gives a session, "-" when it is not listed.
func promptOf(cs []Candidate, path string) string {
	for _, c := range cs {
		if c.Path == path {
			return c.Prompt
		}
	}
	return "-"
}

// Codex keeps every project's rollouts in the same dated folders: another folder's rollout is read once, then skipped
// unread while it grows.
func TestCodexDiscoverySkipsOtherFoldersUnread(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	dir := filepath.Join(root, now.Format("2006"), now.Format("01"), now.Format("02"))
	mine := t.TempDir()
	other := t.TempDir()
	rollout := func(name string, cwd string) string {
		path := filepath.Join(dir, "rollout-"+name+".jsonl")
		writeWorkFolderLines(t, path,
			fmt.Sprintf(`{"type":"session_meta","payload":{"id":%q,"cwd":%q,"timestamp":%q,"source":"cli"}}`, name, cwd, now.UTC().Format(time.RFC3339Nano)),
			`{"type":"event_msg","payload":{"type":"user_message","message":"hello"}}`)
		return path
	}
	minePath := rollout("mine", mine)
	otherPath := rollout("other", other)
	adapter := MakeCodexAdapter([]string{root})
	opens := countOpens(t)
	since := now.Add(-time.Hour)
	if got := adapter.Discover(mine, since); len(got) != 1 || got[0].Path != minePath {
		t.Fatalf("discover: %+v", got)
	}
	opens.reset()
	appendLines(t, otherPath, `{"type":"event_msg","payload":{"type":"agent_message","message":"working"}}`)
	if got := adapter.Discover(mine, since); len(got) != 1 || got[0].Path != minePath {
		t.Fatalf("discover again: %+v", got)
	}
	if opens.of(otherPath) > 1 || opens.of(minePath) != 0 {
		t.Fatalf("opened %v", opens.counts)
	}
	opens.reset()
	adapter.Discover(mine, since)
	if opens.total() != 0 {
		t.Fatalf("an unchanged folder opened %v", opens.counts)
	}
}

// A pane's work folder is read again only when its transcript changed: grown, or replaced by another file of the
// same size and date.
func TestWorkFolderReadsAnUnchangedTranscriptOnce(t *testing.T) {
	adapter, cwd, paths := claudeTestFolder(t, 1, 64*1024)
	m := MakeManager()
	m.adapterFor = func(string) Adapter { return adapter }
	started := time.Now().Add(-time.Hour).UnixMilli()
	m.runOf = func(blockId string) (molten.AgentRunInfo, bool) {
		return molten.AgentRunInfo{BlockId: blockId, Agent: molten.AgentIdClaude, Running: true, Started: started}, true
	}
	if err := m.recordReport("b1", molten.AgentIdClaude, paths[0], false, LinkHook); err != nil {
		t.Fatal(err)
	}
	opens := countOpens(t)
	for i := 0; i < 3; i++ {
		if got := m.PaneWorkFolder("b1", nil); got != cwd {
			t.Fatalf("work folder %q, want %q", got, cwd)
		}
	}
	if opens.total() != 1 {
		t.Fatalf("an unchanged transcript was opened %d times", opens.total())
	}
	tree := filepath.Join(filepath.Dir(cwd), "tree")
	appendLines(t, paths[0], claudeTestRecord(tree, "assistant", "in the worktree", 0))
	if got := m.PaneWorkFolder("b1", nil); got != tree {
		t.Fatalf("moved to a worktree: %q", got)
	}
	info, _ := os.Stat(paths[0])
	data, _ := os.ReadFile(paths[0])
	other := padTo(filepath.Join(filepath.Dir(cwd), "t"), len(tree))
	back := strings.ReplaceAll(string(data), `"cwd":"`+tree+`"`, `"cwd":"`+other+`"`)
	if len(back) != len(data) {
		t.Fatalf("test setup: sizes %d and %d", len(back), len(data))
	}
	replaceFile(t, paths[0], back, info.ModTime())
	if got := m.PaneWorkFolder("b1", nil); got != other {
		t.Fatalf("replaced by a transcript of the same size and date: %q", got)
	}
}

// countingAdapter counts the discoveries an adapter runs.
type countingAdapter struct {
	Adapter
	lock      sync.Mutex
	discovers int
}

func (a *countingAdapter) Discover(cwd string, since time.Time) []Candidate {
	a.lock.Lock()
	a.discovers++
	a.lock.Unlock()
	return a.Adapter.Discover(cwd, since)
}

func (a *countingAdapter) count() int {
	a.lock.Lock()
	defer a.lock.Unlock()
	return a.discovers
}

// linkTestManager: one Claude Code pane in cwd, its run started a minute ago.
func linkTestManager(adapter Adapter, cwd string) *Manager {
	m := MakeManager()
	m.adapterFor = func(string) Adapter { return adapter }
	started := time.Now().Add(-time.Minute).UnixMilli()
	run := molten.AgentRunInfo{BlockId: "b1", Agent: molten.AgentIdClaude, Started: started, Running: true}
	m.runOf = func(blockId string) (molten.AgentRunInfo, bool) {
		if blockId != "b1" {
			return molten.AgentRunInfo{}, false
		}
		return run, true
	}
	m.allRuns = func() []molten.AgentRunInfo { return []molten.AgentRunInfo{run} }
	m.blockInfo = func(blockId string) (blockInfo, error) { return blockInfo{cwd: cwd, term: true}, nil }
	return m
}

// AC-2: a pane linked by its hook is never rediscovered, and after a wavesrv restart (a fresh manager: no report) the
// next working report of its hook links it again.
func TestLinkedPaneIsNotRediscovered(t *testing.T) {
	inner, cwd, paths := claudeTestFolder(t, 3, 16*1024)
	adapter := &countingAdapter{Adapter: inner}
	resolved, _ := filepath.EvalSymlinks(paths[1])

	restarted := linkTestManager(adapter, cwd)
	if _, _, ok := restarted.LinkedSession("b1"); ok || adapter.count() == 0 {
		t.Fatalf("without a report three sessions written since the start are ambiguous: linked %v, %d discoveries", ok, adapter.count())
	}
	restarted.LinkTranscript("b1", molten.AgentIdClaude, paths[1])
	before := adapter.count()
	opens := countOpens(t)
	for i := 0; i < 10; i++ {
		if _, got, ok := restarted.LinkedSession("b1"); !ok || got != resolved {
			t.Fatalf("linked by the hook's working report: %q %v", got, ok)
		}
	}
	if adapter.count() != before || opens.total() != 0 {
		t.Fatalf("a linked pane: %d discoveries, %d transcripts opened", adapter.count()-before, opens.total())
	}

	// A link from SessionStart is never replaced by a later report's transcript.
	if err := restarted.ReportSession(molten.AgentSessionRequest{BlockId: "b1", Agent: molten.AgentIdClaude, Path: paths[2]}); err != nil {
		t.Fatal(err)
	}
	restarted.LinkTranscript("b1", molten.AgentIdClaude, paths[0])
	resolved2, _ := filepath.EvalSymlinks(paths[2])
	if _, got, _ := restarted.LinkedSession("b1"); got != resolved2 {
		t.Fatalf("the SessionStart link was replaced: %q", got)
	}

	// A transcript outside the agent's session folders is refused, and not checked again.
	outside := filepath.Join(t.TempDir(), "x.jsonl")
	writeWorkFolderLines(t, outside, claudeTestRecord(cwd, "user", "hi", 0))
	m := linkTestManager(adapter, cwd)
	m.LinkTranscript("b1", molten.AgentIdClaude, outside)
	if _, ok := m.storedReport("b1"); ok || !m.hasCurrentReport("b1", outside) {
		t.Fatal("a transcript outside the session folders is refused once and remembered")
	}
}

// The cached discovery links what a discovery without any cache links, after each change a session may go through:
// a new session (/clear), one resumed from before the start, one replaced, one moved to another folder.
func TestCachedDiscoveryLinksWhatAFreshOneLinks(t *testing.T) {
	adapter, cwd, paths := claudeTestFolder(t, 1, 8*1024)
	m := linkTestManager(adapter, cwd)
	dir := filepath.Dir(paths[0])
	check := func(step string, want string) {
		t.Helper()
		_, warm, warmOk := m.LinkedSession("b1")
		forgetTranscriptCaches()
		_, cold, coldOk := m.LinkedSession("b1")
		if warm != cold || warmOk != coldOk {
			t.Fatalf("%s: cached discovery links %q %v, a fresh one %q %v", step, warm, warmOk, cold, coldOk)
		}
		name := ""
		if warm != "" {
			name = filepath.Base(warm)
		}
		if want != "?" && name != want {
			t.Fatalf("%s: linked %q, want %q", step, warm, want)
		}
	}
	m.LinkedSession("b1")
	check("one session", filepath.Base(paths[0]))

	// A session resumed from before the start: the only one written since, now with another one before it.
	old := filepath.Join(dir, "old.jsonl")
	writeClaudeTestSession(t, old, cwd, 8*1024)
	past := time.Now().Add(-time.Hour)
	os.Chtimes(old, past, past)
	os.Chtimes(paths[0], past, past)
	check("one session written before the start", "")
	appendLines(t, old, claudeTestRecord(cwd, "user", "resume", 0))
	check("resumed", "old.jsonl")

	// /clear: a new session next to it.
	fresh := filepath.Join(dir, "new.jsonl")
	writeClaudeTestSession(t, fresh, cwd, 8*1024)
	check("a new session", "?")

	// The new session replaced by another folder's, the resumed one moved away.
	elsewhere := padTo(filepath.Join(filepath.Dir(cwd), "e"), len(cwd))
	data, _ := os.ReadFile(fresh)
	replaceFile(t, fresh, strings.ReplaceAll(string(data), cwd, elsewhere), time.Time{})
	check("replaced by another folder's session", "old.jsonl")
	if err := os.Rename(old, filepath.Join(t.TempDir(), "old.jsonl")); err != nil {
		t.Fatal(err)
	}
	check("moved away", "")
}
