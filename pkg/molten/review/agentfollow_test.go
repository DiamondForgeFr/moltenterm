// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// #758: without Start, Restart work offers to start an agent instead of starting one, and names the agent it would be.
func TestRestartOffersBeforeStartingAnAgent(t *testing.T) {
	f := makeRestartFixture(t)
	f.publishRound()
	req := f.request()
	req.Start, req.Mode, req.WorkspaceId = false, "", ""
	res, err := f.r.Restart(context.Background(), req)
	if err != nil || res.Status != RestartOffer || res.AgentName != "Claude Code" || res.Round != "round-one-id" {
		t.Fatalf("result: %+v %v", res, err)
	}
	if len(f.opened) != 0 || len(f.tabs) != 0 || f.round().RestartedAt != 0 {
		t.Errorf("nothing starts, nothing opens, nothing is marked: opened %v tabs %v", f.opened, f.tabs)
	}
}

// #758 AC1: out of sight, the agent gets a hidden tab of its own in the developer's workspace, never the Review tab.
func TestRestartStartsOutOfSight(t *testing.T) {
	f := makeRestartFixture(t)
	f.publishRound()
	res := f.restart()
	if res.Status != RestartStarted || res.TabId != "agent-tab" || !res.Hidden {
		t.Fatalf("result: %+v", res)
	}
	if len(f.tabs) != 1 || !f.tabs[0].hidden || f.tabs[0].workspaceId != "ws-1" || f.tabs[0].name != "Relance #9" {
		t.Fatalf("tabs: %+v", f.tabs)
	}
	origin, ok := f.openMeta[OriginMetaKey].(AgentOrigin)
	if !ok || origin.Kind != AgentOriginRestart || origin.Round != 1 || origin.Number != 9 || origin.Mode != AgentModeBackground || origin.At != 5000 {
		t.Errorf("the terminal says why it is there: %+v", f.openMeta[OriginMetaKey])
	}
}

// #758 AC2: with the developer, the tab is shown (the window activates it); a rebase's origin names the merge.
func TestAskRebaseTogetherOpensItsOwnTab(t *testing.T) {
	f := makeRestartFixture(t)
	req := f.rebaseRequest(true)
	req.MergedPr = 8
	res, err := f.r.AskRebase(context.Background(), req)
	if err != nil || res.Status != RestartStarted || res.Hidden || res.TabId != "agent-tab" {
		t.Fatalf("result: %+v %v", res, err)
	}
	if len(f.tabs) != 1 || f.tabs[0].hidden || f.tabs[0].name != "Rebase #9" {
		t.Errorf("tabs: %+v", f.tabs)
	}
	origin, _ := f.openMeta[OriginMetaKey].(AgentOrigin)
	if origin.Kind != AgentOriginRebase || origin.MergedPr != 8 || origin.Base != "develop" || origin.Mode != AgentModeTogether {
		t.Errorf("origin: %+v", origin)
	}
}

// followFixture: an agent started on the PR in a worktree MoltenTerm made, in background mode.
func followFixture(t *testing.T) (*restartFixture, agentFollow, *followState) {
	f := makeRestartFixture(t)
	f.publishRound()
	res := f.restart()
	if res.Status != RestartStarted || !res.WorktreeCreated {
		t.Fatalf("result: %+v", res)
	}
	follow := agentFollow{req: f.request(), origin: AgentOrigin{Kind: AgentOriginRestart, Mode: AgentModeBackground, Round: 1},
		tree: res.Worktree, created: true, blockId: "new-block", tabId: "agent-tab", agent: molten.AgentIdClaude,
		startHead: f.git(res.Worktree, "rev-parse", "HEAD")}
	f.runs["new-block"] = molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateWorking, FirstName: "Bruno"}
	return f, follow, &followState{}
}

func (f *restartFixture) setAgent(state string, since int64) {
	run := f.runs["new-block"]
	run.State, run.StateSince = state, since
	f.runs["new-block"] = run
}

func (f *restartFixture) commitIn(tree string, name string) {
	f.write(tree, name, "work\n")
	f.git(tree, "add", name)
	f.git(tree, "commit", "--quiet", "-m", "fix(#9): "+name)
}

// AC4: pushed and clean, the terminal closes, the worktree goes, and a notification opens the review.
func TestFollowCleansUpOncePushedAndClean(t *testing.T) {
	f, follow, st := followFixture(t)
	if !f.r.followStep(context.Background(), follow, st) || len(f.closed) != 0 {
		t.Fatalf("a working agent is left alone")
	}
	f.commitIn(follow.tree, "c.txt")
	f.git(follow.tree, "push", "--quiet", "origin", "feature/9-fix-x")
	f.write(follow.tree, "build/out.bin", "ignored\n")
	f.write(follow.tree, ".gitignore", "build/\n")
	f.git(follow.tree, "add", ".gitignore")
	f.git(follow.tree, "commit", "--quiet", "-m", "chore(#9): ignore")
	f.git(follow.tree, "push", "--quiet", "origin", "feature/9-fix-x")
	f.setAgent(molten.AgentStateDone, 10)
	if f.r.followStep(context.Background(), follow, st) {
		t.Fatalf("the follow ends once cleaned up")
	}
	if len(f.closed) != 1 || f.closed[0] != "new-block" {
		t.Errorf("closed %v", f.closed)
	}
	if pathExists(follow.tree) {
		t.Errorf("the worktree MoltenTerm made is removed (ignored files are not work)")
	}
	if len(f.notes) != 1 {
		t.Fatalf("notes %+v", f.notes)
	}
	note := f.notes[0]
	if note.TitleText.Code != "notif.review.reworkedTitle" || note.Kind != "success" || note.TitleText.Vars["name"] != "Bruno" ||
		len(note.Actions) != 1 || note.Actions[0].Gesture != ReviewOpenGesture || note.Actions[0].LabelText.Code != "notif.review.openReview" {
		t.Errorf("note %+v", note)
	}
	if pr, _ := note.Actions[0].Args["pr"].(PrInfo); pr.Number != 9 || pr.Dir != f.dir {
		t.Errorf("the action opens the PR's review: %+v", note.Actions[0].Args)
	}
	if len(f.resolved) != 1 || !strings.HasPrefix(f.resolved[0], agentNoticePrefix+"needs:") {
		t.Errorf("what it needed is resolved: %v", f.resolved)
	}
}

// AC4: with work left, nothing is removed and the notification names it in plain words.
func TestFollowNamesTheWorkLeft(t *testing.T) {
	f, follow, st := followFixture(t)
	f.r.followStep(context.Background(), follow, st)
	f.commitIn(follow.tree, "c.txt")
	f.git(follow.tree, "push", "--quiet", "origin", "feature/9-fix-x")
	f.write(follow.tree, "draft.txt", "unsaved\n")
	f.setAgent(molten.AgentStateDone, 10)
	if !f.r.followStep(context.Background(), follow, st) {
		t.Fatalf("still followed")
	}
	if len(f.closed) != 0 || !pathExists(follow.tree) {
		t.Errorf("nothing is closed or removed")
	}
	if len(f.notes) != 1 || f.notes[0].MessageText.Code != "notif.review.changes" || f.notes[0].MessageText.Vars["names"] != "draft.txt" ||
		f.notes[0].BlockId != "new-block" || f.notes[0].Kind != "warning" || !strings.Contains(f.notes[0].Message, "uncommitted files (1): draft.txt") {
		t.Fatalf("notes %+v", f.notes)
	}
	f.r.followStep(context.Background(), follow, st)
	if len(f.notes) != 1 {
		t.Errorf("the same situation is told once: %d", len(f.notes))
	}
	f.write(follow.tree, "draft.txt", "")
	f.git(follow.tree, "checkout", "--", ".")
	f.git(follow.tree, "clean", "-fq")
	f.commitIn(follow.tree, "d.txt")
	f.setAgent(molten.AgentStateDone, 20)
	f.r.followStep(context.Background(), follow, st)
	if len(f.notes) != 2 || f.notes[1].MessageText.Code != "notif.review.commits" || f.notes[1].MessageText.Vars["count"] != "1" {
		t.Fatalf("unpushed commits are named: %+v", f.notes)
	}
}

// AC3: an agent waiting for an answer is told by its own notification; the follow opens nothing and adds nothing.
func TestFollowLeavesAWaitingAgentToItsNotification(t *testing.T) {
	f, follow, st := followFixture(t)
	f.r.followStep(context.Background(), follow, st)
	f.setAgent(molten.AgentStateWaiting, 10)
	if !f.r.followStep(context.Background(), follow, st) || len(f.notes) != 0 || len(f.closed) != 0 {
		t.Errorf("notes %+v closed %v", f.notes, f.closed)
	}
}

// An agent that stopped without pushing, or whose session ended, needs the developer.
func TestFollowTellsAStopBeforeThePush(t *testing.T) {
	f, follow, st := followFixture(t)
	f.setAgent(molten.AgentStateIdle, 1)
	f.r.followStep(context.Background(), follow, st)
	if len(f.notes) != 0 {
		t.Fatalf("an agent that has not worked yet is starting, not stopped: %+v", f.notes)
	}
	f.setAgent(molten.AgentStateWorking, 2)
	f.r.followStep(context.Background(), follow, st)
	f.setAgent(molten.AgentStateDone, 3)
	f.r.followStep(context.Background(), follow, st)
	if len(f.notes) != 1 || f.notes[0].MessageText.Code != "notif.review.stopped" || f.notes[0].TitleText.Code != "notif.review.needsTitle" {
		t.Fatalf("notes %+v", f.notes)
	}
	run := f.runs["new-block"]
	run.Running = false
	f.runs["new-block"] = run
	f.r.followStep(context.Background(), follow, st)
	if len(f.notes) != 2 || f.notes[1].MessageText.Code != "notif.review.exited" {
		t.Fatalf("notes %+v", f.notes)
	}
}

// A turn short enough to start and end between two reads still counts once the agent says done.
func TestFollowSeesAShortTurn(t *testing.T) {
	f, follow, st := followFixture(t)
	f.commitIn(follow.tree, "c.txt")
	f.git(follow.tree, "push", "--quiet", "origin", "feature/9-fix-x")
	f.write(follow.tree, "notes.txt", "draft\n")
	f.setAgent(molten.AgentStateDone, 10)
	f.r.followStep(context.Background(), follow, st)
	if len(f.notes) != 1 || f.notes[0].MessageText.Code != "notif.review.changes" {
		t.Fatalf("notes %+v", f.notes)
	}
}

// With the developer (together), a stop is theirs to see: no notification.
func TestFollowTogetherDoesNotNotifyAStop(t *testing.T) {
	f, follow, st := followFixture(t)
	follow.origin.Mode = AgentModeTogether
	f.r.followStep(context.Background(), follow, st)
	f.setAgent(molten.AgentStateDone, 3)
	f.r.followStep(context.Background(), follow, st)
	if len(f.notes) != 0 {
		t.Errorf("notes %+v", f.notes)
	}
}

// The developer closed the terminal: the follow ends and what it needed is resolved.
func TestFollowEndsWithItsTerminal(t *testing.T) {
	f, follow, st := followFixture(t)
	f.gone["new-block"] = true
	if f.r.followStep(context.Background(), follow, st) || len(f.closed) != 0 || len(f.resolved) != 1 {
		t.Errorf("closed %v resolved %v", f.closed, f.resolved)
	}
}

// A worktree MoltenTerm did not make stays, even once the agent finished cleanly.
func TestFollowKeepsAWorktreeItDidNotMake(t *testing.T) {
	f, follow, st := followFixture(t)
	follow.created = false
	f.r.followStep(context.Background(), follow, st)
	f.commitIn(follow.tree, "c.txt")
	f.git(follow.tree, "push", "--quiet", "origin", "feature/9-fix-x")
	f.setAgent(molten.AgentStateDone, 10)
	f.r.followStep(context.Background(), follow, st)
	if len(f.closed) != 1 || !pathExists(follow.tree) || f.notes[0].MessageText != nil {
		t.Errorf("closed %v notes %+v", f.closed, f.notes)
	}
}

// A rebase stopped halfway is never clean, whatever the agent's state.
func TestFollowSeesARebaseStoppedHalfway(t *testing.T) {
	f, follow, st := followFixture(t)
	gitDir := f.git(follow.tree, "rev-parse", "--git-path", "rebase-merge")
	if !filepath.IsAbs(gitDir) {
		gitDir = filepath.Join(follow.tree, gitDir)
	}
	f.write(gitDir, "head-name", "refs/heads/feature/9-fix-x\n")
	f.r.followStep(context.Background(), follow, st)
	f.setAgent(molten.AgentStateDone, 10)
	f.r.env.Now = func() time.Time { return time.UnixMilli(99_000) }
	f.r.followStep(context.Background(), follow, st)
	if len(f.closed) != 0 || len(f.notes) != 1 || f.notes[0].MessageText.Code != "notif.review.midRebase" {
		t.Errorf("closed %v notes %+v", f.closed, f.notes)
	}
}
