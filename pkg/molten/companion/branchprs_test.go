// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

type fakeBranchPRs struct {
	lock  sync.Mutex
	calls map[string]int
	dirs  []string
	prs   map[string][]PRLink
}

func (f *fakeBranchPRs) lookup(ctx context.Context, dir string, branch string) ([]PRLink, error) {
	f.lock.Lock()
	defer f.lock.Unlock()
	f.calls[branch]++
	f.dirs = append(f.dirs, dir)
	return f.prs[branch], nil
}

func (f *fakeBranchPRs) count() map[string]int {
	f.lock.Lock()
	defer f.lock.Unlock()
	rtn := map[string]int{}
	for k, v := range f.calls {
		rtn[k] = v
	}
	return rtn
}

func TestLookupBranch(t *testing.T) {
	for branch, want := range map[string]bool{
		"feature/991-names": true, "worktree-agent-ab9c": true, "develop": false, "main": false, "master": false,
		"HEAD": false, "": false, "--exec=x": false, "a\nb": false, strings.Repeat("x", 300): false,
	} {
		if got := lookupBranch(branch); got != want {
			t.Errorf("lookupBranch(%q) = %v, want %v", branch, got, want)
		}
	}
}

func TestBranchPREntryStale(t *testing.T) {
	now := time.Now()
	if (&branchPREntry{done: false, at: now.Add(-time.Hour)}).stale(now) {
		t.Error("a lookup running is never asked again")
	}
	if (&branchPREntry{done: true, at: now.Add(-time.Minute)}).stale(now) {
		t.Error("a fresh answer is kept")
	}
	if !(&branchPREntry{done: true, at: now.Add(-branchPRRecheck)}).stale(now) {
		t.Error("an old answer is asked again")
	}
	if (&branchPREntry{done: true, failed: true, at: now.Add(-branchPRRecheck)}).stale(now) {
		t.Error("a failure waits longer")
	}
}

// A topic of the session that did work, on the session's current branch.
func workTopic(s *Session, text string, at int64) {
	s.startTopic(text, at)
	for i := 0; i < topicMinTools; i++ {
		s.topicTool(at)
	}
}

// AC2 for both agents: a topic shows its branch's PRs; the newest topic of a branch takes them, an older one on the
// same branch does not repeat them, a trunk topic shows none, and a PR Claude Code's pr-link already put on a topic
// stays there alone.
func TestTopicsTakeTheirBranchPRs(t *testing.T) {
	s := MakeSession()
	s.SetBranch("develop")
	workTopic(s, "Look at develop", 1)
	s.SetBranch("feature/991-names")
	workTopic(s, "Read the names", 2)
	s.AddPRLink(998, "https://github.com/o/r/pull/998")
	workTopic(s, "Finish the names", 3)
	prs := map[string][]PRLink{
		"feature/991-names": {{Number: 1001, Url: "https://github.com/o/r/pull/1001"}, {Number: 998, Url: "https://github.com/o/r/pull/998"}},
		"develop":           {{Number: 5, Url: "https://github.com/o/r/pull/5"}},
	}
	var asked []string
	s.ResolveBranchPRs(func(branch string) []PRLink {
		asked = append(asked, branch)
		return prs[branch]
	})
	if strings.Join(asked, ",") != "feature/991-names" {
		t.Errorf("one lookup per branch, never a trunk's: %v", asked)
	}
	topics := s.Topics()
	if len(topics) != 3 {
		t.Fatalf("topics: %+v", topics)
	}
	if fmt.Sprint(topics[0].PRs) != fmt.Sprint([]PRLink{{1001, "https://github.com/o/r/pull/1001"}}) {
		t.Errorf("the newest topic of the branch takes its PRs, not the one pr-link placed: %+v", topics[0].PRs)
	}
	if len(topics[1].PRs) != 1 || topics[1].PRs[0].Number != 998 {
		t.Errorf("pr-link's PR stays on its topic, once: %+v", topics[1].PRs)
	}
	if len(topics[2].PRs) != 0 {
		t.Errorf("a trunk topic shows no PR: %+v", topics[2].PRs)
	}
	version := s.Version
	s.ResolveBranchPRs(func(branch string) []PRLink { return prs[branch] })
	if s.Version != version {
		t.Error("the same answer changes nothing")
	}
}

// The Codex companion shows a topic's PR from its branch: gh is asked only after a refresh, in the session's folder,
// once per branch however often it refreshes.
func TestCodexTopicPRsOnRefresh(t *testing.T) {
	root := t.TempDir()
	repo := t.TempDir()
	makeRepo(t, repo, "feature/991-names")
	now := time.Now().Add(-time.Minute)
	rollout := codexRolloutPath(root, now, codexLinkThread)
	lines := []string{
		codexMeta(codexLinkThread, repo, now, `,"git":{"branch":"feature/991-names"}`),
		codexTurnEvent(now, "task_started"),
		codexUserMessage(now, "Name the Codex sessions"),
	}
	for i := 0; i < topicMinTools; i++ {
		lines = append(lines, fmt.Sprintf(`{"timestamp":%q,"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"command\":[\"ls\"]}","call_id":"c%d"}}`, codexStamp(now), i))
	}
	writeCodexLines(t, rollout, lines...)
	m, env := makeCodexLinkManager(t, root)
	gh := &fakeBranchPRs{calls: map[string]int{}, prs: map[string][]PRLink{"feature/991-names": {{Number: 998, Url: "https://github.com/o/r/pull/998"}}}}
	m.branchPRLookup = gh.lookup
	env.lock.Lock()
	env.runs["b"] = molten.AgentRunInfo{BlockId: "b", Agent: molten.AgentIdCodex, Started: now.UnixMilli(), Running: true}
	env.cwds["b"] = t.TempDir()
	env.lock.Unlock()
	defer m.Close("b", "v")
	if err := m.ReportSession(molten.AgentSessionRequest{BlockId: "b", Agent: molten.AgentIdCodex, Path: rollout}); err != nil {
		t.Fatal(err)
	}
	m.Open("b", "v")
	waitViewLong(t, env.fakeEnv, "b", func(v CompanionView) bool { return len(v.Topics) == 1 })
	if calls := gh.count(); len(calls) != 0 {
		t.Fatalf("no gh call without a refresh: %v", calls)
	}
	m.Refresh("b")
	v := waitViewLong(t, env.fakeEnv, "b", func(v CompanionView) bool { return len(v.Topics) == 1 && len(v.Topics[0].PRs) == 1 })
	if v.Topics[0].PRs[0].Number != 998 || v.Topics[0].Branch != "feature/991-names" {
		t.Errorf("the topic's PR: %+v", v.Topics[0])
	}
	for i := 0; i < 3; i++ {
		m.Refresh("b")
		waitViewLong(t, env.fakeEnv, "b", func(v CompanionView) bool { return len(v.Topics) == 1 })
	}
	if calls := gh.count(); calls["feature/991-names"] != 1 || len(calls) != 1 {
		t.Errorf("one gh call per branch: %v", calls)
	}
	gh.lock.Lock()
	defer gh.lock.Unlock()
	if len(gh.dirs) != 1 || gh.dirs[0] != repo {
		t.Errorf("gh runs in the session's folder: %v", gh.dirs)
	}
}

// GhBranchPRs asks gh for the branch as one --head= argument and keeps this repository's PRs only, newest first.
func TestGhBranchPRs(t *testing.T) {
	bin := t.TempDir()
	argsFile := filepath.Join(bin, "args")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > " + argsFile + "\n" +
		`echo '[{"number":12,"url":"https://github.com/o/r/pull/12","isCrossRepository":false},{"number":40,"url":"https://github.com/fork/r/pull/40","isCrossRepository":true},{"number":31,"url":"javascript:x","isCrossRepository":false}]'` + "\n"
	if err := os.WriteFile(filepath.Join(bin, "gh"), []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+"/usr/bin:/bin")
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	prs, err := GhBranchPRs(ctx, t.TempDir(), "feature/991-names")
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(prs) != fmt.Sprint([]PRLink{{31, ""}, {12, "https://github.com/o/r/pull/12"}}) {
		t.Errorf("prs: %+v", prs)
	}
	args, _ := os.ReadFile(argsFile)
	if !strings.Contains(string(args), "--head=feature/991-names\n") {
		t.Errorf("args: %q", args)
	}
}
