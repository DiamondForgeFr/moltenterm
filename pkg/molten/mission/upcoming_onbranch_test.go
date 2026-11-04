// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// #1841: a lead counts as on a branch only for the work it does there. Its time on the branch never starts before the
// worktree existed, and a session whose commands only passed through a worktree is visiting it.

type onBranchFixture struct {
	f      subagentCardFixture
	now    time.Time
	places []AgentPlace
	files  map[string]int64
	u      *Upcoming
}

func makeOnBranchFixture(t *testing.T) *onBranchFixture {
	t.Helper()
	o := &onBranchFixture{f: makeSubagentCardRepo(t), now: time.Now().Add(2 * time.Hour), files: map[string]int64{}}
	prs, _ := json.Marshal([]map[string]any{})
	snap := Snapshot{Dir: o.f.dir, Github: &GithubSnapshot{State: GithubStateOk, Repo: "o/r", Url: "https://github.com/o/r", Prs: prs}}
	run := func(ctx context.Context, d string, name string, args ...string) ([]byte, error) {
		if name == "gh" {
			return []byte(`{"data":{"repository":{}}}`), nil
		}
		return plainRunner(ctx, d, name, args...)
	}
	o.u = MakeUpcoming(UpcomingEnv{
		Run:      run,
		Now:      func() time.Time { return o.now },
		Snapshot: func(string) (Snapshot, bool) { return snap, true },
		Agents:   func(context.Context) []AgentPlace { return o.places },
		FileTime: func(path string) int64 {
			if at, ok := o.files[path]; ok {
				return at
			}
			return fileTimeMs(path)
		},
	})
	return o
}

// panel asks the answer (forced, a minute later each time) and returns the panel b0.
func (o *onBranchFixture) panel(t *testing.T) BranchAgent {
	t.Helper()
	o.now = o.now.Add(time.Minute)
	answer, err := o.u.Get(UpcomingRequest{Dir: o.f.dir, Force: true})
	if err != nil || answer.Error != "" {
		t.Fatalf("get: %v %s", err, answer.Error)
	}
	for _, a := range answer.Agents {
		if a.Kind == UpcomingAgentPanel && a.BlockId == "b0" {
			return a
		}
	}
	t.Fatalf("no panel b0: %+v", answer.Agents)
	return BranchAgent{}
}

func TestPanelTimeOnBranchStartsWithTheWorktree(t *testing.T) {
	o := makeOnBranchFixture(t)
	created := o.now.Add(-3 * time.Hour).UnixMilli()
	o.files[filepath.Join(o.f.running, ".git")] = created
	dayAgo := o.now.Add(-26 * time.Hour).UnixMilli()
	// A terminal opened in the worktree, its agent's session a day old.
	o.places = []AgentPlace{{BlockId: "b0", Agent: "claude", FirstName: "Arthur", Started: dayAgo, Cwd: realPath(o.f.running)}}
	a := o.panel(t)
	if a.Branch != "fix/1462-codex-sessions" || a.Started < created || a.Visiting {
		t.Fatalf("on the branch since the worktree exists, not since its session: %+v (created %d, session %d)", a, created, dayAgo)
	}
	// A session younger than the worktree keeps its start.
	recent := o.now.Add(-time.Hour).UnixMilli()
	o.places[0].Started = recent
	if a := o.panel(t); a.Started != recent {
		t.Fatalf("a younger session keeps its start: %+v", a)
	}
}

func TestPanelOnlyPassingThroughAWorktreeIsVisiting(t *testing.T) {
	o := makeOnBranchFixture(t)
	main := realPath(o.f.dir)
	dayAgo := o.now.Add(-26 * time.Hour).UnixMilli()
	// The lead's terminal stays in the main checkout; its session ran a command in the worktree, an hour after the
	// worktree's last commit.
	o.places = []AgentPlace{{BlockId: "b0", Agent: "claude", FirstName: "Arthur", Started: dayAgo, Cwd: main, Work: main}}
	if a := o.panel(t); a.Branch != "develop" || a.Visiting {
		t.Fatalf("at home first: %+v", a)
	}
	o.places[0].Work = realPath(o.f.running)
	moved := o.now.Add(time.Minute)
	a := o.panel(t)
	if a.Branch != "fix/1462-codex-sessions" || !a.Visiting {
		t.Fatalf("a session that wrote nothing in the worktree since it came is visiting: %+v", a)
	}
	if a.Started != moved.UnixMilli() {
		t.Fatalf("seen coming at %d, on the branch since %d", moved.UnixMilli(), a.Started)
	}
	// It writes a file there: it works on the branch now.
	path := filepath.Join(o.f.running, "work.txt")
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	o.files[path] = o.now.Add(30 * time.Second).UnixMilli()
	if a := o.panel(t); a.Visiting || a.Started != moved.UnixMilli() {
		t.Fatalf("a session that writes in the worktree works on its branch: %+v", a)
	}
}

// A session MoltenTerm first sees already in a worktree counts the writes of the last minutes before.
func TestPanelFirstSeenInAWorktreeCountsRecentWrites(t *testing.T) {
	o := makeOnBranchFixture(t)
	main := realPath(o.f.dir)
	o.places = []AgentPlace{{BlockId: "b0", Agent: "codex", FirstName: "Léa", Started: o.now.Add(-26 * time.Hour).UnixMilli(), Cwd: main, Work: realPath(o.f.running)}}
	if a := o.panel(t); !a.Visiting {
		t.Fatalf("nothing written there for two hours: visiting: %+v", a)
	}
	o2 := makeOnBranchFixture(t)
	path := filepath.Join(o2.f.running, "work.txt")
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	o2.files[path] = o2.now.Add(-2 * time.Minute).UnixMilli()
	o2.places = []AgentPlace{{BlockId: "b0", Agent: "codex", FirstName: "Léa", Cwd: realPath(o2.f.dir), Work: realPath(o2.f.running)}}
	if a := o2.panel(t); a.Visiting {
		t.Fatalf("a write minutes before it was first seen: at work: %+v", a)
	}
}
