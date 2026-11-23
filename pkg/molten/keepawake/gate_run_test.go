// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package keepawake

import (
	"context"
	"strings"
	"testing"
	"time"
)

// The review of #2474 (PR #2479): a mode belongs to one run of the agent, a clipped request is not allowed from a
// window, a save does not hold the gate, an early timer does not end a period, and the hook awaits a held request in a
// second call.

const runSession = "11111111-2222-3333-4444-555555555555"

func (f *gateFixture) lastSaved() []Autonomy {
	f.lock.Lock()
	defer f.lock.Unlock()
	if len(f.saved) == 0 {
		return nil
	}
	return f.saved[len(f.saved)-1]
}

func (f *gateFixture) timerCount() int {
	f.lock.Lock()
	defer f.lock.Unlock()
	return len(f.timers)
}

// A run that ends takes its modes with it: the next run of the same session (`claude --continue`, `--resume`,
// `--session-id`) asks again, and what was kept for a restart goes too.
func TestGateModeEndsWhenItsRunEnds(t *testing.T) {
	f := makeGateFixture(t)
	g := f.gate()
	f.setRun("block-1", testRun)
	g.SetMode(GateModeRequest{Run: testRun, BlockId: "block-1", SessionId: runSession, Mode: ModeAlways})
	g.SetMode(GateModeRequest{Run: testRun, BlockId: "block-1", SessionId: "99999999-aaaa", Mode: ModeFor, Period: PeriodFourHours})
	g.Settle()
	if len(g.State().Autonomy) != 2 {
		t.Fatalf("a mode ended while its run goes on: %+v", g.State().Autonomy)
	}
	f.setRun("block-1", RunRef{})
	g.Settle()
	if len(g.State().Autonomy) != 0 {
		t.Fatalf("the modes of a run that ended stay: %+v", g.State().Autonomy)
	}
	if len(f.lastSaved()) != 0 {
		t.Fatalf("an always mode of an ended run is kept for a restart: %+v", f.lastSaved())
	}
	f.setRun("block-1", otherRun)
	if g.Autonomous("block-1", runSession, otherRun) || g.Autonomous("block-1", "99999999-aaaa", otherRun) {
		t.Fatal("a new run inherited the modes of the one before")
	}
}

// Another run in the terminal (the agent started `claude --continue`, or the developer did) never has what the developer
// chose for the one before, even for the same session id.
func TestGateModeIsBoundToItsRun(t *testing.T) {
	f := makeGateFixture(t)
	g := f.gate()
	f.setRun("block-1", testRun)
	g.SetMode(GateModeRequest{Run: testRun, BlockId: "block-1", SessionId: runSession, Mode: ModeAlways})
	if !g.Autonomous("block-1", runSession, testRun) {
		t.Fatal("the run does not have its own mode")
	}
	if g.Autonomous("block-1", runSession, otherRun) {
		t.Fatal("another run of the same session was approved")
	}
	if g.Autonomous("block-1", runSession, RunRef{}) {
		t.Fatal("a request from a run MoltenTerm cannot tell was approved")
	}
	if len(g.State().Autonomy) != 0 {
		t.Fatalf("the mode of another run is still shown: %+v", g.State().Autonomy)
	}
	if len(f.lastSaved()) != 0 {
		t.Fatalf("the mode of another run is kept for a restart: %+v", f.lastSaved())
	}
}

// The same run seen again after a start time rounded another way is the same run; another process is not.
func TestSameRunToleratesRoundingOnly(t *testing.T) {
	a := RunRef{Pid: 10, StartMs: 5000}
	for name, c := range map[string]struct {
		b    RunRef
		want bool
	}{
		"the same":           {RunRef{Pid: 10, StartMs: 5000}, true},
		"rounded":            {RunRef{Pid: 10, StartMs: 5600}, true},
		"a reused pid":       {RunRef{Pid: 10, StartMs: 90000}, false},
		"another pid":        {RunRef{Pid: 11, StartMs: 5000}, false},
		"no start":           {RunRef{Pid: 10}, true},
		"no process":         {RunRef{}, false},
		"before the rounded": {RunRef{Pid: 10, StartMs: 4200}, true},
	} {
		if got := SameRun(a, c.b); got != c.want {
			t.Errorf("%s: %v, want %v", name, got, c.want)
		}
	}
	if SameRun(RunRef{}, RunRef{}) {
		t.Error("two runs nobody knows are the same")
	}
}

// "Always" survives a restart of MoltenTerm while the same run goes on: the new gate has not seen the run yet (its
// process is not found), which is not the run's end; and it ends once another run is in the terminal.
func TestGateAlwaysSurvivesARestartWhileTheSameRunGoesOn(t *testing.T) {
	first := makeGateFixture(t)
	g := first.gate()
	g.SetMode(GateModeRequest{Run: testRun, BlockId: "block-1", SessionId: runSession, Mode: ModeAlways, Agent: "claude"})
	kept := first.lastSaved()
	if len(kept) != 1 || kept[0].RunPid != testRun.Pid || kept[0].RunStart != testRun.StartMs {
		t.Fatalf("what is kept does not name the run: %+v", kept)
	}

	f := makeGateFixture(t)
	f.loaded = kept
	restarted := f.gate()
	restarted.Settle()
	if len(restarted.State().Autonomy) != 1 {
		t.Fatalf("the restart lost the mode before it saw the run: %+v", restarted.State().Autonomy)
	}
	f.setRun("block-1", testRun)
	restarted.Settle()
	if !restarted.Autonomous("block-1", runSession, testRun) {
		t.Fatal("the run that goes on lost its mode in the restart")
	}
	f.setRun("block-1", otherRun)
	restarted.Settle()
	if len(restarted.State().Autonomy) != 0 || restarted.Autonomous("block-1", runSession, otherRun) {
		t.Fatalf("a new run of the session took the mode after a restart: %+v", restarted.State().Autonomy)
	}
	if len(f.lastSaved()) != 0 {
		t.Fatalf("the ended mode is kept: %+v", f.lastSaved())
	}
}

// A run that ended while MoltenTerm was off: the first run seen in the terminal is another one.
func TestGateAlwaysOfARunThatEndedDuringARestartEndsWithTheNextRun(t *testing.T) {
	f := makeGateFixture(t)
	f.loaded = []Autonomy{{
		BlockId: "block-1", SessionId: runSession, Mode: ModeAlways, Since: f.env().Now().Add(-time.Hour).UnixMilli(),
		RunPid: testRun.Pid, RunStart: testRun.StartMs,
	}}
	g := f.gate()
	f.setRun("block-1", otherRun)
	g.Settle()
	if len(g.State().Autonomy) != 0 || g.Autonomous("block-1", runSession, otherRun) {
		t.Fatal("a mode of a run MoltenTerm never saw carried to the next run")
	}
}

func TestGateModeNeedsAKnownRun(t *testing.T) {
	f := makeGateFixture(t)
	g := f.gate()
	for _, req := range []GateModeRequest{
		{BlockId: "block-1", SessionId: runSession, Mode: ModeAlways},
		{BlockId: "block-1", SessionId: runSession, Mode: ModeFor, Period: PeriodHour},
		{Run: RunRef{StartMs: 5}, BlockId: "block-1", SessionId: runSession, Mode: ModeAlways},
	} {
		if got := g.SetMode(req); got.Status != ModeInvalid || got.Autonomy != nil {
			t.Errorf("%+v: %+v", req, got)
		}
	}
	if len(g.State().Autonomy) != 0 {
		t.Fatal("a mode with no run was kept")
	}
}

// What is cut in the window is never allowed there: Allow is refused, the request stays for the developer's other
// answers, and a mode turned on meanwhile leaves it for the terminal.
func TestGateAllowIsRefusedForAClippedRequest(t *testing.T) {
	f := makeGateFixture(t)
	g := f.gate()
	req := holdRequest("block-1", "ls")
	req.ToolInput = map[string]any{"content": strings.Repeat("x", maxShownText+1)}
	req.ToolName = "Write"
	id := g.Open(HoldRequest{Req: req, Hold: 2 * time.Minute})
	if id == "" {
		t.Fatal("the request was not held")
	}
	if shown := requestsOf(g, "block-1"); len(shown) != 1 || !shown[0].Clipped {
		t.Fatalf("shown %+v", shown)
	}
	if got := g.Answer(GateAnswer{Id: id, BlockId: "block-1", Decision: GateAllow}); got.Status != GateInvalid {
		t.Fatalf("an allow of a cut request: %+v", got)
	}
	if len(requestsOf(g, "block-1")) != 1 {
		t.Fatal("the refused allow ended the request")
	}
	g.SetMode(GateModeRequest{Run: testRun, BlockId: "block-1", SessionId: req.SessionId, Mode: ModeFor, Period: PeriodHour})
	if len(f.approved) != 0 {
		t.Fatalf("a mode allowed a request cut in the window: %+v", f.approved)
	}
	if len(requestsOf(g, "block-1")) != 1 {
		t.Fatal("the mode took the request away")
	}
	if got := g.Answer(GateAnswer{Id: id, BlockId: "block-1", Decision: GateDeny}); got.Status != GateAnswered {
		t.Fatalf("deny of a cut request: %+v", got)
	}
	if a := g.Wait(context.Background(), id, "block-1"); a.Decision != PermissionDeny {
		t.Fatalf("the hook got %+v", a)
	}

	second := g.Open(HoldRequest{Req: req, Hold: 2 * time.Minute})
	if got := g.Answer(GateAnswer{Id: second, BlockId: "block-1", Decision: GateTerminal}); got.Status != GateAnswered {
		t.Fatalf("terminal for a cut request: %+v", got)
	}
}

// The file of the "always" sessions is written outside the gate's lock: a slow disk does not stop the windows or the
// hooks, and the last change is the one kept.
func TestGateSavesOutsideItsLockAndInOrder(t *testing.T) {
	f := makeGateFixture(t)
	f.saveGate, f.saveStarted = make(chan struct{}), make(chan struct{}, 8)
	g := f.gate()
	done := make(chan GateModeResult, 1)
	go func() {
		done <- g.SetMode(GateModeRequest{Run: testRun, BlockId: "block-1", SessionId: runSession, Mode: ModeAlways})
	}()
	select {
	case <-f.saveStarted:
	case <-time.After(gateDeadline):
		t.Fatal("the mode was not saved")
	}
	read := make(chan struct{})
	go func() {
		g.State()
		g.Autonomous("block-1", runSession, testRun)
		g.Watching("block-1")
		close(read)
	}()
	select {
	case <-read:
	case <-time.After(gateDeadline):
		t.Fatal("the gate is held while the file is written")
	}
	stopped := make(chan GateModeResult, 1)
	go func() {
		stopped <- g.SetMode(GateModeRequest{BlockId: "block-1", SessionId: runSession, Mode: ModeAsk})
	}()
	close(f.saveGate)
	<-done
	<-stopped
	if got := f.lastSaved(); len(got) != 0 {
		t.Fatalf("an older save came after the newer one: %+v", got)
	}
}

// A timer that goes off before the wall clock reaches the end (the clock was set back) does not end the period: the mode
// waits for what remains, and the windows are told.
func TestGateExpiryFiringEarlyWaitsForTheRest(t *testing.T) {
	f := makeGateFixture(t)
	g := f.gate()
	g.SetMode(GateModeRequest{Run: testRun, BlockId: "block-1", SessionId: runSession, Mode: ModeFor, Period: PeriodHour})
	before := g.State().Version
	f.advance(10 * time.Minute)
	f.fire(0)
	f.until("the expiry to be rescheduled", func() bool { return f.timerCount() == 2 })
	f.until("the windows to be told", func() bool { return g.State().Version > before })
	if d := f.timerAt(1).d; d != 50*time.Minute {
		t.Fatalf("the new wait is %v, want what remains", d)
	}
	if !g.Autonomous("block-1", runSession, testRun) {
		t.Fatal("an early timer ended the period")
	}
	f.advance(50 * time.Minute)
	f.fire(1)
	f.until("the mode to end", func() bool { return len(g.State().Autonomy) == 0 })
}

// The hook asks for a held request in one call and awaits it in a second.
func TestGateOpenThenWaitGivesTheDevelopersAnswer(t *testing.T) {
	f := makeGateFixture(t)
	g := f.gate()
	id := g.Open(HoldRequest{Req: holdRequest("block-1", "go test ./..."), Hold: 2 * time.Minute})
	if id == "" {
		t.Fatal("the request was not opened")
	}
	if shown := requestsOf(g, "block-1"); len(shown) != 1 || shown[0].Id != id || shown[0].State != RequestHeld {
		t.Fatalf("shown %+v", shown)
	}
	out := make(chan PermissionAnswer, 1)
	go func() { out <- g.Wait(context.Background(), id, "block-1") }()
	g.Answer(GateAnswer{Id: id, BlockId: "block-1", Decision: GateAllow})
	if a := recvAnswer(t, out); a.Decision != PermissionAllow {
		t.Fatalf("the hook got %+v", a)
	}
}

// The developer may answer before the hook's second call arrives: the answer waits for it, once.
func TestGateAnswerBeforeTheHookWaitsIsKept(t *testing.T) {
	f := makeGateFixture(t)
	g := f.gate()
	id := g.Open(HoldRequest{Req: holdRequest("block-1", "rm -rf build"), Hold: 2 * time.Minute})
	g.Answer(GateAnswer{Id: id, BlockId: "block-1", Decision: GateDeny})
	if a := g.Wait(context.Background(), "nope", "block-1"); a.Decision != "" {
		t.Fatalf("an unknown request answered %+v", a)
	}
	if a := g.Wait(context.Background(), id, "block-2"); a.Decision != "" {
		t.Fatalf("another terminal got %+v", a)
	}
	if a := g.Wait(context.Background(), id, "block-1"); a.Decision != PermissionDeny || a.Message == "" {
		t.Fatalf("the hook got %+v", a)
	}
	if a := g.Wait(context.Background(), id, "block-1"); a.Decision != "" {
		t.Fatalf("an answer was given twice: %+v", a)
	}
}

// A request that went back to the agent's prompt before the hook waited (its deadline, a newer request) answers empty.
func TestGateWaitAfterTheDeadlineAnswersNothing(t *testing.T) {
	f := makeGateFixture(t)
	g := f.gate()
	id := g.Open(HoldRequest{Req: holdRequest("block-1", "ls"), Hold: 2 * time.Minute})
	f.fire(0)
	f.until("the request to go", func() bool { return len(requestsOf(g, "block-1")) == 0 })
	if a := g.Wait(context.Background(), id, "block-1"); a.Decision != "" {
		t.Fatalf("the hook got %+v", a)
	}
	replaced := g.Open(HoldRequest{Req: holdRequest("block-2", "ls"), Hold: 2 * time.Minute})
	g.Open(HoldRequest{Req: holdRequest("block-2", "pwd"), Hold: 2 * time.Minute})
	if a := g.Wait(context.Background(), replaced, "block-2"); a.Decision != "" {
		t.Fatalf("a replaced request answered %+v", a)
	}
}

func TestGateOpenNeedsTimeToBeAnswered(t *testing.T) {
	f := makeGateFixture(t)
	g := f.gate()
	if id := g.Open(HoldRequest{Req: holdRequest("block-1", "ls"), Hold: minHold - time.Millisecond}); id != "" {
		t.Fatalf("a request with no time was opened as %q", id)
	}
	if len(g.State().Requests) != 0 {
		t.Fatal("it is shown")
	}
}
