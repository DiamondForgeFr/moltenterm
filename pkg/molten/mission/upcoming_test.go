// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestUpcomingCandidates(t *testing.T) {
	res := branchTicketRes(map[string]string{"feature": "feature/{N}-{description}", "fix": "fix/{N}-{description}"})
	refs := []branchRef{
		{name: "develop", commitAt: 9},
		{name: "feature/1-old", commitAt: 1},
		{name: "feature/2-pr", commitAt: 5},
		{name: "fix/3-local", commitAt: 3},
		{name: "fix/3-local", remote: true, commitAt: 4},
		{name: "feature/4-remote", remote: true, commitAt: 6},
		{name: "chore/notes", commitAt: 7},
		{name: "feature/5-agent", commitAt: 0},
	}
	trees := []treeEntry{{path: "/p", branch: "develop"}, {path: "/p/.claude/worktrees/a", branch: "fix/3-local"}}
	got := UpcomingCandidates(refs, map[string]bool{"feature/2-pr": true}, res, "develop", trees, map[string]bool{"feature/5-agent": true})
	var names []string
	for _, c := range got {
		names = append(names, c.Branch)
	}
	if strings.Join(names, ",") != "feature/5-agent,feature/4-remote,fix/3-local,feature/1-old" {
		t.Fatalf("candidates: %v", names)
	}
	if got[1].Ticket != 4 || !got[1].Remote {
		t.Fatalf("remote branch: %+v", got[1])
	}
	if got[2].Remote || got[2].Worktree != "/p/.claude/worktrees/a" || got[2].CommitAt != 3 {
		t.Fatalf("a local branch hides its origin twin and names its worktree: %+v", got[2])
	}
}

func TestApplyUpcomingTickets(t *testing.T) {
	branches := []UpcomingBranch{{Branch: "feature/1-a", Ticket: 1}, {Branch: "feature/2-b", Ticket: 2}, {Branch: "feature/3-c", Ticket: 3}, {Branch: "feature/4-d", Ticket: 4}}
	tickets := map[int]upcomingTicket{
		1: {Title: "One", Url: "u1", Status: "In progress"},
		2: {Title: "Two", Closed: true},
		3: {Title: "Three", Status: "Done"},
	}
	got := ApplyUpcomingTickets(branches, tickets)
	if len(got) != 2 || got[0].Title != "One" || got[0].Status != "In progress" || got[1].Branch != "feature/4-d" || got[1].Title != "" {
		t.Fatalf("tickets: %+v", got)
	}
}

func TestMatchBranchAgents(t *testing.T) {
	trees := []treeEntry{
		{path: "/p", branch: "develop"},
		{path: "/p/.claude/worktrees/a", branch: "feature/7-a"},
		{path: "/data/trees/work-9", branch: ""},
	}
	places := []AgentPlace{
		{BlockId: "main", Agent: "claude", Cwd: "/p", Started: 3},
		{BlockId: "deep", Agent: "codex", FirstName: "Jérôme", Cwd: "/p/.claude/worktrees/a/src", Started: 2},
		{BlockId: "linked", Agent: "claude", Link: "/p/.claude/worktrees/a", Cwd: "/elsewhere", Started: 1},
		{BlockId: "review", Agent: "claude", Cwd: "/p/.claude/worktrees/a", Review: true},
		{BlockId: "detached", Agent: "claude", Cwd: "/data/trees/work-9"},
		{BlockId: "outside", Agent: "claude", Cwd: "/other"},
		{BlockId: "remote", Agent: "claude", Cwd: "relative"},
	}
	got := MatchBranchAgents(trees, places)
	if len(got) != 3 {
		t.Fatalf("agents: %+v", got)
	}
	if got[0].BlockId != "linked" || got[0].Branch != "feature/7-a" || got[0].Kind != UpcomingAgentPanel {
		t.Fatalf("the link wins over the cwd: %+v", got[0])
	}
	if got[1].BlockId != "deep" || got[1].Branch != "feature/7-a" || got[1].FirstName != "Jérôme" || got[1].Started != 2 {
		t.Fatalf("the deepest worktree wins: %+v", got[1])
	}
	if got[2].BlockId != "main" || got[2].Branch != "develop" {
		t.Fatalf("main checkout: %+v", got[2])
	}
}

func TestBackgroundAgents(t *testing.T) {
	now := time.UnixMilli(10_000_000)
	recent := now.Add(-3 * time.Minute).UnixMilli()
	old := now.Add(-BackgroundActivityWindow - time.Second).UnixMilli()
	trees := []treeEntry{
		{path: "/p", branch: "develop"},
		{path: "/p/.claude/worktrees/a", branch: "feature/7-a"},
		{path: "/p/.claude/worktrees/b", branch: "feature/8-b"},
		{path: "/x/c", branch: "feature/9-c"},
		{path: "/x/d", branch: "feature/10-d"},
	}
	panels := []BranchAgent{{Branch: "feature/10-d", Worktree: "/x/d", Kind: UpcomingAgentPanel}}
	places := []AgentPlace{{BlockId: "parent", Agent: "claude", FirstName: "Valentin", Cwd: "/p"}}
	activity := map[string]int64{"/p/.claude/worktrees/a": recent, "/p/.claude/worktrees/b": old, "/x/c": recent, "/x/d": recent}
	got := BackgroundAgents(trees, panels, places, activity, now)
	if len(got) != 2 {
		t.Fatalf("background: %+v", got)
	}
	if got[0].Branch != "feature/7-a" || got[0].Kind != UpcomingAgentBackground || got[0].ActiveAt != recent || got[0].ParentBlockId != "parent" || got[0].ParentFirstName != "Valentin" || got[0].Agent != "claude" {
		t.Fatalf("Claude Code worktree agent: %+v", got[0])
	}
	if got[1].Branch != "feature/9-c" || got[1].ParentBlockId != "" || got[1].Agent != "" {
		t.Fatalf("a worktree outside .claude/worktrees has no known parent: %+v", got[1])
	}
	places = append(places, AgentPlace{BlockId: "second", Agent: "claude", Cwd: "/p/src"})
	if got := BackgroundAgents(trees, panels, places, activity, now); got[0].ParentBlockId != "" {
		t.Fatalf("two candidate parents name none: %+v", got[0])
	}
}

func TestUpcomingTicketsQueryFallsBackWithoutTheBoard(t *testing.T) {
	var calls atomic.Int32
	run := func(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
		calls.Add(1)
		query := strings.Join(args, " ")
		if strings.Contains(query, "projectItems") {
			return []byte(`{"data":{"repository":{"t4":null}},"errors":[{"type":"INSUFFICIENT_SCOPES"}]}`), nil
		}
		return []byte(`{"data":{"repository":{"t4":{"title":"Thing","url":"u","state":"OPEN"}}}}`), nil
	}
	got, err := ReadUpcomingTickets(context.Background(), run, "/p", "o/r", []int{4})
	if err != nil || got[4].Title != "Thing" || got[4].Status != "" || calls.Load() != 2 {
		t.Fatalf("tickets: %+v %v (%d calls)", got, err, calls.Load())
	}
}

// A project with ticket branches: one with a PR, one done, one plain, one in a worktree with a panel agent and one in
// a Claude Code worktree with fresh changes and no terminal.
func TestUpcomingGet(t *testing.T) {
	dir := makeGitFlowRepo(t)
	sf := `{"workflow":{"prTargetBranch":"develop","branchNaming":{"feature":"feature/{N}-{description}"}}}`
	if err := os.WriteFile(filepath.Join(dir, ".saasfoundry.json"), []byte(sf), 0644); err != nil {
		t.Fatal(err)
	}
	for _, branch := range []string{"feature/5-plain", "feature/6-pr", "feature/8-done"} {
		gitRun(t, dir, "checkout", "-q", "-b", branch, "develop")
		commit(t, dir, strings.ReplaceAll(branch, "/", "-")+".txt", "feat: "+branch)
	}
	gitRun(t, dir, "checkout", "-q", "develop")
	gitRun(t, dir, "branch", "feature/11-agent", "develop")
	panelTree := filepath.Join(t.TempDir(), "agent")
	gitRun(t, dir, "worktree", "add", "-q", panelTree, "feature/11-agent")
	bgTree := filepath.Join(dir, ".claude", "worktrees", "agent-x")
	gitRun(t, dir, "worktree", "add", "-q", "-b", "feature/12-bg", bgTree, "develop")
	if err := os.WriteFile(filepath.Join(bgTree, "new.txt"), []byte("work"), 0644); err != nil {
		t.Fatal(err)
	}
	prs, _ := json.Marshal([]map[string]any{{"headRefName": "feature/6-pr", "baseRefName": "develop", "isDraft": true}})
	snap := Snapshot{Dir: dir, Github: &GithubSnapshot{State: GithubStateOk, Repo: "o/r", Url: "https://github.com/o/r", Prs: prs}}
	var ghCalls atomic.Int32
	run := func(ctx context.Context, d string, name string, args ...string) ([]byte, error) {
		if name != "gh" {
			return plainRunner(ctx, d, name, args...)
		}
		ghCalls.Add(1)
		return []byte(`{"data":{"repository":{
			"t4":{"title":"Thing","url":"u4","state":"OPEN","projectItems":{"nodes":[{"status":{"name":"In progress"}}]}},
			"t5":{"title":"Plain","url":"u5","state":"OPEN","projectItems":{"nodes":[{"status":{"name":"AI Testing"}}]}},
			"t6":{"title":"Draft","url":"u6","state":"OPEN","projectItems":{"nodes":[{"status":{"name":"AI Testing"}}]}},
			"t8":{"title":"Done","url":"u8","state":"OPEN","projectItems":{"nodes":[{"status":{"name":"Done"}}]}},
			"t11":{"title":"Agent","url":"u11","state":"OPEN","projectItems":{"nodes":[]}},
			"t12":{"title":"Background","url":"u12","state":"OPEN","projectItems":{"nodes":[]}}}}}`), nil
	}
	places := []AgentPlace{
		{BlockId: "b1", Agent: "codex", FirstName: "Jérôme", Cwd: realPath(panelTree), Started: 42},
		{BlockId: "b0", Agent: "claude", FirstName: "Valentin", Cwd: realPath(dir), Started: 7},
	}
	u := MakeUpcoming(UpcomingEnv{
		Run:      run,
		Snapshot: func(string) (Snapshot, bool) { return snap, true },
		Agents:   func(context.Context) []AgentPlace { return places },
	})
	answer, err := u.Get(UpcomingRequest{Dir: dir})
	if err != nil || answer.Error != "" {
		t.Fatalf("get: %v %s", err, answer.Error)
	}
	byBranch := map[string]UpcomingBranch{}
	for _, b := range answer.Branches {
		byBranch[b.Branch] = b
	}
	if len(byBranch) != 4 {
		t.Fatalf("upcoming: %+v", answer.Branches)
	}
	if b := byBranch["feature/5-plain"]; b.Ahead != 1 || b.Ticket != 5 || b.Title != "Plain" || b.Status != "AI Testing" {
		t.Fatalf("plain branch: %+v", b)
	}
	if b := byBranch["feature/4-thing"]; b.Ahead != 1 || b.Status != "In progress" {
		t.Fatalf("feature/4 is one commit ahead of develop: %+v", b)
	}
	if b := byBranch["feature/11-agent"]; b.Ahead != 0 || b.Worktree != realPath(panelTree) {
		t.Fatalf("a branch an agent works on is upcoming even without commits: %+v", b)
	}
	if _, ok := byBranch["feature/6-pr"]; ok {
		t.Fatalf("a branch with an open PR is not upcoming")
	}
	if _, ok := byBranch["feature/8-done"]; ok {
		t.Fatalf("a Done ticket is not upcoming")
	}
	// #954: a draft carries its ticket's board Status and its last commit, so the list knows whose turn it is.
	if len(answer.Drafts) != 1 || answer.Drafts[0].Branch != "feature/6-pr" || answer.Drafts[0].Ticket != 6 ||
		answer.Drafts[0].Status != "AI Testing" || answer.Drafts[0].CommitAt == 0 {
		t.Fatalf("drafts: %+v", answer.Drafts)
	}
	agents := map[string]BranchAgent{}
	for _, a := range answer.Agents {
		agents[a.Branch] = a
	}
	if a := agents["feature/11-agent"]; a.Kind != UpcomingAgentPanel || a.BlockId != "b1" || a.Started != 42 {
		t.Fatalf("panel agent: %+v", a)
	}
	if a := agents["feature/12-bg"]; a.Kind != UpcomingAgentBackground || a.ParentBlockId != "b0" || a.ActiveAt == 0 {
		t.Fatalf("background agent: %+v", a)
	}
	again, _ := u.Get(UpcomingRequest{Dir: dir, Force: true})
	if again.At != answer.At || ghCalls.Load() != 1 {
		t.Fatalf("a forced ask within %s is answered from the cache (gh calls %d)", upcomingForcedInterval, ghCalls.Load())
	}
}

// #1077: the agent terminals a restart restores reach wavesrv's agent states after its first answer; the next ask,
// even a forced one within upcomingForcedInterval or a plain one within upcomingMaxAge, places them at once.
func TestUpcomingPlacesAgentsRestoredAfterAnAnswer(t *testing.T) {
	dir := makeGitFlowRepo(t)
	gitRun(t, dir, "branch", "feature/21-one", "develop")
	gitRun(t, dir, "branch", "feature/22-two", "develop")
	treeOne := filepath.Join(t.TempDir(), "one")
	treeTwo := filepath.Join(t.TempDir(), "two")
	gitRun(t, dir, "worktree", "add", "-q", treeOne, "feature/21-one")
	gitRun(t, dir, "worktree", "add", "-q", treeTwo, "feature/22-two")
	var lock sync.Mutex
	var places []AgentPlace
	setPlaces := func(p []AgentPlace) {
		lock.Lock()
		defer lock.Unlock()
		places = p
	}
	getPlaces := func(context.Context) []AgentPlace {
		lock.Lock()
		defer lock.Unlock()
		return append([]AgentPlace(nil), places...)
	}
	snap := Snapshot{Dir: dir, Github: &GithubSnapshot{State: GithubStateOk, Repo: "o/r", Url: "https://github.com/o/r", Prs: json.RawMessage("[]")}}
	run := func(ctx context.Context, d string, name string, args ...string) ([]byte, error) {
		if name == "gh" {
			return []byte(`{"data":{"repository":{}}}`), nil
		}
		return plainRunner(ctx, d, name, args...)
	}
	now := time.Now()
	u := MakeUpcoming(UpcomingEnv{
		Run:      run,
		Now:      func() time.Time { return now },
		Snapshot: func(string) (Snapshot, bool) { return snap, true },
		Agents:   getPlaces,
	})
	first, err := u.Get(UpcomingRequest{Dir: dir})
	if err != nil || len(panelAgents(first)) != 0 {
		t.Fatalf("before the restore no agent is placed: %+v %v", first.Agents, err)
	}
	setPlaces([]AgentPlace{
		{BlockId: "b1", Agent: "claude", FirstName: "Olivia", Cwd: realPath(treeOne), Started: 1},
		{BlockId: "b2", Agent: "codex", FirstName: "Jérôme", Cwd: realPath(treeTwo), Started: 2},
	})
	now = now.Add(time.Second)
	answer, err := u.Get(UpcomingRequest{Dir: dir, Force: true})
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, a := range panelAgents(answer) {
		got[a.Branch] = a.BlockId
	}
	if got["feature/21-one"] != "b1" || got["feature/22-two"] != "b2" || answer.At == first.At {
		t.Fatalf("the restored agents are placed at once: %+v", answer.Agents)
	}
	now = now.Add(time.Second)
	again, _ := u.Get(UpcomingRequest{Dir: dir, Force: true})
	if again.At != answer.At {
		t.Fatalf("with the same agents a forced ask within %s is answered from the cache %d %d", upcomingForcedInterval, again.At, answer.At)
	}
	setPlaces(nil)
	gone, _ := u.Get(UpcomingRequest{Dir: dir})
	if len(panelAgents(gone)) != 0 {
		t.Fatalf("closed agents leave at the next ask: %+v", gone.Agents)
	}
}

func panelAgents(answer UpcomingAnswer) []BranchAgent {
	var rtn []BranchAgent
	for _, a := range answer.Agents {
		if a.Kind == UpcomingAgentPanel {
			rtn = append(rtn, a)
		}
	}
	return rtn
}

func TestUpcomingWithoutGithubListsNoBranch(t *testing.T) {
	dir := makeGitFlowRepo(t)
	u := MakeUpcoming(UpcomingEnv{Run: plainRunner, Snapshot: func(string) (Snapshot, bool) { return Snapshot{}, false }})
	answer, err := u.Get(UpcomingRequest{Dir: dir})
	if err != nil || len(answer.Branches) != 0 || answer.Agents == nil {
		t.Fatalf("without the open PRs nothing is upcoming: %+v %v", answer, err)
	}
}
