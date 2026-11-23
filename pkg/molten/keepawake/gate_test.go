// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package keepawake

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// gateDeadline only bounds a failing run.
const gateDeadline = time.Minute

// testRun is the run of the agent the tests set a mode in; otherRun is another run of it (a new process).
var (
	testRun  = RunRef{Pid: 4242, StartMs: 1_700_000_000_000}
	otherRun = RunRef{Pid: 4343, StartMs: 1_700_000_900_000}
)

type fakeGateTimer struct {
	d       time.Duration
	ch      chan time.Time
	stopped bool
}

// gateFixture is the gate's outside: a clock the test moves, timers it fires itself, and what the gate published.
type gateFixture struct {
	t         *testing.T
	lock      sync.Mutex
	now       time.Time
	ids       int
	timers    []*fakeGateTimer
	published chan int64
	movedAt   map[string]bool
	runs      map[string]RunRef
	saved     [][]Autonomy
	approved  []GateRequest
	loaded    []Autonomy
	// saveGate, when set, is waited on by every save (a save that blocks); saveStarted says a save began.
	saveGate    chan struct{}
	saveStarted chan struct{}
}

func makeGateFixture(t *testing.T) *gateFixture {
	return &gateFixture{
		t: t, now: time.Date(2026, 11, 23, 10, 0, 0, 0, time.Local), published: make(chan int64, 256), movedAt: map[string]bool{},
		runs: map[string]RunRef{},
	}
}

// setRun says which run of the agent is in the terminal; a zero run says none.
func (f *gateFixture) setRun(blockId string, run RunRef) {
	f.lock.Lock()
	defer f.lock.Unlock()
	if !run.Known() {
		delete(f.runs, blockId)
		return
	}
	f.runs[blockId] = run
}

func (f *gateFixture) env() GateEnv {
	return GateEnv{
		Now: func() time.Time {
			f.lock.Lock()
			defer f.lock.Unlock()
			return f.now
		},
		NewId: func() string {
			f.lock.Lock()
			defer f.lock.Unlock()
			f.ids++
			return fmt.Sprintf("req-%d", f.ids)
		},
		Timer: func(d time.Duration) (<-chan time.Time, func()) {
			f.lock.Lock()
			defer f.lock.Unlock()
			timer := &fakeGateTimer{d: d, ch: make(chan time.Time, 1)}
			f.timers = append(f.timers, timer)
			return timer.ch, func() {
				f.lock.Lock()
				defer f.lock.Unlock()
				timer.stopped = true
			}
		},
		Publish: func(version int64) {
			select {
			case f.published <- version:
			default:
			}
		},
		Moved: func(blockId string, at int64) bool {
			f.lock.Lock()
			defer f.lock.Unlock()
			return f.movedAt[blockId]
		},
		RunOf: func(blockId string) (RunRef, bool) {
			f.lock.Lock()
			defer f.lock.Unlock()
			run, ok := f.runs[blockId]
			return run, ok
		},
		LoadAlways: func() []Autonomy { return f.loaded },
		SaveAlways: func(list []Autonomy) {
			if f.saveGate != nil {
				select {
				case f.saveStarted <- struct{}{}:
				default:
				}
				<-f.saveGate
			}
			f.lock.Lock()
			defer f.lock.Unlock()
			f.saved = append(f.saved, list)
		},
		Approved: func(req GateRequest) {
			f.lock.Lock()
			defer f.lock.Unlock()
			f.approved = append(f.approved, req)
		},
	}
}

func (f *gateFixture) gate() *Gate {
	return MakeGate(f.env())
}

func (f *gateFixture) advance(d time.Duration) {
	f.lock.Lock()
	defer f.lock.Unlock()
	f.now = f.now.Add(d)
}

func (f *gateFixture) timerAt(i int) *fakeGateTimer {
	f.lock.Lock()
	defer f.lock.Unlock()
	if i >= len(f.timers) {
		f.t.Fatalf("no timer %d, %d were made", i, len(f.timers))
	}
	return f.timers[i]
}

// fire makes timer i go off, as its time came.
func (f *gateFixture) fire(i int) {
	f.t.Helper()
	timer := f.timerAt(i)
	timer.ch <- f.env().Now()
}

// until waits, on what the gate publishes, for a condition: it only bounds a failing run.
func (f *gateFixture) until(what string, cond func() bool) {
	f.t.Helper()
	deadline := time.After(gateDeadline)
	for !cond() {
		select {
		case <-f.published:
		case <-deadline:
			f.t.Fatalf("waited for %s", what)
		}
	}
}

func (f *gateFixture) setMoved(blockId string, moved bool) {
	f.lock.Lock()
	defer f.lock.Unlock()
	f.movedAt[blockId] = moved
}

func holdRequest(blockId string, command string) PermissionRequest {
	return PermissionRequest{
		BlockId: blockId, Agent: "claude", SessionId: "11111111-2222-3333-4444-555555555555", Cwd: "/work/app",
		ToolName: "Bash", ToolInput: map[string]any{"command": command}, FromBlock: true,
	}
}

// holdAsync starts a hold and returns what it answers once the request shows in the gate's state.
func (f *gateFixture) holdAsync(g *Gate, req PermissionRequest, hold time.Duration) (<-chan PermissionAnswer, GateRequest) {
	f.t.Helper()
	out := make(chan PermissionAnswer, 1)
	go func() { out <- g.Hold(context.Background(), HoldRequest{Req: req, Hold: hold}) }()
	var shown GateRequest
	f.until("the request to be held", func() bool {
		for _, r := range g.State().Requests {
			if r.BlockId == req.BlockId && r.State == RequestHeld && r.ToolInput["command"] == req.ToolInput["command"] {
				shown = r
				return true
			}
		}
		return false
	})
	return out, shown
}

func recvAnswer(t *testing.T, ch <-chan PermissionAnswer) PermissionAnswer {
	t.Helper()
	select {
	case a := <-ch:
		return a
	case <-time.After(gateDeadline):
		t.Fatal("the hold did not end")
	}
	return PermissionAnswer{}
}

func requestsOf(g *Gate, blockId string) []GateRequest {
	var rtn []GateRequest
	for _, r := range g.State().Requests {
		if r.BlockId == blockId {
			rtn = append(rtn, r)
		}
	}
	return rtn
}

// #2474: Allow answers the hook with an allow, and the request is over.
func TestGateAllowAnswersTheHook(t *testing.T) {
	f := makeGateFixture(t)
	g := f.gate()
	out, shown := f.holdAsync(g, holdRequest("block-1", "go test ./..."), 2*time.Minute)
	want := f.env().Now().Add(2 * time.Minute).UnixMilli()
	if shown.Id == "" || shown.Deadline != want || shown.At != f.env().Now().UnixMilli() || shown.Cwd != "/work/app" {
		t.Fatalf("shown %+v, deadline want %d", shown, want)
	}
	if shown.ToolInput["command"] != "go test ./..." || shown.Agent != "claude" || shown.SessionId == "" {
		t.Fatalf("the request does not carry what it asks: %+v", shown)
	}
	if got := g.Answer(GateAnswer{Id: shown.Id, BlockId: "block-1", Decision: GateAllow}); got.Status != GateAnswered {
		t.Fatalf("answer %+v", got)
	}
	if a := recvAnswer(t, out); a.Decision != PermissionAllow || a.Message != "" {
		t.Fatalf("the hook got %+v", a)
	}
	if len(requestsOf(g, "block-1")) != 0 {
		t.Fatal("the answered request is still shown")
	}
	if got := g.Answer(GateAnswer{Id: shown.Id, BlockId: "block-1", Decision: GateAllow}); got.Status != GateGone {
		t.Fatalf("an answer is replayed: %+v", got)
	}
	if !f.timerAt(0).stopped {
		t.Fatal("the grace timer is left running")
	}
}

func TestGateDenyAnswersTheHookWithTheDevelopersWords(t *testing.T) {
	f := makeGateFixture(t)
	g := f.gate()
	out, shown := f.holdAsync(g, holdRequest("block-1", "rm -rf build"), 2*time.Minute)
	g.Answer(GateAnswer{Id: shown.Id, BlockId: "block-1", Decision: GateDeny})
	a := recvAnswer(t, out)
	if a.Decision != PermissionDeny || a.Message != "The developer denied this in MoltenTerm." {
		t.Fatalf("the hook got %+v", a)
	}
}

// "Answer in the terminal" releases the request to the agent's own prompt: the hook prints nothing.
func TestGateTerminalReleasesTheRequest(t *testing.T) {
	f := makeGateFixture(t)
	g := f.gate()
	out, shown := f.holdAsync(g, holdRequest("block-1", "ls"), 2*time.Minute)
	if got := g.Answer(GateAnswer{Id: shown.Id, BlockId: "block-1", Decision: GateTerminal}); got.Status != GateAnswered {
		t.Fatalf("answer %+v", got)
	}
	if a := recvAnswer(t, out); a.Decision != "" {
		t.Fatalf("the hook answered %+v", a)
	}
	if len(requestsOf(g, "block-1")) != 0 {
		t.Fatal("the released request is still shown")
	}
}

// Past the grace delay the request goes back to the agent's prompt, as if nobody was there.
func TestGateGraceDelayReleasesTheRequest(t *testing.T) {
	f := makeGateFixture(t)
	g := f.gate()
	out, shown := f.holdAsync(g, holdRequest("block-1", "ls"), 2*time.Minute)
	if d := f.timerAt(0).d; d != 2*time.Minute {
		t.Fatalf("the grace timer is %v", d)
	}
	f.fire(0)
	if a := recvAnswer(t, out); a.Decision != "" {
		t.Fatalf("the hook answered %+v after the grace delay", a)
	}
	f.until("the request to go", func() bool { return len(requestsOf(g, "block-1")) == 0 })
	if got := g.Answer(GateAnswer{Id: shown.Id, BlockId: "block-1", Decision: GateAllow}); got.Status != GateGone {
		t.Fatalf("a click after the grace delay answered %+v", got)
	}
}

func TestGateHookGivingUpEndsTheRequest(t *testing.T) {
	f := makeGateFixture(t)
	g := f.gate()
	ctx, cancel := context.WithCancel(context.Background())
	out := make(chan PermissionAnswer, 1)
	go func() { out <- g.Hold(ctx, HoldRequest{Req: holdRequest("block-1", "ls"), Hold: time.Minute}) }()
	f.until("the request to be held", func() bool { return len(requestsOf(g, "block-1")) == 1 })
	cancel()
	if a := recvAnswer(t, out); a.Decision != "" {
		t.Fatalf("the hook answered %+v", a)
	}
	f.until("the request to go", func() bool { return len(requestsOf(g, "block-1")) == 0 })
}

// An answer counts only for the request still held under that id, in that terminal, by a decision MoltenTerm knows.
func TestGateAnswerIsBoundToTheRequest(t *testing.T) {
	f := makeGateFixture(t)
	g := f.gate()
	out, shown := f.holdAsync(g, holdRequest("block-1", "ls"), 2*time.Minute)
	for name, a := range map[string]GateAnswer{
		"another terminal": {Id: shown.Id, BlockId: "block-2", Decision: GateAllow},
		"no terminal":      {Id: shown.Id, Decision: GateAllow},
		"another id":       {Id: "req-99", BlockId: "block-1", Decision: GateAllow},
		"no id":            {BlockId: "block-1", Decision: GateAllow},
	} {
		if got := g.Answer(a); got.Status != GateGone {
			t.Errorf("%s: %+v", name, got)
		}
	}
	for _, decision := range []string{"", "always", "ALLOW", "approve"} {
		if got := g.Answer(GateAnswer{Id: shown.Id, BlockId: "block-1", Decision: decision}); got.Status != GateInvalid {
			t.Errorf("decision %q: %+v", decision, got)
		}
	}
	if len(requestsOf(g, "block-1")) != 1 {
		t.Fatal("a refused answer ended the request")
	}
	g.Answer(GateAnswer{Id: shown.Id, BlockId: "block-1", Decision: GateAllow})
	if a := recvAnswer(t, out); a.Decision != PermissionAllow {
		t.Fatalf("the hook got %+v", a)
	}
}

// An agent asks one thing at a time: a newer request of the terminal takes the older one's place, which goes back to
// the agent's prompt. Another terminal's request is not touched.
func TestGateNewerRequestReplacesTheOlder(t *testing.T) {
	f := makeGateFixture(t)
	g := f.gate()
	older, first := f.holdAsync(g, holdRequest("block-1", "ls"), 2*time.Minute)
	other, _ := f.holdAsync(g, holdRequest("block-2", "pwd"), 2*time.Minute)
	f.advance(time.Second)
	newer, second := f.holdAsync(g, holdRequest("block-1", "whoami"), 2*time.Minute)
	if a := recvAnswer(t, older); a.Decision != "" {
		t.Fatalf("the replaced request answered %+v", a)
	}
	if got := g.Answer(GateAnswer{Id: first.Id, BlockId: "block-1", Decision: GateAllow}); got.Status != GateGone {
		t.Fatalf("the replaced request was answered: %+v", got)
	}
	g.Answer(GateAnswer{Id: second.Id, BlockId: "block-1", Decision: GateAllow})
	if a := recvAnswer(t, newer); a.Decision != PermissionAllow {
		t.Fatalf("the newer request got %+v", a)
	}
	if len(requestsOf(g, "block-2")) != 1 {
		t.Fatal("another terminal's request went")
	}
	g.Answer(GateAnswer{Id: g.State().Requests[0].Id, BlockId: "block-2", Decision: GateDeny})
	recvAnswer(t, other)
}

// Answered in the agent's own terminal: its state moves on, and the request is let go; the hook prints nothing.
func TestGateAgentGoingOnReleasesTheRequest(t *testing.T) {
	f := makeGateFixture(t)
	g := f.gate()
	out, _ := f.holdAsync(g, holdRequest("block-1", "ls"), 2*time.Minute)
	g.NoteTerminalOnly(holdRequest("block-2", "git push --force origin main"), reasonForcePush+"main")
	g.Settle()
	if len(requestsOf(g, "block-1")) != 1 || len(requestsOf(g, "block-2")) != 1 {
		t.Fatal("a request went while its agent waited")
	}
	f.setMoved("block-1", true)
	g.Settle()
	if a := recvAnswer(t, out); a.Decision != "" {
		t.Fatalf("the hook answered %+v", a)
	}
	if len(requestsOf(g, "block-1")) != 0 || len(requestsOf(g, "block-2")) != 1 {
		t.Fatalf("requests after the agent went on: %+v", g.State().Requests)
	}
	f.setMoved("block-2", true)
	g.Settle()
	if len(g.State().Requests) != 0 {
		t.Fatalf("a request of an agent that went on stays: %+v", g.State().Requests)
	}
}

// The deny list's request is shown with its reason and never held: there is nothing to answer in the companion.
func TestGateDenyListRequestIsTerminalOnly(t *testing.T) {
	f := makeGateFixture(t)
	g := f.gate()
	g.NoteTerminalOnly(holdRequest("block-1", "git push --force origin main"), reasonForcePush+"main")
	shown := requestsOf(g, "block-1")
	if len(shown) != 1 || shown[0].State != RequestTerminal || shown[0].Deadline != 0 {
		t.Fatalf("shown %+v", shown)
	}
	if shown[0].Reason != reasonForcePush+"main" || shown[0].ReasonText == nil || shown[0].ReasonText.Code != "keepawake.deny.forcepush" {
		t.Fatalf("the reason %q, code %+v", shown[0].Reason, shown[0].ReasonText)
	}
	for _, decision := range []string{GateAllow, GateDeny, GateTerminal} {
		if got := g.Answer(GateAnswer{Id: shown[0].Id, BlockId: "block-1", Decision: decision}); got.Status != GateGone {
			t.Errorf("%s of a terminal-only request: %+v", decision, got)
		}
	}
	f.advance(terminalKeep + time.Second)
	if len(g.State().Requests) != 0 {
		t.Fatal("a request nobody saw end stays for ever")
	}
}

func TestGateHoldNeedsTimeToBeAnswered(t *testing.T) {
	f := makeGateFixture(t)
	g := f.gate()
	if a := g.Hold(context.Background(), HoldRequest{Req: holdRequest("block-1", "ls"), Hold: minHold - time.Millisecond}); a.Decision != "" {
		t.Fatalf("answered %+v", a)
	}
	if len(g.State().Requests) != 0 {
		t.Fatal("a request with no time to be answered is shown")
	}
}

// A window answers for a terminal only while it says it shows that terminal's companion.
func TestGateLeaseFollowsTheWindow(t *testing.T) {
	f := makeGateFixture(t)
	g := f.gate()
	if g.Watching("block-1") {
		t.Fatal("watched with no window")
	}
	g.Watch("block-1")
	g.Watch("")
	if !g.Watching("block-1") || g.Watching("block-2") {
		t.Fatal("the lease is not the terminal's")
	}
	f.advance(WatchLease - time.Second)
	if !g.Watching("block-1") {
		t.Fatal("the lease ended early")
	}
	f.advance(2 * time.Second)
	if g.Watching("block-1") {
		t.Fatal("the lease did not end")
	}
	g.Watch("block-1")
	f.advance(WatchLease - time.Second)
	g.Watch("block-1")
	f.advance(WatchLease - time.Second)
	if !g.Watching("block-1") {
		t.Fatal("a renewed lease ended")
	}
}

func TestGateShowsLongInputCutAndKeepsTheAgentsOwn(t *testing.T) {
	f := makeGateFixture(t)
	g := f.gate()
	long := strings.Repeat("é", maxShownText+50)
	req := holdRequest("block-1", "ls")
	req.ToolInput = map[string]any{"command": "ls", "content": long, "edits": []any{map[string]any{"new_string": long}}}
	_, shown := f.holdAsync(g, req, 2*time.Minute)
	if !shown.Clipped {
		t.Fatal("a cut text is not said to be cut")
	}
	content, _ := shown.ToolInput["content"].(string)
	if n := len([]rune(content)); n != maxShownText+1 || !strings.HasSuffix(content, "…") {
		t.Fatalf("shown content has %d characters", n)
	}
	nested := shown.ToolInput["edits"].([]any)[0].(map[string]any)["new_string"].(string)
	if len([]rune(nested)) != maxShownText+1 {
		t.Fatal("a nested text is not cut")
	}
	if shown.ToolInput["command"] != "ls" {
		t.Fatalf("a short text changed: %v", shown.ToolInput["command"])
	}
	if req.ToolInput["content"] != long {
		t.Fatal("the agent's own input was cut")
	}
	short := holdRequest("block-2", "pwd")
	_, plain := f.holdAsync(g, short, 2*time.Minute)
	if plain.Clipped {
		t.Fatal("a short input is said to be cut")
	}
}

func TestGateClosedTerminalLetsGoOfItsRequestsAndModes(t *testing.T) {
	f := makeGateFixture(t)
	g := f.gate()
	g.Watch("block-1")
	out, _ := f.holdAsync(g, holdRequest("block-1", "ls"), 2*time.Minute)
	g.SetMode(GateModeRequest{Run: testRun, BlockId: "block-2", SessionId: "aaaaaaaa-1111", Mode: ModeAlways})
	g.SetMode(GateModeRequest{Run: testRun, BlockId: "block-1", SessionId: "bbbbbbbb-2222", Mode: ModeAlways})
	g.ForgetBlock("block-1")
	if a := recvAnswer(t, out); a.Decision != "" {
		t.Fatalf("the hook answered %+v", a)
	}
	if g.Watching("block-1") || g.Autonomous("block-1", "bbbbbbbb-2222", testRun) || !g.Autonomous("block-2", "aaaaaaaa-1111", testRun) {
		t.Fatal("the closed terminal's lease or mode stays, or another's went")
	}
	last := f.saved[len(f.saved)-1]
	if len(last) != 1 || last[0].BlockId != "block-2" {
		t.Fatalf("the kept sessions after the close: %+v", last)
	}
}

func TestPeriodEnds(t *testing.T) {
	at := func(h, m int) time.Time { return time.Date(2026, 11, 23, h, m, 0, 0, time.Local) }
	cases := []struct {
		period string
		now    time.Time
		want   time.Time
	}{
		{PeriodQuarter, at(10, 0), at(10, 15)},
		{PeriodHour, at(10, 0), at(11, 0)},
		{PeriodFourHours, at(10, 0), at(14, 0)},
		{PeriodTonight, at(10, 0), at(22, 0)},
		{PeriodTonight, at(20, 59), at(22, 0)},
		{PeriodTonight, at(21, 0), at(6, 0).AddDate(0, 0, 1)},
		{PeriodTonight, at(23, 30), at(6, 0).AddDate(0, 0, 1)},
		{PeriodTonight, at(2, 0), at(6, 0)},
		{PeriodTonight, at(5, 59), at(6, 0)},
		{PeriodTonight, at(6, 0), at(22, 0)},
	}
	for _, c := range cases {
		got, ok := periodEnd(c.now, c.period)
		if !ok || !got.Equal(c.want) {
			t.Errorf("%s at %s: %s, want %s", c.period, c.now.Format("15:04"), got, c.want)
		}
	}
	for _, period := range []string{"", "30m", "forever", "TONIGHT"} {
		if _, ok := periodEnd(at(10, 0), period); ok {
			t.Errorf("period %q is taken", period)
		}
	}
}

// A period of the developer's choosing ends by itself and the session asks again.
func TestGatePeriodEndsByItself(t *testing.T) {
	f := makeGateFixture(t)
	g := f.gate()
	session := "11111111-2222-3333-4444-555555555555"
	result := g.SetMode(GateModeRequest{Run: testRun, BlockId: "block-1", SessionId: session, Mode: ModeFor, Period: PeriodHour, Agent: "claude"})
	started := f.env().Now()
	if result.Status != ModeSet || result.Autonomy == nil || result.Autonomy.Until != started.Add(time.Hour).UnixMilli() || result.Autonomy.Since != started.UnixMilli() {
		t.Fatalf("result %+v", result)
	}
	if !g.Autonomous("block-1", session, testRun) || !g.Autonomous("block-1", strings.ToUpper(session), testRun) {
		t.Fatal("the session does not approve its own requests")
	}
	f.advance(time.Hour - time.Second)
	if !g.Autonomous("block-1", session, testRun) {
		t.Fatal("the period ended early")
	}
	if len(f.saved) == 0 || len(f.saved[len(f.saved)-1]) != 0 {
		t.Fatalf("a period was kept for a restart: %+v", f.saved)
	}
	f.advance(2 * time.Second)
	f.fire(0)
	f.until("the mode to end", func() bool { return len(g.State().Autonomy) == 0 })
	if g.Autonomous("block-1", session, testRun) {
		t.Fatal("the session still approves after its period")
	}
}

// The lazy check ends a period too, whatever the timer did (a computer that slept through it).
func TestGateEndedPeriodIsNotAnApproval(t *testing.T) {
	f := makeGateFixture(t)
	g := f.gate()
	session := "11111111-2222-3333-4444-555555555555"
	g.SetMode(GateModeRequest{Run: testRun, BlockId: "block-1", SessionId: session, Mode: ModeFor, Period: PeriodQuarter})
	f.advance(15 * time.Minute)
	if g.Autonomous("block-1", session, testRun) {
		t.Fatal("an ended period approved a request")
	}
	if len(g.State().Autonomy) != 0 {
		t.Fatal("an ended period is shown")
	}
}

func TestGateStopReturnsToAskAtOnce(t *testing.T) {
	f := makeGateFixture(t)
	g := f.gate()
	session := "11111111-2222-3333-4444-555555555555"
	g.SetMode(GateModeRequest{Run: testRun, BlockId: "block-1", SessionId: session, Mode: ModeAlways})
	g.SetMode(GateModeRequest{Run: testRun, BlockId: "block-1", SessionId: "99999999-aaaa", Mode: ModeFor, Period: PeriodHour})
	if result := g.SetMode(GateModeRequest{Run: testRun, BlockId: "block-1", SessionId: session, Mode: ModeAsk}); result.Status != ModeSet {
		t.Fatalf("stop %+v", result)
	}
	if g.Autonomous("block-1", session, testRun) || !g.Autonomous("block-1", "99999999-aaaa", testRun) {
		t.Fatal("stop did not end its session's mode only")
	}
	if last := f.saved[len(f.saved)-1]; len(last) != 0 {
		t.Fatalf("a stopped session is kept for a restart: %+v", last)
	}
	if result := g.SetMode(GateModeRequest{Run: testRun, BlockId: "block-1", SessionId: session, Mode: ModeAsk}); result.Status != ModeSet {
		t.Fatalf("stopping a session that asks: %+v", result)
	}
}

// The mode belongs to one terminal and one agent session: a new session, another terminal, an unknown id ask.
func TestGateModeIsNeverInherited(t *testing.T) {
	f := makeGateFixture(t)
	g := f.gate()
	g.SetMode(GateModeRequest{Run: testRun, BlockId: "block-1", SessionId: "11111111-2222-3333-4444-555555555555", Mode: ModeAlways})
	if g.Autonomous("block-1", "11111111-2222-3333-4444-666666666666", testRun) {
		t.Fatal("a new session of the terminal inherited the mode")
	}
	if g.Autonomous("block-2", "11111111-2222-3333-4444-555555555555", testRun) {
		t.Fatal("another terminal's session took the mode")
	}
	if g.Autonomous("block-1", "", testRun) || g.Autonomous("", "11111111-2222-3333-4444-555555555555", testRun) {
		t.Fatal("a request with no session or no terminal took the mode")
	}
}

func TestGateModeRefusesWhatItCannotRead(t *testing.T) {
	f := makeGateFixture(t)
	g := f.gate()
	ok := "11111111-2222-3333-4444-555555555555"
	for name, req := range map[string]GateModeRequest{
		"no terminal":       {SessionId: ok, Mode: ModeAlways},
		"no session":        {BlockId: "block-1", Mode: ModeAlways},
		"short session":     {BlockId: "block-1", SessionId: "abc", Mode: ModeAlways},
		"odd session":       {BlockId: "block-1", SessionId: "../../etc/passwd", Mode: ModeAlways},
		"a mode of its own": {BlockId: "block-1", SessionId: ok, Mode: "yolo"},
		"no mode":           {BlockId: "block-1", SessionId: ok},
		"no period":         {BlockId: "block-1", SessionId: ok, Mode: ModeFor},
		"an odd period":     {BlockId: "block-1", SessionId: ok, Mode: ModeFor, Period: "9999h"},
	} {
		if got := g.SetMode(req); got.Status != ModeInvalid || got.Autonomy != nil {
			t.Errorf("%s: %+v", name, got)
		}
	}
	if len(g.State().Autonomy) != 0 {
		t.Fatalf("a refused mode is kept: %+v", g.State().Autonomy)
	}
}

// "Always" is the one mode that survives a restart, for that session id only; a period does not.
func TestGateAlwaysSurvivesARestartForItsSessionOnly(t *testing.T) {
	f := makeGateFixture(t)
	g := f.gate()
	session := "11111111-2222-3333-4444-555555555555"
	g.SetMode(GateModeRequest{Run: testRun, BlockId: "block-1", SessionId: session, Mode: ModeAlways, Agent: "claude"})
	g.SetMode(GateModeRequest{Run: testRun, BlockId: "block-1", SessionId: "99999999-aaaa", Mode: ModeFor, Period: PeriodHour})
	g.NoteApproved("block-1", session)
	kept := f.saved[len(f.saved)-1]
	if len(kept) != 1 || kept[0].SessionId != session || kept[0].Mode != ModeAlways {
		t.Fatalf("kept %+v", kept)
	}

	again := makeGateFixture(t)
	again.loaded = kept
	restarted := again.gate()
	if !restarted.Autonomous("block-1", session, testRun) {
		t.Fatal("the session lost its mode in the restart")
	}
	if restarted.Autonomous("block-1", "99999999-aaaa", testRun) || restarted.Autonomous("block-1", "11111111-2222-3333-4444-666666666666", testRun) {
		t.Fatal("another session got the mode in the restart")
	}
	if state := restarted.State(); len(state.Autonomy) != 1 || state.Autonomy[0].Approved != 0 {
		t.Fatalf("the restarted state %+v", state.Autonomy)
	}
}

func TestGateAlwaysKeptOnlyForAWhileAndOnlyIfWellFormed(t *testing.T) {
	f := makeGateFixture(t)
	now := f.env().Now()
	f.loaded = []Autonomy{
		{BlockId: "block-1", SessionId: "11111111-2222-3333-4444-555555555555", RunPid: 4242, Mode: ModeAlways, Since: now.Add(-alwaysKeep - time.Hour).UnixMilli()},
		{BlockId: "block-2", SessionId: "11111111-2222-3333-4444-666666666666", RunPid: 4242, Mode: ModeAlways, Since: now.Add(-time.Hour).UnixMilli()},
		{BlockId: "block-3", SessionId: "11111111-2222-3333-4444-777777777777", RunPid: 4242, Mode: ModeFor, Since: now.UnixMilli(), Until: now.Add(time.Hour).UnixMilli()},
		{BlockId: "block-4", SessionId: "bad", RunPid: 4242, Mode: ModeAlways, Since: now.UnixMilli()},
		{BlockId: "", SessionId: "11111111-2222-3333-4444-888888888888", RunPid: 4242, Mode: ModeAlways, Since: now.UnixMilli()},
	}
	g := f.gate()
	state := g.State()
	if len(state.Autonomy) != 1 || state.Autonomy[0].BlockId != "block-2" {
		t.Fatalf("loaded %+v", state.Autonomy)
	}
}

// The developer turns a mode on while looking at a held request: it goes through, and counts.
func TestGateModeAllowsTheRequestHeldForItsSession(t *testing.T) {
	f := makeGateFixture(t)
	g := f.gate()
	out, shown := f.holdAsync(g, holdRequest("block-1", "go test ./..."), 2*time.Minute)
	other, _ := f.holdAsync(g, holdRequest("block-2", "ls"), 2*time.Minute)
	result := g.SetMode(GateModeRequest{Run: testRun, BlockId: "block-1", SessionId: shown.SessionId, Mode: ModeFor, Period: PeriodHour})
	if a := recvAnswer(t, out); a.Decision != PermissionAllow {
		t.Fatalf("the held request got %+v", a)
	}
	if result.Autonomy == nil || result.Autonomy.Approved != 1 {
		t.Fatalf("result %+v", result)
	}
	if len(f.approved) != 1 || f.approved[0].Id != shown.Id || f.approved[0].ToolInput["command"] != "go test ./..." {
		t.Fatalf("the approval to log: %+v", f.approved)
	}
	if len(requestsOf(g, "block-2")) != 1 {
		t.Fatal("another terminal's request was allowed")
	}
	g.Answer(GateAnswer{Id: g.State().Requests[0].Id, BlockId: "block-2", Decision: GateDeny})
	recvAnswer(t, other)
}

func TestGateCountsWhatTheModeApproves(t *testing.T) {
	f := makeGateFixture(t)
	g := f.gate()
	session := "11111111-2222-3333-4444-555555555555"
	g.SetMode(GateModeRequest{Run: testRun, BlockId: "block-1", SessionId: session, Mode: ModeAlways})
	for i := 0; i < 7; i++ {
		g.NoteApproved("block-1", session)
	}
	g.NoteApproved("block-1", "99999999-aaaa")
	state := g.State()
	if len(state.Autonomy) != 1 || state.Autonomy[0].Approved != 7 {
		t.Fatalf("state %+v", state.Autonomy)
	}
	// Setting the mode again starts a new count, from when the developer set it.
	f.advance(time.Minute)
	g.SetMode(GateModeRequest{Run: testRun, BlockId: "block-1", SessionId: session, Mode: ModeFor, Period: PeriodQuarter})
	state = g.State()
	if state.Autonomy[0].Approved != 0 || state.Autonomy[0].Mode != ModeFor || state.Autonomy[0].Since != f.env().Now().UnixMilli() {
		t.Fatalf("state %+v", state.Autonomy)
	}
}

func TestGatePublishesEveryChange(t *testing.T) {
	f := makeGateFixture(t)
	g := f.gate()
	session := "11111111-2222-3333-4444-555555555555"
	last := int64(0)
	changes := func(what string) {
		t.Helper()
		select {
		case v := <-f.published:
			if v <= last {
				t.Fatalf("%s: version %d after %d", what, v, last)
			}
			last = v
		case <-time.After(gateDeadline):
			t.Fatalf("%s was not published", what)
		}
	}
	g.SetMode(GateModeRequest{Run: testRun, BlockId: "block-1", SessionId: session, Mode: ModeAlways})
	changes("a mode")
	g.NoteApproved("block-1", session)
	changes("an approval")
	g.NoteTerminalOnly(holdRequest("block-1", "git push --force origin main"), reasonForcePush+"main")
	changes("a request kept for the terminal")
	g.SetMode(GateModeRequest{Run: testRun, BlockId: "block-1", SessionId: session, Mode: ModeAsk})
	changes("a stop")
	if g.State().Version != last {
		t.Fatalf("state version %d, published %d", g.State().Version, last)
	}
}
