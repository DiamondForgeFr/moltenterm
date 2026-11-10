// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"
)

// #2142: where the agents' sessions work is read from their transcripts, so only for an answer that is computed: an
// answer served from the cache reads none, and the cache's key holds the terminals, not where their sessions work.
func TestUpcomingFromItsCacheReadsNoTranscript(t *testing.T) {
	t.Parallel()
	f := makeSubagentCardRepo(t)
	main := realPath(f.dir)
	prs, _ := json.Marshal([]map[string]any{})
	snap := Snapshot{Dir: f.dir, Github: &GithubSnapshot{State: GithubStateOk, Repo: "o/r", Url: "https://github.com/o/r", Prs: prs}}
	run := func(ctx context.Context, d string, name string, args ...string) ([]byte, error) {
		if name == "gh" {
			return []byte(`{"data":{"repository":{}}}`), nil
		}
		return plainRunner(ctx, d, name, args...)
	}
	var reads atomic.Int32
	var work atomic.Value
	work.Store(main)
	now := time.Now()
	var clock atomic.Int64
	clock.Store(now.UnixNano())
	u := MakeUpcoming(UpcomingEnv{
		Run:      run,
		Now:      func() time.Time { return time.Unix(0, clock.Load()) },
		Snapshot: func(string) (Snapshot, bool) { return snap, true },
		Agents: func(context.Context) []AgentPlace {
			return []AgentPlace{{BlockId: "b0", Agent: "claude", FirstName: "Lucie", Cwd: main}}
		},
		WorkFolders: func(places []AgentPlace) []AgentPlace {
			reads.Add(1)
			for i := range places {
				places[i].Work = work.Load().(string)
			}
			return places
		},
	})
	panelBranch := func(answer UpcomingAnswer) string {
		for _, a := range answer.Agents {
			if a.Kind == UpcomingAgentPanel && a.BlockId == "b0" {
				return a.Branch
			}
		}
		return ""
	}
	get := func(force bool) UpcomingAnswer {
		t.Helper()
		answer, err := u.Get(UpcomingRequest{Dir: f.dir, Force: force})
		if err != nil || answer.Error != "" {
			t.Fatalf("get: %v %s", err, answer.Error)
		}
		return answer
	}
	if got := panelBranch(get(false)); got != "develop" || reads.Load() != 1 {
		t.Fatalf("first answer: panel on %q, %d reads", got, reads.Load())
	}
	// The session moves to a ticket's worktree: the cached answer reads nothing and still places it at home.
	work.Store(realPath(f.running))
	for i := 0; i < 5; i++ {
		get(false)
	}
	if reads.Load() != 1 {
		t.Fatalf("answers from the cache read the work folders %d times", reads.Load()-1)
	}
	// A forced refresh past its interval computes again, and places it on the worktree's branch.
	clock.Add(int64(upcomingForcedInterval + time.Second))
	if got := panelBranch(get(true)); got != "fix/1462-codex-sessions" || reads.Load() != 2 {
		t.Fatalf("recomputed: panel on %q, %d reads", got, reads.Load())
	}
}
