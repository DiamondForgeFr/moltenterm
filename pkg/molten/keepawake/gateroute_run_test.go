// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package keepawake

import (
	"context"
	"os"
	"os/exec"
	"runtime"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
	"github.com/wavetermdev/waveterm/pkg/molten/proctree"
)

func (g *gateService) clock() time.Time {
	return g.gateFixture.env().Now()
}

// The review of #2474 (PR #2479), wavesrv's side: what an autonomous mode is bound to, how a request is held, and what a
// window may set.

// answerNow is the hook's first call, which never waits for the developer: it fails the test when it does.
func (g *gateService) answerNow(req PermissionRequest) PermissionAnswer {
	g.t.Helper()
	out := make(chan PermissionAnswer, 1)
	go func() { out <- g.s.permission(context.Background(), req) }()
	select {
	case a := <-out:
		return a
	case <-time.After(gateDeadline):
		g.t.Fatal("the first call waited for the developer")
	}
	return PermissionAnswer{}
}

// A session set to approve in one run is not approved in the next: `claude --continue`, `--resume` or `--session-id`
// give a new process the same session id, and the developer chose for the first.
func TestPermissionAutonomyIsNotInheritedByANewRunOfTheSession(t *testing.T) {
	g := makeGateService(t)
	if result := g.autonomous(gateSession, ModeAlways, ""); result.Status != ModeSet || result.Autonomy.RunPid != gateAgentPid || result.Autonomy.RunStart != gateAgentStart {
		t.Fatalf("mode %+v", result)
	}
	if a := g.answerNow(hookRequest("ls")); a.Decision != PermissionAllow {
		t.Fatalf("the run does not have its own mode: %+v", a)
	}
	g.runs["block-1"] = molten.AgentRunInfo{
		BlockId: "block-1", Agent: molten.AgentIdClaude, Running: true, Pid: gateOtherAgent, PidStartMs: gateAgentStart + 9100, SessionId: gateSession,
	}
	next := hookRequest("ls")
	next.Pid = gateOtherHook
	if a := g.answerNow(next); a.Decision != "" {
		t.Fatalf("a new run of the same session was approved: %+v", a)
	}
	if len(g.s.gate.State().Autonomy) != 0 || len(g.lastSaved()) != 0 {
		t.Fatalf("the mode of the run before stays: %+v, kept %+v", g.s.gate.State().Autonomy, g.lastSaved())
	}
}

// The run that ends takes its modes with it, as soon as the agents' states say so, not when a request comes.
func TestPermissionAutonomyEndsWhenTheRunStops(t *testing.T) {
	g := makeGateService(t)
	g.autonomous(gateSession, ModeAlways, "")
	g.s.gate.Settle()
	if len(g.s.gate.State().Autonomy) != 1 {
		t.Fatalf("a mode ended while its run goes on: %+v", g.s.gate.State().Autonomy)
	}
	delete(g.runs, "block-1")
	g.s.gate.Settle()
	if len(g.s.gate.State().Autonomy) != 0 || len(g.lastSaved()) != 0 {
		t.Fatalf("the mode of a run that stopped stays: %+v, kept %+v", g.s.gate.State().Autonomy, g.lastSaved())
	}
	g.runs["block-1"] = gateRun(gateSession)
	if a := g.answerNow(hookRequest("ls")); a.Decision != "" {
		t.Fatalf("the same process seen again after its end was approved: %+v", a)
	}
}

// The request must come from the run's own hook: one a nested run of the agent sent (the agent ran `claude -p` through
// its Bash tool) has the terminal and the session, not the developer's choice.
func TestPermissionAutonomyNeedsTheRunsOwnHook(t *testing.T) {
	g := makeGateService(t)
	g.autonomous(gateSession, ModeAlways, "")
	for name, pid := range map[string]int32{"a nested run's hook": gateOtherHook, "no process": 0, "a process nobody knows": 999999, "the shell": gateShellPid} {
		req := hookRequest("ls")
		req.Pid = pid
		if a := g.answerNow(req); a.Decision != "" {
			t.Errorf("%s was approved: %+v", name, a)
		}
	}
	if a := g.answerNow(hookRequest("ls")); a.Decision != PermissionAllow {
		t.Fatalf("the run's own hook: %+v", a)
	}
	g.s.procs = func() *proctree.Table { return nil }
	if a := g.answerNow(hookRequest("ls")); a.Decision != "" {
		t.Fatalf("approved with no process table: %+v", a)
	}
}

// The session the run reports now decides: a request of another session, or one when the agent has moved to a session
// the mode was not set for, asks.
func TestPermissionAutonomyFollowsTheSessionTheRunReports(t *testing.T) {
	g := makeGateService(t)
	g.autonomous(gateSession, ModeAlways, "")
	run := g.runs["block-1"]
	run.SessionId = "11111111-2222-3333-4444-666666666666"
	g.runs["block-1"] = run
	if a := g.answerNow(hookRequest("ls")); a.Decision != "" {
		t.Fatalf("approved after the agent moved to another session: %+v", a)
	}
	run.SessionId = ""
	g.runs["block-1"] = run
	if a := g.answerNow(hookRequest("ls")); a.Decision != PermissionAllow {
		t.Fatalf("a run that has not reported its session yet (a restart) lost its mode: %+v", a)
	}
}

// A window names the session; wavesrv sets the mode only for the one the run reports, and for that run.
func TestSetAutonomyChecksTheSessionAndTheRun(t *testing.T) {
	g := makeGateService(t)
	other := "11111111-2222-3333-4444-666666666666"
	if got := g.autonomous(other, ModeAlways, ""); got.Status != ModeUnavailable || got.ReasonText == nil || got.ReasonText.Code != "keepawake.gate.othersession" {
		t.Fatalf("another session's id: %+v", got)
	}
	if len(g.s.gate.State().Autonomy) != 0 {
		t.Fatal("a mode was kept for a session the run does not run")
	}

	run := g.runs["block-1"]
	run.SessionId = ""
	g.runs["block-1"] = run
	if got := g.autonomous(gateSession, ModeAlways, ""); got.Status != ModeUnavailable || got.ReasonText == nil || got.ReasonText.Code != "keepawake.gate.nosession" {
		t.Fatalf("a run that reported no session: %+v", got)
	}

	run.SessionId, run.Pid = gateSession, 0
	g.runs["block-1"] = run
	if got := g.autonomous(gateSession, ModeAlways, ""); got.Status != ModeUnavailable || got.ReasonText == nil || got.ReasonText.Code != "keepawake.gate.norun" {
		t.Fatalf("a run MoltenTerm cannot tell apart: %+v", got)
	}

	g.runs["block-1"] = gateRun(gateSession)
	got := g.autonomous("11111111-2222-3333-4444-555555555555", ModeFor, PeriodHour)
	if got.Status != ModeSet || got.Autonomy == nil || got.Autonomy.RunPid != gateAgentPid {
		t.Fatalf("the run's own session: %+v", got)
	}
	if got := g.autonomous(other, ModeAsk, ""); got.Status != ModeSet {
		t.Fatalf("stopping is always possible: %+v", got)
	}
}

// The hook's first call answers at once whether or not the request is held: a held one says so, with how long, and the
// hook awaits it in a second call that only a terminal of that block may make.
func TestPermissionFirstCallNeverWaitsForTheDeveloper(t *testing.T) {
	g := makeGateService(t)
	g.s.watch(context.Background(), "block-1")
	a := g.answerNow(hookRequest("go test ./..."))
	if a.Decision != "" || a.Wait == "" || a.WaitMs != GateGrace.Milliseconds() {
		t.Fatalf("the first call answered %+v", a)
	}
	shown := requestsOf(g.s.gate, "block-1")
	if len(shown) != 1 || shown[0].Id != a.Wait || shown[0].State != RequestHeld {
		t.Fatalf("shown %+v", shown)
	}
	if got := g.answerNow(hookRequest("rm -rf /tmp/x")); got.Wait == "" || got.Wait == a.Wait {
		t.Fatalf("a newer request got %+v", got)
	}

	notHeld := hookRequest("ls")
	notHeld.BlockId = "block-2"
	g.setBlock("block-2", BlockInfo{WorkspaceId: "ws-a"})
	if got := g.answerNow(notHeld); got.Wait != "" || got.Decision != "" {
		t.Fatalf("a request that is not held said it waits: %+v", got)
	}
}

// The second call: only the terminal that asked awaits the request, and it gets the developer's answer.
func TestPermissionWaitCommandAwaitsOnlyForItsOwnTerminal(t *testing.T) {
	g := makeGateService(t)
	g.s.watch(context.Background(), "block-1")
	link := &routeLink{s: g.s}
	caller := localroute.Caller{IsLocalTerminal: true, BlockId: "block-1"}
	out, err := link.handle(context.Background(), PermissionCommand, caller, hookRequest("go test ./..."))
	first, _ := out.(PermissionAnswer)
	if err != nil || first.Wait == "" {
		t.Fatalf("first call %+v %v", out, err)
	}
	wait := PermissionWait{BlockId: "block-1", Id: first.Wait}
	for name, c := range map[string]localroute.Caller{
		"another terminal": {IsLocalTerminal: true, BlockId: "block-2"},
		"no terminal":      {IsLocalTerminal: true},
	} {
		got, err := link.handle(context.Background(), PermissionWaitCommand, c, wait)
		if err != nil || got.(PermissionAnswer).Decision != "" {
			t.Errorf("%s awaited: %+v %v", name, got, err)
		}
	}
	if len(requestsOf(g.s.gate, "block-1")) != 1 {
		t.Fatal("a wait of another terminal took the request")
	}
	result := make(chan any, 1)
	go func() {
		got, _ := link.handle(context.Background(), PermissionWaitCommand, caller, wait)
		result <- got
	}()
	g.s.gate.Answer(GateAnswer{Id: first.Wait, BlockId: "block-1", Decision: GateAllow})
	select {
	case got := <-result:
		if got.(PermissionAnswer).Decision != PermissionAllow {
			t.Fatalf("the second call got %+v", got)
		}
	case <-time.After(gateDeadline):
		t.Fatal("the second call did not end")
	}
}

// The time already spent counts in the hold: the hook's budget is for the whole of its call.
func TestPermissionHoldCountsTheTimeSpentBeforeIt(t *testing.T) {
	g := makeGateService(t)
	g.s.watch(context.Background(), "block-1")
	req := hookRequest("go test ./...")
	req.Arrived = g.clock().Add(-30 * time.Second)
	a := g.answerNow(req)
	if a.Wait == "" || a.WaitMs != (GateGrace-30*time.Second).Milliseconds() {
		t.Fatalf("held for %+v", a)
	}
	if d := g.timerAt(0).d; d != GateGrace-30*time.Second {
		t.Fatalf("the timer is %v", d)
	}
	shown := requestsOf(g.s.gate, "block-1")
	if len(shown) != 1 || shown[0].Deadline != g.clock().Add(GateGrace-30*time.Second).UnixMilli() {
		t.Fatalf("shown %+v", shown)
	}

	late := hookRequest("ls")
	late.Arrived = g.clock().Add(-GateGrace + time.Second)
	if got := g.answerNow(late); got.Wait != "" {
		t.Fatalf("a request that has no time left was held: %+v", got)
	}
}

// The hook's wait command is the terminal's, like its request.
func TestPermissionWaitRouteIsForTerminalsOnly(t *testing.T) {
	e := routetest.Make(t)
	g := makeGateService(t)
	hooks, err := localroute.MakeLink(e.Router, (&routeLink{s: g.s}).route())
	if err != nil {
		t.Fatal(err)
	}
	routetest.MustRefuseWith(t, hooks, append([]routetest.From{e.Window(), e.Electron()}, e.Forged()...), PermissionWaitCommand, map[string]any{}, "from a local MoltenTerm terminal")
	out, errStr := routetest.Ask(t, hooks, e.Terminal(), PermissionWaitCommand, map[string]any{"blockid": "block-1", "id": "nothing"})
	if errStr != "" || out.(map[string]any)["decision"] != nil {
		t.Fatalf("a terminal's wait: %v %q", out, errStr)
	}
}

// The walk reads the real process table the same way: a process under the run is the run's, the test's own process is not.
func TestFromTrackedRunOnTheRealProcessTable(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skip("the process table is read on macOS and Linux")
	}
	run := exec.Command("sh", "-c", "sleep 600; true")
	if err := run.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		run.Process.Kill()
		run.Wait()
	})
	s := &service{procs: readProcs}
	var table *proctree.Table
	var child int32
	deadline := time.Now().Add(gateDeadline)
	for child == 0 {
		if time.Now().After(deadline) {
			t.Fatal("the process under the run was not found")
		}
		table = readProcs()
		for _, p := range table.Foreground(int32(run.Process.Pid)) {
			if p.Pid != int32(run.Process.Pid) && p.Name == "sleep" {
				child = p.Pid
			}
		}
		if child == 0 {
			time.Sleep(10 * time.Millisecond)
		}
	}
	t.Cleanup(func() {
		if p, err := os.FindProcess(int(child)); err == nil {
			p.Kill()
		}
	})
	ref := RunRef{Pid: int32(run.Process.Pid), StartMs: table.Get(int32(run.Process.Pid)).StartMs}
	if !s.fromTrackedRun(ref, child) {
		t.Fatal("a process under the run is not the run's")
	}
	if s.fromTrackedRun(ref, int32(os.Getpid())) {
		t.Fatal("a process that is not under the run is the run's")
	}
	if s.fromTrackedRun(RunRef{Pid: ref.Pid, StartMs: ref.StartMs + 90_000}, child) {
		t.Fatal("a reused pid is the run")
	}
}

// A hook that does not send its process, or one from a terminal of a program that is not the run's, is never autonomous.
func TestFromTrackedRunWalksTheHooksAncestry(t *testing.T) {
	g := makeGateService(t)
	run := RunRef{Pid: gateAgentPid, StartMs: gateAgentStart}
	for name, c := range map[string]struct {
		run  RunRef
		pid  int32
		want bool
	}{
		"the hook of the run":                {run, gateHookPid, true},
		"the sh of the run":                  {run, gateHookShPid, true},
		"the run itself":                     {run, gateAgentPid, true},
		"a nested run's hook":                {run, gateOtherHook, false},
		"the shell above the run":            {run, gateShellPid, false},
		"no hook process":                    {run, 0, false},
		"an unknown process":                 {run, 123456, false},
		"a run that is not that process":     {RunRef{Pid: gateAgentPid, StartMs: gateAgentStart + 90_000}, gateHookPid, false},
		"a run MoltenTerm cannot tell apart": {RunRef{}, gateHookPid, false},
	} {
		if got := g.s.fromTrackedRun(c.run, c.pid); got != c.want {
			t.Errorf("%s: %v, want %v", name, got, c.want)
		}
	}
}
