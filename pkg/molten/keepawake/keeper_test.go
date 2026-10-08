// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package keepawake

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

type fakeEnv struct {
	now        time.Time
	policy     string
	work       Work
	workspaces map[string]string
	notices    []molten.NotificationInput
	published  []State
	alive      map[int32]bool
	workCalls  int
}

func makeFakeEnv() *fakeEnv {
	return &fakeEnv{
		now:        time.UnixMilli(1_000_000),
		work:       Work{Workspaces: map[string]bool{}},
		workspaces: map[string]string{"ws-a": "Alpha", "ws-b": "Beta"},
		alive:      map[int32]bool{},
	}
}

func (f *fakeEnv) keeper() *Keeper {
	return MakeKeeper(Env{
		Now:    func() time.Time { return f.now },
		Policy: func() string { return f.policy },
		Work: func(ctx context.Context) Work {
			f.workCalls++
			return f.work
		},
		Workspace: func(ctx context.Context, wsId string) (string, bool) {
			name, ok := f.workspaces[wsId]
			return name, ok
		},
		LocateNames: func(ctx context.Context, blockId string) (string, string, string) {
			return "ws-a", "Alpha", "Tab 1"
		},
		Notify:       func(n molten.NotificationInput) { f.notices = append(f.notices, n) },
		Publish:      func(s State) { f.published = append(f.published, s) },
		ProcessAlive: func(pid int32) bool { return f.alive[pid] },
		ProcessName:  func(pid int32) string { return "claude" },
	})
}

func (f *fakeEnv) advance(d time.Duration) {
	f.now = f.now.Add(d)
}

func TestCoffeeHoldsWhileWorkRunsAndEndsAfterGrace(t *testing.T) {
	f := makeFakeEnv()
	k := f.keeper()
	ctx := context.Background()
	f.work.Workspaces["ws-a"] = true
	state, err := k.SetCoffee(ctx, "ws-a", true)
	if err != nil {
		t.Fatal(err)
	}
	if !state.Hold || len(state.Coffees) != 1 || !state.Coffees[0].Working || state.Coffees[0].WorkspaceName != "Alpha" {
		t.Fatalf("coffee on with work: %+v", state)
	}
	// Work elsewhere does not keep it on (AC11).
	f.work.Workspaces = map[string]bool{"ws-b": true}
	f.advance(time.Second)
	k.Evaluate(ctx)
	state = k.State()
	if state.Coffees[0].Working || state.Coffees[0].EndsAt != f.now.Add(GracePeriod).UnixMilli() {
		t.Fatalf("grace not started: %+v", state.Coffees[0])
	}
	f.advance(GracePeriod - time.Second)
	k.Evaluate(ctx)
	if len(k.State().Coffees) != 1 || len(f.notices) != 0 {
		t.Fatalf("ended before the grace: %+v %v", k.State(), f.notices)
	}
	f.advance(time.Second)
	k.Evaluate(ctx)
	state = k.State()
	if len(state.Coffees) != 0 || state.Hold {
		t.Fatalf("coffee did not end: %+v", state)
	}
	if len(f.notices) != 1 || !strings.Contains(f.notices[0].Title, "Alpha: work finished") || f.notices[0].WorkspaceId != "ws-a" {
		t.Fatalf("notices: %+v", f.notices)
	}
	k.Evaluate(ctx)
	if len(f.notices) != 1 {
		t.Fatalf("notified twice: %+v", f.notices)
	}
}

func TestCoffeeWorkResumingInGraceKeepsIt(t *testing.T) {
	f := makeFakeEnv()
	k := f.keeper()
	ctx := context.Background()
	if _, err := k.SetCoffee(ctx, "ws-a", true); err != nil {
		t.Fatal(err)
	}
	// Turned on with nothing running: it starts in its grace.
	state := k.State()
	if state.Coffees[0].Working || state.Coffees[0].EndsAt == 0 || !state.Hold {
		t.Fatalf("idle coffee: %+v", state)
	}
	f.advance(GracePeriod - 10*time.Second)
	f.work.Workspaces["ws-a"] = true
	k.Evaluate(ctx)
	f.work.Workspaces = map[string]bool{}
	f.advance(30 * time.Second)
	k.Evaluate(ctx)
	if len(k.State().Coffees) != 1 {
		t.Fatalf("work in the grace did not restart it: %+v", k.State())
	}
	f.advance(GracePeriod)
	k.Evaluate(ctx)
	if len(k.State().Coffees) != 0 || len(f.notices) != 1 {
		t.Fatalf("did not end after a new grace: %+v %v", k.State(), f.notices)
	}
}

func TestCoffeeOffReleasesAtOnceAndDeletedWorkspaceEndsSilently(t *testing.T) {
	f := makeFakeEnv()
	k := f.keeper()
	ctx := context.Background()
	f.work.Workspaces["ws-a"] = true
	k.SetCoffee(ctx, "ws-a", true)
	k.SetCoffee(ctx, "ws-b", true)
	state, _ := k.SetCoffee(ctx, "ws-a", false)
	if len(state.Coffees) != 1 || state.Coffees[0].WorkspaceId != "ws-b" || !state.Hold {
		t.Fatalf("off: %+v", state)
	}
	delete(f.workspaces, "ws-b")
	k.Evaluate(ctx)
	state = k.State()
	if state.Hold || len(state.Coffees) != 0 || len(f.notices) != 0 {
		t.Fatalf("deleted workspace: %+v %v", state, f.notices)
	}
	if _, err := k.SetCoffee(ctx, "ws-b", true); err == nil {
		t.Fatalf("a coffee on a deleted workspace was accepted")
	}
}

func TestPolicyUntilWorkEnds(t *testing.T) {
	f := makeFakeEnv()
	k := f.keeper()
	ctx := context.Background()
	f.policy = PolicyUntilWorkEnds
	k.Evaluate(ctx)
	if k.State().Hold {
		t.Fatalf("held with no work")
	}
	f.work.Local = true
	k.Evaluate(ctx)
	state := k.State()
	if !state.Hold || !state.PolicyHolding || !state.PolicyWorking {
		t.Fatalf("work runs: %+v", state)
	}
	f.work.Local = false
	k.Evaluate(ctx)
	state = k.State()
	if !state.Hold || state.PolicyWorking || state.PolicyEndsAt == 0 {
		t.Fatalf("grace: %+v", state)
	}
	f.advance(GracePeriod)
	k.Evaluate(ctx)
	if k.State().Hold || len(f.notices) != 1 || !strings.HasPrefix(f.notices[0].Title, "Work finished") {
		t.Fatalf("release: %+v %v", k.State(), f.notices)
	}
	// Another policy drops the reason at once, without a notification.
	f.work.Local = true
	k.Evaluate(ctx)
	f.policy = PolicyLetSleep
	k.Evaluate(ctx)
	if k.State().Hold || len(f.notices) != 1 {
		t.Fatalf("policy change: %+v %v", k.State(), f.notices)
	}
}

func TestNoWorkReadWhenNothingNeedsIt(t *testing.T) {
	f := makeFakeEnv()
	k := f.keeper()
	f.policy = PolicyLetSleep
	k.Evaluate(context.Background())
	if f.workCalls != 0 {
		t.Fatalf("work read %d times", f.workCalls)
	}
}

func TestCoffeeAppliesUnderLetItSleep(t *testing.T) {
	f := makeFakeEnv()
	k := f.keeper()
	f.policy = PolicyLetSleep
	f.work.Workspaces["ws-a"] = true
	state, _ := k.SetCoffee(context.Background(), "ws-a", true)
	if !state.Hold {
		t.Fatalf("coffee under Let it sleep does not hold")
	}
	// The coffee never asks (AC12).
	if len(f.notices) != 0 {
		t.Fatalf("notices: %v", f.notices)
	}
}

func TestShimDecisionsAndAskOnce(t *testing.T) {
	f := makeFakeEnv()
	k := f.keeper()
	ctx := context.Background()
	req := ShimRequest{BlockId: "b1", Tool: ToolCaffeinate, Args: []string{"-i", "-t", "300"}, Pid: 10, ParentPid: 9}
	answer, err := k.Shim(ctx, req)
	if err != nil || answer.Policy != PolicyAllow {
		t.Fatalf("unset policy: %v %v", answer, err)
	}
	if len(f.notices) != 1 || f.notices[0].Key != AskNotificationKey || len(f.notices[0].Actions) != 3 {
		t.Fatalf("ask once: %+v", f.notices)
	}
	k.Shim(ctx, req)
	if len(f.notices) != 1 {
		t.Fatalf("asked twice")
	}
	f.policy = PolicyLetSleep
	answer, _ = k.Shim(ctx, req)
	if answer.Policy != PolicyLetSleep {
		t.Fatalf("let it sleep: %v", answer)
	}
	if _, err := k.SetOverride(ctx, OverrideRequest{BlockId: "b1", Policy: PolicyAllow}); err != nil {
		t.Fatal(err)
	}
	answer, _ = k.Shim(ctx, req)
	if answer.Policy != PolicyAllow {
		t.Fatalf("override: %v", answer)
	}
	answer, _ = k.Shim(ctx, ShimRequest{BlockId: "b2", Tool: ToolCaffeinate, Pid: 11})
	if answer.Policy != PolicyLetSleep {
		t.Fatalf("the override leaked to another session: %v", answer)
	}
	f.policy = PolicyUntilWorkEnds
	answer, _ = k.Shim(ctx, ShimRequest{BlockId: "b2", Tool: ToolCaffeinate, Pid: 12})
	if answer.Policy != PolicyAllow {
		t.Fatalf("until work ends lets blocks through: %v", answer)
	}
	state := k.State()
	if len(state.Overrides) != 1 || state.Overrides[0].TabName != "Tab 1" {
		t.Fatalf("overrides: %+v", state.Overrides)
	}
	outcomes := map[string]int{}
	for _, a := range state.Attempts {
		outcomes[a.Outcome]++
	}
	if outcomes[OutcomeNeutralised] != 2 || outcomes[OutcomeAllowed] != 4 || state.Attempts[0].ParentName != "claude" {
		t.Fatalf("attempts: %+v", state.Attempts)
	}
	// The session's end ends its override and its attempts (AC6).
	k.ForgetBlock("b1")
	state = k.State()
	if len(state.Overrides) != 0 {
		t.Fatalf("override kept: %+v", state.Overrides)
	}
	for _, a := range state.Attempts {
		if a.BlockId == "b1" {
			t.Fatalf("attempt of a closed block kept")
		}
	}
	// Attempts whose process exited go.
	f.alive[12] = true
	k.Evaluate(ctx)
	state = k.State()
	if len(state.Attempts) != 1 || state.Attempts[0].Pid != 12 {
		t.Fatalf("dead attempts: %+v", state.Attempts)
	}
	if _, err := k.SetOverride(ctx, OverrideRequest{BlockId: "b2", Policy: PolicyUntilWorkEnds}); err == nil {
		t.Fatalf("an invalid override was accepted")
	}
	if _, err := k.Shim(ctx, ShimRequest{Tool: "sleep"}); err == nil {
		t.Fatalf("an unknown tool was accepted")
	}
}

func TestPublishOnlyOnChangeWithGrowingVersion(t *testing.T) {
	f := makeFakeEnv()
	k := f.keeper()
	ctx := context.Background()
	k.Evaluate(ctx)
	k.Evaluate(ctx)
	if len(f.published) != 1 {
		t.Fatalf("published %d times", len(f.published))
	}
	k.SetCoffee(ctx, "ws-a", true)
	if len(f.published) != 2 || f.published[1].Version <= f.published[0].Version || !f.published[1].Hold {
		t.Fatalf("published: %+v", f.published)
	}
	if k.State().Version != f.published[1].Version {
		t.Fatalf("state version %d, published %d", k.State().Version, f.published[1].Version)
	}
}

func TestCleanPolicy(t *testing.T) {
	cases := map[string]string{"allow": PolicyAllow, " UntilWorkEnds ": PolicyUntilWorkEnds, "letsleep": PolicyLetSleep, "": PolicyAsk, "never": PolicyAsk}
	for in, want := range cases {
		if got := CleanPolicy(in); got != want {
			t.Errorf("CleanPolicy(%q) = %q, want %q", in, got, want)
		}
	}
}
