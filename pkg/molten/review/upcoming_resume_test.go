// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package review

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/agenthandoff"
	"github.com/wavetermdev/waveterm/pkg/molten/companion"
)

// #2270, FR-REV-022 AC23: Resume on an Upcoming ticket whose sub-agent stopped without a pull request. Synthetic agent
// states and tickets only.

func (f *leadFixture) upcomingResume() RestartResult {
	f.t.Helper()
	res, err := f.r.ResumeUpcoming(context.Background(), UpcomingResumeRequest{Dir: f.dir, Branch: "feature/9-fix-x", Ticket: 9,
		Title: "Fix x", Ahead: 3, Base: "develop"})
	if err != nil {
		f.t.Fatalf("resume: %v", err)
	}
	return res
}

func TestUpcomingResumeHandsTheStoppedSubagentToItsLead(t *testing.T) {
	t.Parallel()
	for _, state := range []string{companion.SubagentDone, companion.SubagentQuiet} {
		f := makeLeadFixture(t)
		f.arthurRuns()
		f.arthurRunsIn(f.runs)
		f.index(subagentOn("/w/agent-9", state))
		res := f.upcomingResume()
		if res.Status != RestartSent || !res.Lead || !res.Subagent || res.BlockId != "lead-block" || res.FirstName != "Arthur" ||
			res.Worktree != realOf("/w/agent-9") {
			t.Fatalf("%s: %+v", state, res)
		}
		f.nothingStarted()
		sent := f.sentRequests()
		if len(sent) != 1 || sent[0].ToBlockId != "lead-block" || !strings.HasPrefix(sent[0].Key, "upcomingresume|") {
			t.Fatalf("%s: one keyed request to the lead: %+v", state, sent)
		}
		brief := sent[0].Goal + "\n" + sent[0].Context + "\n" + sent[0].Closing
		for _, part := range []string{"a1b2c3d4e5f6", "SendMessage", "ticket #9", "feature/9-fix-x", realOf("/w/agent-9"),
			"never in a second one", "draft pull request", "push", "never merge", "Commits ahead when asked: 3", "\"Fix x\""} {
			if !strings.Contains(brief, part) {
				t.Errorf("%s: the brief misses %q:\n%s", state, part, brief)
			}
		}
		if strings.Contains(sent[0].Goal, "Fix x") || strings.Contains(sent[0].Goal, "#9 fix x") {
			t.Errorf("%s: the typed goal quotes no ticket or task words: %q", state, sent[0].Goal)
		}
	}
}

func TestUpcomingResumeSendsNothingTwiceWhilePending(t *testing.T) {
	t.Parallel()
	f := makeLeadFixture(t)
	f.arthurRuns()
	f.arthurRunsIn(f.runs)
	f.sendOut.Status = agenthandoff.StatusQueued
	f.index(subagentOn("/w/agent-9", companion.SubagentDone))
	if res := f.upcomingResume(); res.Status != RestartQueued {
		t.Fatalf("first: %+v", res)
	}
	again := f.upcomingResume()
	if again.Status != RestartBusy || again.Reason != RestartReasonAlreadyHanded || again.FirstName != "Arthur" {
		t.Fatalf("second click: %+v", again)
	}
	if n := len(f.sentRequests()); n != 1 {
		t.Fatalf("one brief only, got %d", n)
	}

	// Past the window, still queued for the lead's prompt: still handled.
	var lock sync.Mutex
	now := time.UnixMilli(5000)
	f.r.env.Now = func() time.Time {
		lock.Lock()
		defer lock.Unlock()
		return now
	}
	queued := true
	f.r.env.HandoffQueued = func(blockId string) bool { return queued && blockId == "lead-block" }
	lock.Lock()
	now = now.Add(handedWindow + time.Second)
	lock.Unlock()
	if res := f.upcomingResume(); res.Reason != RestartReasonAlreadyHanded {
		t.Fatalf("still queued: %+v", res)
	}
	// Out of the queue and the lead idle: a new click sends again.
	queued = false
	if res := f.upcomingResume(); res.Status != RestartQueued || len(f.sentRequests()) != 2 {
		t.Fatalf("after the queue: %+v, sent %d", res, len(f.sentRequests()))
	}
}

func TestUpcomingResumeLeavesAWorkingSubagent(t *testing.T) {
	t.Parallel()
	f := makeLeadFixture(t)
	f.arthurRuns()
	f.arthurRunsIn(f.runs)
	f.index(subagentOn("/w/agent-9", companion.SubagentRunning))
	res := f.upcomingResume()
	if res.Status != RestartBusy || res.Reason != RestartReasonSubagentBusy {
		t.Fatalf("result: %+v", res)
	}
	if len(f.sentRequests()) != 0 {
		t.Fatal("nothing is sent while the sub-agent works")
	}
}

func TestUpcomingResumeWithoutARunningLeadSendsNothing(t *testing.T) {
	t.Parallel()
	f := makeLeadFixture(t)
	f.index(subagentOn("/w/agent-9", companion.SubagentDone))
	res := f.upcomingResume()
	if res.Status != RestartFailed || res.Reason != RestartReasonNothingToResume {
		t.Fatalf("lead gone (the index says so): %+v", res)
	}
	// The lead's terminal still runs an agent but the handoffs cannot reach it.
	f.arthurRunsIn(f.runs)
	res = f.upcomingResume()
	if res.Status != RestartFailed || res.Reason != RestartReasonLeadNotRunning || !strings.Contains(res.Message, "Arthur") {
		t.Fatalf("lead not reachable: %+v", res)
	}
	if len(f.sentRequests()) != 0 {
		t.Fatal("nothing is sent")
	}
	f.nothingStarted()
}

func TestUpcomingResumeRequestIsChecked(t *testing.T) {
	t.Parallel()
	f := makeLeadFixture(t)
	for _, req := range []UpcomingResumeRequest{
		{Dir: "relative", Branch: "feature/9-x"},
		{Dir: f.dir, Branch: "-bad"},
		{Dir: f.dir, Branch: "feature/9-x", Base: "..bad"},
		{Dir: f.dir, Branch: "feature/9-x", Ahead: -1},
	} {
		if _, err := f.r.ResumeUpcoming(context.Background(), req); err == nil {
			t.Errorf("%+v: refused", req)
		}
	}
}
