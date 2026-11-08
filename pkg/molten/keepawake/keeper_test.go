// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package keepawake

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

type fakeEnv struct {
	now        time.Time
	cfg        Config
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
		cfg:        DefaultConfig(),
		work:       Work{Workspaces: map[string]bool{}},
		workspaces: map[string]string{"ws-a": "Alpha", "ws-b": "Beta"},
		alive:      map[int32]bool{},
	}
}

func (f *fakeEnv) keeper() *Keeper {
	return MakeKeeper(Env{
		Now:    func() time.Time { return f.now },
		Config: func() Config { return f.cfg },
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

// The Manual switch holds until it is turned off: the work ending, however long ago, does not end it (FR-SHELL-023 AC14).
func TestManualHoldsUntilTurnedOff(t *testing.T) {
	f := makeFakeEnv()
	k := f.keeper()
	ctx := context.Background()
	f.work.Workspaces["ws-a"] = true
	state, err := k.SetCoffee(ctx, "ws-a", true)
	if err != nil {
		t.Fatal(err)
	}
	if !state.Hold || len(state.Coffees) != 1 || !state.Coffees[0].Working || state.Coffees[0].WorkspaceName != "Alpha" {
		t.Fatalf("manual on with work: %+v", state)
	}
	// Work elsewhere is not this workspace's work, and the switch holds all the same.
	f.work.Workspaces = map[string]bool{"ws-b": true}
	f.advance(time.Second)
	k.Evaluate(ctx)
	state = k.State()
	if state.Coffees[0].Working || !state.Hold {
		t.Fatalf("work elsewhere: %+v", state)
	}
	f.advance(24 * time.Hour)
	k.Evaluate(ctx)
	state = k.State()
	if len(state.Coffees) != 1 || !state.Hold || len(f.notices) != 0 {
		t.Fatalf("manual ended by itself: %+v %v", state, f.notices)
	}
	state, _ = k.SetCoffee(ctx, "ws-a", false)
	if state.Hold || len(state.Coffees) != 0 {
		t.Fatalf("manual off: %+v", state)
	}
}

// The approvals of FR-SHELL-063 keep the window the coffee had: its work, and the grace delay after it (AC17).
func TestManualApprovesOnlyWhileTheWorkRunsAndInTheGrace(t *testing.T) {
	f := makeFakeEnv()
	k := f.keeper()
	ctx := context.Background()
	if k.HasCoffee("ws-a") {
		t.Fatalf("no coffee covers anything")
	}
	if _, err := k.SetCoffee(ctx, "ws-a", true); err != nil {
		t.Fatal(err)
	}
	if !k.HasCoffee("ws-a") {
		t.Fatalf("turned on with nothing running, it starts in its grace")
	}
	f.advance(f.cfg.Grace - time.Second)
	if !k.HasCoffee("ws-a") {
		t.Fatalf("still in its grace")
	}
	f.advance(time.Second)
	k.Evaluate(ctx)
	if k.HasCoffee("ws-a") || !k.State().Hold {
		t.Fatalf("after the grace the switch holds the computer but approves nothing: %+v", k.State())
	}
	f.work.Workspaces["ws-a"] = true
	k.Evaluate(ctx)
	if !k.HasCoffee("ws-a") {
		t.Fatalf("work in the workspace covers it again")
	}
	f.work.Workspaces = map[string]bool{}
	f.advance(time.Second)
	k.Evaluate(ctx)
	if !k.HasCoffee("ws-a") {
		t.Fatalf("the grace after the work covers it")
	}
	f.advance(f.cfg.Grace)
	if k.HasCoffee("ws-a") {
		t.Fatalf("the grace is over")
	}
}

func TestManualOffReleasesAtOnceAndDeletedWorkspaceEndsSilently(t *testing.T) {
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

func TestAutomatic(t *testing.T) {
	f := makeFakeEnv()
	k := f.keeper()
	ctx := context.Background()
	f.cfg.Automatic = true
	k.Evaluate(ctx)
	if k.State().Hold || !k.State().Automatic {
		t.Fatalf("held with no work, or not shown on: %+v", k.State())
	}
	f.work.Local = true
	k.Evaluate(ctx)
	state := k.State()
	if !state.Hold || !state.AutomaticHolding || !state.AutomaticWorking {
		t.Fatalf("work runs: %+v", state)
	}
	f.work.Local = false
	k.Evaluate(ctx)
	state = k.State()
	if !state.Hold || state.AutomaticWorking || state.AutomaticEndsAt != f.now.Add(DefaultGrace).UnixMilli() {
		t.Fatalf("grace: %+v", state)
	}
	f.advance(DefaultGrace)
	k.Evaluate(ctx)
	if k.State().Hold || len(f.notices) != 1 || !strings.HasPrefix(f.notices[0].Title, "Work finished") {
		t.Fatalf("release: %+v %v", k.State(), f.notices)
	}
	if got := f.notices[0].MessageText.Vars["minutes"]; got != "2" {
		t.Fatalf("the notice says %q minutes", got)
	}
	// Turning Automatic off drops the reason at once, without a notification.
	f.work.Local = true
	k.Evaluate(ctx)
	f.cfg.Automatic = false
	k.Evaluate(ctx)
	if k.State().Hold || k.State().Automatic || len(f.notices) != 1 {
		t.Fatalf("automatic off: %+v %v", k.State(), f.notices)
	}
}

func TestAutomaticGraceFollowsTheSetting(t *testing.T) {
	f := makeFakeEnv()
	k := f.keeper()
	ctx := context.Background()
	f.cfg.Automatic = true
	f.cfg.Grace = 10 * time.Minute
	f.work.Local = true
	k.Evaluate(ctx)
	f.work.Local = false
	k.Evaluate(ctx)
	if got := k.State().AutomaticEndsAt; got != f.now.Add(10*time.Minute).UnixMilli() {
		t.Fatalf("ends at %d", got)
	}
	f.advance(10*time.Minute - time.Second)
	k.Evaluate(ctx)
	if !k.State().Hold {
		t.Fatalf("released before the grace delay")
	}
	f.advance(time.Second)
	k.Evaluate(ctx)
	if k.State().Hold || f.notices[0].MessageText.Vars["minutes"] != "10" {
		t.Fatalf("not released after it: %+v %+v", k.State(), f.notices)
	}
}

// Manual and Automatic are independent: either holds alone, both can hold, and the state says which (AC14).
func TestManualAndAutomaticHoldIndependently(t *testing.T) {
	f := makeFakeEnv()
	k := f.keeper()
	ctx := context.Background()
	f.cfg.Automatic = true
	f.work.Local = true
	f.work.Workspaces["ws-a"] = true
	f.work.LocalReasons = []string{"Léa: working"}
	k.Evaluate(ctx)
	state := k.State()
	if !state.Hold || !state.AutomaticHolding || len(state.Coffees) != 0 {
		t.Fatalf("automatic alone: %+v", state)
	}
	state, _ = k.SetCoffee(ctx, "ws-a", true)
	if !state.AutomaticHolding || len(state.Coffees) != 1 {
		t.Fatalf("both: %+v", state)
	}
	f.cfg.Automatic = false
	k.Evaluate(ctx)
	state = k.State()
	if !state.Hold || state.AutomaticHolding || len(state.Coffees) != 1 {
		t.Fatalf("manual alone: %+v", state)
	}
}

func TestNoWorkReadWhenNothingNeedsIt(t *testing.T) {
	f := makeFakeEnv()
	k := f.keeper()
	f.cfg.Requests = RequestsNever
	k.Evaluate(context.Background())
	if f.workCalls != 0 {
		t.Fatalf("work read %d times", f.workCalls)
	}
}

func TestManualAppliesWhateverTheTerminalRequestsSetting(t *testing.T) {
	f := makeFakeEnv()
	k := f.keeper()
	f.cfg.Requests = RequestsNever
	f.work.Workspaces["ws-a"] = true
	state, _ := k.SetCoffee(context.Background(), "ws-a", true)
	if !state.Hold {
		t.Fatalf("manual with requests refused does not hold")
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
		t.Fatalf("unset requests: %v %v", answer, err)
	}
	if len(f.notices) != 1 || f.notices[0].Key != AskNotificationKey || len(f.notices[0].Actions) != 3 {
		t.Fatalf("ask once: %+v", f.notices)
	}
	k.Shim(ctx, req)
	if len(f.notices) != 1 {
		t.Fatalf("asked twice")
	}
	f.cfg.Requests = RequestsNever
	answer, _ = k.Shim(ctx, req)
	if answer.Policy != PolicyLetSleep {
		t.Fatalf("never: %v", answer)
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
	f.cfg.Requests = RequestsAlways
	f.cfg.Automatic = true
	answer, _ = k.Shim(ctx, ShimRequest{BlockId: "b2", Tool: ToolCaffeinate, Pid: 12})
	if answer.Policy != PolicyAllow {
		t.Fatalf("always lets blocks through: %v", answer)
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

func TestLateShimAnswerIsRecordedAsAllowed(t *testing.T) {
	f := makeFakeEnv()
	k := f.keeper()
	f.cfg.Requests = RequestsNever
	// The shim stops waiting at its deadline and runs the real tool: an answer past it cannot stop the block.
	answer, _ := k.Shim(context.Background(), ShimRequest{BlockId: "b1", Tool: ToolCaffeinate, Pid: 10, Deadline: f.now.UnixMilli() + 10})
	if answer.Policy != PolicyAllow || k.State().Attempts[0].Outcome != OutcomeAllowed {
		t.Fatalf("late answer: %v %+v", answer, k.State().Attempts)
	}
	answer, _ = k.Shim(context.Background(), ShimRequest{BlockId: "b1", Tool: ToolCaffeinate, Pid: 11, Deadline: f.now.UnixMilli() + 400})
	if answer.Policy != PolicyLetSleep {
		t.Fatalf("answer in time: %v", answer)
	}
	long := strings.Repeat("x", 1000)
	k.Shim(context.Background(), ShimRequest{BlockId: "b1", Tool: ToolCaffeinate, Pid: 12, Args: []string{long}})
	if got := k.State().Attempts[2].Args[0]; len(got) > 210 {
		t.Fatalf("argument not clipped: %d bytes", len(got))
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

func TestCleanRequests(t *testing.T) {
	cases := map[string]string{"always": RequestsAlways, " Never ": RequestsNever, "": RequestsAsk, "allow": RequestsAsk}
	for in, want := range cases {
		if got := CleanRequests(in); got != want {
			t.Errorf("CleanRequests(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestConfigFromSettings(t *testing.T) {
	if got := ConfigFromSettings(wconfig.SettingsType{}); got != DefaultConfig() {
		t.Fatalf("nothing set: %+v", got)
	}
	minutes, off := int64(10), false
	got := ConfigFromSettings(wconfig.SettingsType{
		PowerAutomatic: true, PowerTerminalRequests: "never", PowerGraceMinutes: &minutes,
		PowerWorkAgents: &off, PowerWorkCommands: &off,
	})
	want := Config{Automatic: true, Requests: RequestsNever, Grace: 10 * time.Minute, Work: WorkRules{Projects: true}}
	if got != want {
		t.Fatalf("set: %+v, want %+v", got, want)
	}
	odd := int64(3)
	if got := ConfigFromSettings(wconfig.SettingsType{PowerGraceMinutes: &odd, PowerTerminalRequests: "ask"}); got != DefaultConfig() {
		t.Fatalf("invalid values read as their default: %+v", got)
	}
}

// #1311: a default view never renamed is named by its key; the English says its name, the code keeps the key for the
// window to word.
func TestAskNotificationNamesADefaultView(t *testing.T) {
	n := askNotification("caffeinate", "Olivia", "ws1", "workspaceViews.names.scoping")
	if !strings.HasPrefix(n.Message, "Olivia in Scoping ran caffeinate.") {
		t.Fatalf("message %q", n.Message)
	}
	if n.MessageText == nil || n.MessageText.Vars["tab"] != "workspaceViews.names.scoping" {
		t.Fatalf("message text %+v", n.MessageText)
	}
}
