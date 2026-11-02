// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agenthandoff"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
)

type leftoverAskFixture struct {
	lock     sync.Mutex
	owner    mission.LeftoverOwner
	ownerErr error
	treeGone bool
	run      molten.AgentRunInfo
	sent     []agenthandoff.AppRequest
	outcome  string
	now      time.Time
	asks     *LeftoverAsks
}

const leftoverTree = "/p/.claude/worktrees/agent-a44"

func makeLeftoverAskFixture(t *testing.T) *leftoverAskFixture {
	f := &leftoverAskFixture{
		owner: mission.LeftoverOwner{Via: mission.OwnerViaAgent, Pid: 44215, BlockId: "b-valentin", FirstName: "Valentin", Agent: "claude"},
		run:   molten.AgentRunInfo{BlockId: "b-valentin", Running: true, State: molten.AgentStateIdle, FirstName: "Valentin"},
		now:   time.UnixMilli(1_800_000_000_000),
	}
	outcome := filepath.Join(t.TempDir(), "outcome.txt")
	f.asks = MakeLeftoverAsks(LeftoverAskEnv{
		Owner: func(ctx context.Context, dir string, path string) (mission.LeftoverOwner, mission.LinkedTree, error) {
			f.lock.Lock()
			defer f.lock.Unlock()
			return f.owner, mission.LinkedTree{Path: path, Branch: "fix/1130-card", Locked: true}, f.ownerErr
		},
		Tree: func(ctx context.Context, dir string, path string) (mission.LinkedTree, bool, error) {
			f.lock.Lock()
			defer f.lock.Unlock()
			return mission.LinkedTree{Path: path, Branch: "fix/1130-card"}, !f.treeGone, nil
		},
		Send: func(ctx context.Context, req agenthandoff.AppRequest) (agenthandoff.AppSent, error) {
			f.lock.Lock()
			defer f.lock.Unlock()
			f.sent = append(f.sent, req)
			if f.outcome != "" {
				os.WriteFile(outcome, []byte(f.outcome+"\n"), 0600)
			}
			return agenthandoff.AppSent{Status: agenthandoff.StatusDelivered, To: "Valentin", BriefPath: "/data/brief.md", OutcomePath: outcome}, nil
		},
		AgentRun: func(blockId string) (molten.AgentRunInfo, bool) {
			f.lock.Lock()
			defer f.lock.Unlock()
			return f.run, blockId == f.run.BlockId
		},
		Now:  func() time.Time { return f.now },
		Logf: func(string, ...any) {},
	})
	return f
}

func (f *leftoverAskFixture) state(t *testing.T) LeftoverAsk {
	t.Helper()
	asks := f.asks.List("/p").Asks
	if len(asks) != 1 {
		t.Fatalf("asks: %+v", asks)
	}
	return asks[0]
}

func (f *leftoverAskFixture) setRun(state string) {
	f.lock.Lock()
	defer f.lock.Unlock()
	f.run.State = state
}

func (f *leftoverAskFixture) step(t *testing.T, after time.Duration) LeftoverAsk {
	t.Helper()
	f.now = f.now.Add(after)
	f.asks.Step(context.Background(), leftoverAskKey("/p", leftoverTree))
	return f.state(t)
}

var leftoverAskReq = LeftoverAskRequest{Dir: "/p", Repo: "o/r", Number: 1141, Worktree: leftoverTree, Local: true,
	Url: "https://github.com/o/r/pull/1141"}

// The request is MoltenTerm's fixed text: the worktree, its branch and the PR, the check, the removal commands, and
// "say why" otherwise; MoltenTerm itself never runs them.
func TestLeftoverRequestText(t *testing.T) {
	tree := mission.LinkedTree{Path: leftoverTree, Branch: "fix/1130-card"}
	owner := mission.LeftoverOwner{Pid: 44215}
	goal, ctx := leftoverRequestText(leftoverAskReq, tree, owner)
	for _, want := range []string{"pull request #1141 (merged)", leftoverTree, "fix/1130-card", "pid 44215",
		"git worktree unlock " + leftoverTree, "git worktree remove " + leftoverTree, "git branch -d fix/1130-card",
		"say why", "no --force"} {
		if !strings.Contains(goal, want) {
			t.Fatalf("goal lacks %q:\n%s", want, goal)
		}
	}
	if !strings.Contains(ctx, "https://github.com/o/r/pull/1141") {
		t.Fatalf("context: %s", ctx)
	}
	closed := leftoverAskReq
	closed.Closed, closed.Base, closed.Local = true, "develop", false
	goal, _ = leftoverRequestText(closed, tree, owner)
	if !strings.Contains(goal, "closed without merging; its content is already on develop") || strings.Contains(goal, "git branch -d") {
		t.Fatalf("closed PR without its local branch: %s", goal)
	}
}

// A live owner in a MoltenTerm terminal gets one request; the follow reads its turn: asked while it works, needs you
// when its turn ends with the worktree there, done once the worktree is gone.
func TestLeftoverAskFollowsTheOwner(t *testing.T) {
	f := makeLeftoverAskFixture(t)
	ask, err := f.asks.Ask(context.Background(), leftoverAskReq)
	if err != nil || ask.State != LeftoverAskAsked || ask.Owner.FirstName != "Valentin" || ask.Branch != "fix/1130-card" {
		t.Fatalf("ask: %+v %v", ask, err)
	}
	if len(f.sent) != 1 || f.sent[0].ToBlockId != "b-valentin" {
		t.Fatalf("sent: %+v", f.sent)
	}
	// Clicking again while it stands sends nothing more.
	if _, err := f.asks.Ask(context.Background(), leftoverAskReq); err != nil || len(f.sent) != 1 {
		t.Fatalf("a second click: %v %d", err, len(f.sent))
	}
	if got := f.step(t, time.Second); got.State != LeftoverAskAsked {
		t.Fatalf("idle before its turn: %+v", got)
	}
	f.setRun(molten.AgentStateWorking)
	if got := f.step(t, time.Second); got.State != LeftoverAskAsked {
		t.Fatalf("working: %+v", got)
	}
	f.setRun(molten.AgentStateIdle)
	if got := f.step(t, time.Second); got.State != LeftoverAskAsked {
		t.Fatalf("just idle, the outcome may still come: %+v", got)
	}
	if got := f.step(t, leftoverSettle); got.State != LeftoverAskNeedsYou || got.Why != LeftoverWhyStopped {
		t.Fatalf("its turn ended with the worktree there: %+v", got)
	}
	// The developer answers, the owner works again and removes it.
	f.setRun(molten.AgentStateWorking)
	if got := f.step(t, time.Second); got.State != LeftoverAskAsked {
		t.Fatalf("working again: %+v", got)
	}
	f.treeGone = true
	if got := f.step(t, time.Second); got.State != LeftoverAskDone {
		t.Fatalf("the worktree gone: %+v", got)
	}
	if f.asks.Step(context.Background(), leftoverAskKey("/p", leftoverTree)); len(f.asks.List("/p").Asks) != 1 {
		t.Fatalf("done lingers a little")
	}
	f.now = f.now.Add(leftoverDoneLinger + time.Second)
	if more := f.asks.Step(context.Background(), leftoverAskKey("/p", leftoverTree)); more || len(f.asks.List("/p").Asks) != 0 {
		t.Fatalf("done is dropped after its linger")
	}
}

// A question (the owner waits for an answer) or a "needs you:" outcome line needs the developer, with the reason.
func TestLeftoverAskNeedsYou(t *testing.T) {
	f := makeLeftoverAskFixture(t)
	f.outcome = "needs you: #1130 a encore un test en cours"
	if _, err := f.asks.Ask(context.Background(), leftoverAskReq); err != nil {
		t.Fatal(err)
	}
	f.setRun(molten.AgentStateWaiting)
	if got := f.step(t, time.Second); got.State != LeftoverAskNeedsYou || got.Why != LeftoverWhyQuestion || got.Reason != "#1130 a encore un test en cours" {
		t.Fatalf("waiting: %+v", got)
	}
	f.setRun(molten.AgentStateIdle)
	if got := f.step(t, time.Second); got.State != LeftoverAskNeedsYou || got.Why != LeftoverWhyOutcome || got.Reason != "#1130 a encore un test en cours" {
		t.Fatalf("its line: %+v", got)
	}
}

// A request queued behind the owner's work: its turn is not the request's until the queue typed it at an idle prompt.
func TestLeftoverAskQueuedBehindWork(t *testing.T) {
	f := makeLeftoverAskFixture(t)
	f.setRun(molten.AgentStateWorking)
	f.asks.env.Send = func(ctx context.Context, req agenthandoff.AppRequest) (agenthandoff.AppSent, error) {
		return agenthandoff.AppSent{Status: agenthandoff.StatusQueued}, nil
	}
	if _, err := f.asks.Ask(context.Background(), leftoverAskReq); err != nil {
		t.Fatal(err)
	}
	f.setRun(molten.AgentStateIdle)
	if got := f.step(t, leftoverSettle*2); got.State != LeftoverAskAsked {
		t.Fatalf("the end of its own work is not the request's: %+v", got)
	}
}

// No forced unlock: a process no terminal runs is not asked, and nothing is sent or kept; a lock that is no longer
// live sends nothing either, and the usual cleanup applies.
func TestLeftoverAskUnreachableAndFree(t *testing.T) {
	f := makeLeftoverAskFixture(t)
	f.owner = mission.LeftoverOwner{Via: mission.OwnerViaProcess, Pid: 7000, Process: "node", Folder: "/x"}
	ask, err := f.asks.Ask(context.Background(), leftoverAskReq)
	if err != nil || ask.State != LeftoverAskUnreachable || ask.Owner.Process != "node" || len(f.sent) != 0 || len(f.asks.List("/p").Asks) != 0 {
		t.Fatalf("unreachable: %+v %v %d", ask, err, len(f.sent))
	}
	f.ownerErr = mission.ErrLockNotLive
	ask, err = f.asks.Ask(context.Background(), leftoverAskReq)
	if err != nil || ask.State != LeftoverAskFree || len(f.sent) != 0 {
		t.Fatalf("free: %+v %v", ask, err)
	}
}

// The owner's session ended: the lock ended with it, the request is dropped.
func TestLeftoverAskOwnerEnded(t *testing.T) {
	f := makeLeftoverAskFixture(t)
	if _, err := f.asks.Ask(context.Background(), leftoverAskReq); err != nil {
		t.Fatal(err)
	}
	f.lock.Lock()
	f.run.Running = false
	f.lock.Unlock()
	if more := f.asks.Step(context.Background(), leftoverAskKey("/p", leftoverTree)); more || len(f.asks.List("/p").Asks) != 0 {
		t.Fatalf("an ended owner drops the request")
	}
}
