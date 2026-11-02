// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// attributionRunner fakes git for the background worktrees: each worktree's last commit is recent, and its commits
// after the target carry messages[dir] (newest first, as git log prints them).
func attributionRunner(now time.Time, messages map[string][]string, logs *atomic.Int32) Runner {
	return func(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
		joined := strings.Join(args, " ")
		switch {
		case strings.HasPrefix(joined, "log -1 --format=%ct"):
			return []byte(fmt.Sprintf("%d\n", now.Add(-2*time.Minute).Unix())), nil
		case strings.HasPrefix(joined, "status"):
			return nil, nil
		case strings.HasPrefix(joined, "log -n"):
			logs.Add(1)
			if !strings.HasSuffix(joined, "origin/develop..HEAD") {
				return nil, fmt.Errorf("unexpected range: %s", joined)
			}
			var out strings.Builder
			for _, m := range messages[dir] {
				out.WriteString(m + "\n" + commitSep + "\n")
			}
			return []byte(out.String()), nil
		}
		return nil, fmt.Errorf("unexpected git %s", joined)
	}
}

func madeByBody(line string) string {
	return "Resolves #9\n\n<!-- molten:agents -->\n---\nMade by " + line + "\n<!-- /molten:agents -->\n"
}

func TestBackgroundAttributionOrder(t *testing.T) {
	now := time.UnixMilli(50_000_000)
	trees := []treeEntry{
		{path: "/p", branch: "develop"},
		{path: "/tmp/wt/live", branch: "feature/11-live"},
		{path: "/p-wt/trailer", branch: "feature/12-trailer"},
		{path: "/p-wt/body", branch: "feature/13-body"},
		{path: "/p/.claude/worktrees/folder", branch: "feature/14-folder"},
		{path: "/p-wt/nobody", branch: "feature/15-nobody"},
		{path: "/p-wt/open", branch: "feature/16-open"},
	}
	places := []AgentPlace{
		{BlockId: "b-salome", Agent: "codex", FirstName: "Salomé", Cwd: "/p", Pid: 100, Started: 7},
		{BlockId: "b-valentin", Agent: "claude", FirstName: "Valentin", Cwd: "/p", Pid: 200},
		{BlockId: "b-review", Agent: "claude", FirstName: "Rita", Cwd: "/p", Pid: 300, Review: true},
	}
	// Salomé's shell command runs in /tmp/wt/live; a review session's process in /p-wt/nobody counts for nothing.
	procs := fakeProcs{
		parents: map[int32]int32{101: 100, 102: 101, 201: 200, 301: 300},
		cwds:    map[int32]string{100: "/p", 101: "/p", 102: "/tmp/wt/live/pkg", 200: "/p", 201: "/p", 301: "/p-wt/nobody"},
	}
	messages := map[string][]string{
		"/p-wt/trailer": {"fix(#12): newest\n\nMolten-Agent: Jérôme (Codex, gpt-5.5-codex, high)", "feat(#12): older\n\nMolten-Agent: Bruno (Claude Code)"},
		"/p-wt/open":    {"feat(#16): x\n\nMolten-Agent: Valentin (Claude Code, Opus 5.5)"},
	}
	bodies := map[string]string{
		"feature/12-trailer": madeByBody("Diane · Claude Code"),
		"feature/13-body":    madeByBody("Diane · Some New CLI · m1"),
	}
	var logs atomic.Int32
	var reads atomic.Int32
	u := MakeUpcoming(UpcomingEnv{Run: attributionRunner(now, messages, &logs), Now: func() time.Time { return now }})
	facts := backgroundFacts{
		procs:     func() ProcFacts { reads.Add(1); return procs },
		targetRef: "refs/remotes/origin/develop",
		prBodies:  bodies,
	}
	got := u.backgroundAgents(context.Background(), trees, nil, places, branchTicketRes(nil), facts)
	byBranch := map[string]BranchAgent{}
	for _, a := range got {
		byBranch[a.Branch] = a
	}
	if len(got) != 6 {
		t.Fatalf("six worktrees attributed: %+v", got)
	}
	if a := byBranch["feature/11-live"]; a.Kind != UpcomingAgentPanel || a.BlockId != "b-salome" || a.FirstName != "Salomé" || a.Agent != "codex" || a.Started != 7 {
		t.Errorf("1. a live agent's process inside the worktree names its panel: %+v", a)
	}
	if a := byBranch["feature/12-trailer"]; a.Kind != UpcomingAgentBackground || !a.Signed || a.FirstName != "Jérôme" || a.Agent != "codex" || a.AgentName != "Codex" || a.BlockId != "" {
		t.Errorf("2. the newest commit trailer wins over the body, no Go to without its session: %+v", a)
	}
	if a := byBranch["feature/13-body"]; !a.Signed || a.FirstName != "Diane" || a.Agent != "" || a.AgentName != "Some New CLI" {
		t.Errorf("2. the PR's Made by, for a CLI the catalog does not know: %+v", a)
	}
	if a := byBranch["feature/16-open"]; !a.Signed || a.FirstName != "Valentin" || a.BlockId != "b-valentin" || a.Agent != "claude" {
		t.Errorf("2. a signer whose session is open gets Go to: %+v", a)
	}
	if a := byBranch["feature/14-folder"]; a.Signed || a.Agent != "claude" || a.ParentBlockId != "b-valentin" {
		t.Errorf("3. the agent's own worktrees folder, with its parent: %+v", a)
	}
	if a := byBranch["feature/15-nobody"]; a.Signed || a.Agent != "" || a.FirstName != "" || a.BlockId != "" || a.ParentBlockId != "" {
		t.Errorf("4. nobody known, and a review session's process names nothing: %+v", a)
	}
	if reads.Load() != 1 {
		t.Errorf("the process table is read once per answer, not %d times", reads.Load())
	}
	if logs.Load() != 5 {
		t.Errorf("one signature read per background worktree, not for the live one: %d", logs.Load())
	}
}

func TestBackgroundAttributionWithoutAgentProcesses(t *testing.T) {
	now := time.UnixMilli(50_000_000)
	trees := []treeEntry{{path: "/p", branch: "develop"}, {path: "/x/a", branch: "feature/3-a"}}
	places := []AgentPlace{{BlockId: "b", Agent: "codex", FirstName: "Adrien", Cwd: "/p"}}
	var logs atomic.Int32
	u := MakeUpcoming(UpcomingEnv{Run: attributionRunner(now, nil, &logs), Now: func() time.Time { return now }})
	facts := backgroundFacts{
		procs:     func() ProcFacts { t.Fatalf("no agent process: the process table is not read"); return nil },
		targetRef: "refs/remotes/origin/develop",
		prBodies:  map[string]string{"feature/3-a": madeByBody("Adrien · Codex")},
	}
	got := u.backgroundAgents(context.Background(), trees, nil, places, branchTicketRes(nil), facts)
	if len(got) != 1 || !got[0].Signed || got[0].FirstName != "Adrien" || got[0].BlockId != "b" {
		t.Fatalf("a signed PR without a live process names its signer: %+v", got)
	}
}

func TestLiveTreeAgentsIsBounded(t *testing.T) {
	cands := []treeEntry{{path: "/w", branch: "feature/1-w"}}
	parents := map[int32]int32{}
	cwds := map[int32]string{1: "/p"}
	for pid := int32(2); pid < 2+liveTreeMaxProcs+10; pid++ {
		parents[pid] = 1
		cwds[pid] = "/p"
	}
	last := int32(2 + liveTreeMaxProcs + 9)
	cwds[last] = "/w"
	places := []AgentPlace{{BlockId: "b", Agent: "claude", Pid: 1}}
	if got := LiveTreeAgents(cands, places, fakeProcs{parents: parents, cwds: cwds}); len(got) != 0 {
		t.Fatalf("past the bound no folder is read: %+v", got)
	}
	cwds[3] = "/w/sub"
	if got := LiveTreeAgents(cands, places, fakeProcs{parents: parents, cwds: cwds}); len(got) != 1 || got[0].BlockId != "b" {
		t.Fatalf("within the bound the worktree is found: %+v", got)
	}
}

func TestLastSigner(t *testing.T) {
	if _, ok := LastSigner(nil, "no block"); ok {
		t.Fatalf("no signature")
	}
	sig, ok := LastSigner([]string{"a\n\nMolten-Agent: Bruno (Claude Code)", "b"}, madeByBody("Diane · Codex"))
	if !ok || sig.FirstName != "Bruno" {
		t.Fatalf("a trailer, even on an older commit, wins over the body: %+v", sig)
	}
	if got := commitMessagesOldestFirst("new\n" + commitSep + "\nold\n" + commitSep + "\n"); len(got) != 2 || got[0] != "old" || got[1] != "new" {
		t.Fatalf("oldest first: %q", got)
	}
}
