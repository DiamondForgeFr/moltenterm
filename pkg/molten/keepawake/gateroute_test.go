// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package keepawake

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
	"github.com/wavetermdev/waveterm/pkg/molten/proctree"
)

const gateSession = "11111111-2222-3333-4444-555555555555"

// The terminal's process tree as the tests have it: the shell, the agent (the run), the sh its hook goes through and the
// hook (`molten agent permission`) itself.
const (
	gateAgentPid    = int32(4242)
	gateAgentStart  = int64(1_700_000_000_000)
	gateHookShPid   = int32(4299)
	gateHookPid     = int32(4300)
	gateShellPid    = int32(100)
	gateOtherBash   = int32(4350)
	gateOtherAgent  = int32(4343)
	gateOtherHookSh = int32(4399)
	gateOtherHook   = int32(4400)
)

func gateProcs() *proctree.Table {
	return proctree.MakeTable([]proctree.Proc{
		{Pid: gateShellPid, Ppid: 1, Name: "zsh", StartMs: gateAgentStart - 60_000},
		{Pid: gateAgentPid, Ppid: gateShellPid, Name: "claude", StartMs: gateAgentStart},
		{Pid: gateHookShPid, Ppid: gateAgentPid, Name: "sh", StartMs: gateAgentStart + 5000},
		{Pid: gateHookPid, Ppid: gateHookShPid, Name: "molten", StartMs: gateAgentStart + 5001},
		// A second run of the agent that the first one started (its Bash tool ran `claude --continue`).
		{Pid: gateOtherBash, Ppid: gateAgentPid, Name: "bash", StartMs: gateAgentStart + 9000},
		{Pid: gateOtherAgent, Ppid: gateOtherBash, Name: "claude", StartMs: gateAgentStart + 9100},
		{Pid: gateOtherHookSh, Ppid: gateOtherAgent, Name: "sh", StartMs: gateAgentStart + 9200},
		{Pid: gateOtherHook, Ppid: gateOtherHookSh, Name: "molten", StartMs: gateAgentStart + 9201},
	})
}

func gateRun(session string) molten.AgentRunInfo {
	return molten.AgentRunInfo{
		BlockId: "block-1", Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateWorking,
		Pid: gateAgentPid, PidStartMs: gateAgentStart, SessionId: session,
	}
}

// gateService is wavesrv's side of the permission gate, with the terminals' facts the agent states would give.
type gateService struct {
	*gateFixture
	env     *fakeEnv
	keeper  *Keeper
	s       *service
	reports map[string]molten.AgentIntegrationReport
	runs    map[string]molten.AgentRunInfo
}

func claudeReport(block string) molten.AgentIntegrationReport {
	return molten.AgentIntegrationReport{
		BlockId: block, Agent: molten.AgentIdClaude, HoldsApprovals: true,
		Added: []molten.IntegrationItem{{Kind: molten.IntegrationCoffeeApproval}},
	}
}

func makeGateService(t *testing.T) *gateService {
	g := &gateService{
		gateFixture: makeGateFixture(t), env: makeFakeEnv(),
		reports: map[string]molten.AgentIntegrationReport{"block-1": claudeReport("block-1")},
		runs:    map[string]molten.AgentRunInfo{"block-1": gateRun(gateSession)},
	}
	g.keeper = g.env.keeper()
	g.s = &service{
		keeper: g.keeper, locate: makeTtlCache[BlockInfo](), tabs: makeTtlCache[string](), gate: g.gate(),
		integration: func(id string) (molten.AgentIntegrationReport, bool) {
			r, ok := g.reports[id]
			return r, ok
		},
		agentRun: func(id string) (molten.AgentRunInfo, bool) {
			r, ok := g.runs[id]
			return r, ok
		},
		runApproval: func(fn func()) { fn() },
		namesOf:     func(context.Context, string) (string, string, string) { return "ws-a", "Alpha", "Tab 1" },
		now:         g.gateFixture.env().Now,
		procs:       gateProcs,
	}
	g.s.gate.env.Moved = g.s.agentMoved
	g.s.gate.env.RunOf = g.s.runOf
	g.setBlock("block-1", BlockInfo{WorkspaceId: "ws-a"})
	g.s.hooks.mark(molten.AgentIdClaude)
	return g
}

func (g *gateService) setBlock(id string, info BlockInfo) {
	g.s.locate.put(id, info, true, time.Now().Add(time.Hour))
}

// ask is the hook's two calls: the request, then the wait wavesrv told it to make.
func (g *gateService) ask(ctx context.Context, req PermissionRequest) PermissionAnswer {
	answer := g.s.permission(ctx, req)
	if answer.Wait == "" {
		return answer
	}
	return g.s.gate.Wait(ctx, answer.Wait, req.BlockId)
}

func (g *gateService) permissionAsync(req PermissionRequest) <-chan PermissionAnswer {
	out := make(chan PermissionAnswer, 1)
	go func() { out <- g.ask(context.Background(), req) }()
	return out
}

// held asks for a permission with the companion in view and waits for it to be shown.
func (g *gateService) held(req PermissionRequest) (<-chan PermissionAnswer, GateRequest) {
	g.t.Helper()
	g.s.watch(context.Background(), req.BlockId)
	out := g.permissionAsync(req)
	var shown GateRequest
	g.until("the request to be held", func() bool {
		for _, r := range requestsOf(g.s.gate, req.BlockId) {
			if r.State == RequestHeld {
				shown = r
				return true
			}
		}
		return false
	})
	return out, shown
}

func (g *gateService) autonomous(sessionId string, mode string, period string) GateModeResult {
	return g.s.setAutonomy(context.Background(), GateModeRequest{BlockId: "block-1", SessionId: sessionId, Mode: mode, Period: period})
}

func hookRequest(command string) PermissionRequest {
	req := holdRequest("block-1", command)
	req.HoldMs, req.Pid = 127_000, gateHookPid
	return req
}

// #2474: with the companion in view, the hook's request is held for the developer's answer, for the grace delay at most.
func TestPermissionIsHeldForTheCompanion(t *testing.T) {
	g := makeGateService(t)
	out, shown := g.held(hookRequest("go test ./..."))
	if shown.ToolInput["command"] != "go test ./..." || shown.Agent != "claude" || shown.SessionId != gateSession {
		t.Fatalf("shown %+v", shown)
	}
	if d := g.timerAt(0).d; d != GateGrace {
		t.Fatalf("the request is held for %v, the grace delay is %v", d, GateGrace)
	}
	g.s.gate.Answer(GateAnswer{Id: shown.Id, BlockId: "block-1", Decision: GateAllow})
	if a := recvAnswer(t, out); a.Decision != PermissionAllow {
		t.Fatalf("the hook got %+v", a)
	}
	if got := g.keeper.State().Approvals; len(got) != 0 {
		t.Fatalf("the developer's own click was logged as an automatic approval: %+v", got)
	}

	out, shown = g.held(hookRequest("rm build.log"))
	g.s.gate.Answer(GateAnswer{Id: shown.Id, BlockId: "block-1", Decision: GateDeny})
	if a := recvAnswer(t, out); a.Decision != PermissionDeny || a.Message == "" {
		t.Fatalf("the hook got %+v", a)
	}
}

// The hook's own budget bounds the hold: Codex's is the short one its trust fixes.
func TestPermissionHoldFollowsTheHooksBudget(t *testing.T) {
	g := makeGateService(t)
	g.reports["block-1"] = molten.AgentIntegrationReport{
		BlockId: "block-1", Agent: molten.AgentIdCodex, HoldsApprovals: true,
		Added: []molten.IntegrationItem{{Kind: molten.IntegrationCoffeeApproval}},
	}
	req := hookRequest("ls")
	req.Agent, req.HoldMs = molten.AgentIdCodex, 12_000
	out, shown := g.held(req)
	if d := g.timerAt(0).d; d != 12*time.Second {
		t.Fatalf("held for %v", d)
	}
	g.fire(0)
	if a := recvAnswer(t, out); a.Decision != "" {
		t.Fatalf("the hook answered %+v after its budget", a)
	}
	if got := g.s.gate.Answer(GateAnswer{Id: shown.Id, BlockId: "block-1", Decision: GateAllow}); got.Status != GateGone {
		t.Fatalf("a click after the hold: %+v", got)
	}
}

// Nothing waits when nobody can answer: the agent's own prompt takes the request at once, as it always did.
func TestPermissionIsNotHeldWithoutAWindowOrABudget(t *testing.T) {
	g := makeGateService(t)
	answered := func(name string, req PermissionRequest) {
		t.Helper()
		if a := recvAnswer(t, g.permissionAsync(req)); a.Decision != "" {
			t.Errorf("%s: answered %+v", name, a)
		}
		if shown := g.s.gate.State().Requests; len(shown) != 0 {
			t.Errorf("%s: shown %+v", name, shown)
		}
	}
	answered("no window shows the companion", hookRequest("ls"))

	g.s.watch(context.Background(), "block-1")
	noHold := hookRequest("ls")
	noHold.HoldMs = 0
	answered("the hook asked for no hold", noHold)

	notFromBlock := hookRequest("ls")
	notFromBlock.FromBlock = false
	answered("the caller is not the terminal", notFromBlock)

	noAgent := hookRequest("ls")
	noAgent.Agent = ""
	answered("the hook named no agent", noAgent)

	kimi := hookRequest("ls")
	kimi.Agent = "kimi"
	answered("an agent MoltenTerm does not answer", kimi)

	g.reports["block-1"] = molten.AgentIntegrationReport{BlockId: "block-1", Agent: molten.AgentIdClaude, Added: claudeReport("block-1").Added}
	answered("a run started before the hook had the budget", hookRequest("ls"))

	own := claudeReport("block-1")
	own.Agent = molten.AgentIdCodex
	g.reports["block-1"] = own
	answered("the report is another agent's", hookRequest("ls"))

	delete(g.reports, "block-1")
	answered("no report", hookRequest("ls"))

	g.reports["block-1"] = claudeReport("block-1")
	g.setBlock("block-1", BlockInfo{WorkspaceId: "ws-a", Remote: true})
	answered("a remote terminal", hookRequest("ls"))

	g.setBlock("block-1", BlockInfo{WorkspaceId: "ws-a", Review: true})
	answered("a review session", hookRequest("ls"))
	if len(g.timers) != 0 {
		t.Fatalf("%d timers were started", len(g.timers))
	}
}

func TestPermissionHoldNeedsTheLeaseToBeAlive(t *testing.T) {
	g := makeGateService(t)
	g.s.watch(context.Background(), "block-1")
	g.advance(WatchLease + time.Second)
	if a := recvAnswer(t, g.permissionAsync(hookRequest("ls"))); a.Decision != "" || len(g.timers) != 0 {
		t.Fatalf("a request was held for a window that stopped saying it looks: %+v", a)
	}
}

// The deny list's requests are never held, never approved and always shown with their reason, whatever the mode.
func TestPermissionDenyListStaysWithTheTerminal(t *testing.T) {
	g := makeGateService(t)
	g.s.watch(context.Background(), "block-1")
	if result := g.autonomous(gateSession, ModeAlways, ""); result.Status != ModeSet {
		t.Fatalf("mode %+v", result)
	}
	req := hookRequest("git push --force origin main")
	if a := recvAnswer(t, g.permissionAsync(req)); a.Decision != "" {
		t.Fatalf("the deny list's request got %+v", a)
	}
	shown := requestsOf(g.s.gate, "block-1")
	if len(shown) != 1 || shown[0].State != RequestTerminal || shown[0].Reason == "" || shown[0].ReasonText == nil {
		t.Fatalf("shown %+v", shown)
	}
	if len(g.timers) != 0 {
		t.Fatal("a request of the deny list was held")
	}
	if got := g.keeper.State().Approvals; len(got) != 0 {
		t.Fatalf("the deny list's request was logged as approved: %+v", got)
	}
	if state := g.s.gate.State(); state.Autonomy[0].Approved != 0 {
		t.Fatalf("counted %d", state.Autonomy[0].Approved)
	}

	question := hookRequest("")
	question.ToolName, question.ToolInput = "AskUserQuestion", map[string]any{"questions": []any{}}
	if a := recvAnswer(t, g.permissionAsync(question)); a.Decision != "" {
		t.Fatalf("a question was answered %+v", a)
	}
}

// The deny list with a coffee keeps its own answer: asked, with the reason, logged; and the companion shows it too.
func TestPermissionDenyListWithACoffee(t *testing.T) {
	g := makeGateService(t)
	g.env.work.Workspaces["ws-a"] = true
	if _, err := g.keeper.SetCoffee(context.Background(), "ws-a", true); err != nil {
		t.Fatal(err)
	}
	a := recvAnswer(t, g.permissionAsync(hookRequest("git push --force origin main")))
	if a.Decision != "" || a.Reason == "" {
		t.Fatalf("answer %+v", a)
	}
	if got := g.keeper.State().Approvals; len(got) != 1 || got[0].Outcome != ApprovalAsked || got[0].Source != "" {
		t.Fatalf("approvals %+v", got)
	}
	if shown := requestsOf(g.s.gate, "block-1"); len(shown) != 1 || shown[0].State != RequestTerminal {
		t.Fatalf("shown %+v", shown)
	}
	a = recvAnswer(t, g.permissionAsync(hookRequest("go test ./...")))
	if a.Decision != PermissionAllow {
		t.Fatalf("the coffee did not approve: %+v", a)
	}
	if got := g.keeper.State().Approvals; len(got) != 2 || got[0].Source != "" {
		t.Fatalf("approvals %+v", got)
	}
}

// FR-SHELL-063 AC9 to AC12: a session set to approve its own requests gets an allow at once, logged with its source.
func TestPermissionAutonomousSessionApprovesAndLogs(t *testing.T) {
	g := makeGateService(t)
	result := g.autonomous(gateSession, ModeFor, PeriodHour)
	if result.Status != ModeSet || result.Autonomy == nil || result.Autonomy.Agent != "claude" {
		t.Fatalf("mode %+v", result)
	}
	for i := 0; i < 3; i++ {
		if a := recvAnswer(t, g.permissionAsync(hookRequest("go test ./..."))); a.Decision != PermissionAllow {
			t.Fatalf("request %d got %+v", i, a)
		}
	}
	approvals := g.keeper.State().Approvals
	if len(approvals) != 3 {
		t.Fatalf("approvals %+v", approvals)
	}
	last := approvals[0]
	if last.Source != ApprovalSourceAutonomous || last.Outcome != ApprovalApproved || last.SessionId != gateSession || last.Agent != "claude" ||
		last.Tool != "Bash" || last.Detail != "go test ./..." || last.WorkspaceId != "ws-a" || last.WorkspaceName != "Alpha" || last.TabName != "Tab 1" {
		t.Fatalf("approval %+v", last)
	}
	if state := g.s.gate.State(); state.Autonomy[0].Approved != 3 {
		t.Fatalf("counted %+v", state.Autonomy)
	}
	if len(g.s.gate.State().Requests) != 0 || len(g.timers) != 1 {
		t.Fatalf("a request was held in autonomous mode: %d timers", len(g.timers))
	}

	g.advance(time.Hour)
	g.s.watch(context.Background(), "block-1")
	out := g.permissionAsync(hookRequest("go test ./..."))
	g.until("the request to be held again", func() bool { return len(requestsOf(g.s.gate, "block-1")) == 1 })
	g.fire(1)
	if a := recvAnswer(t, out); a.Decision != "" {
		t.Fatalf("an ended period approved: %+v", a)
	}
}

func TestPermissionAutonomyBelongsToItsSession(t *testing.T) {
	g := makeGateService(t)
	g.autonomous(gateSession, ModeAlways, "")
	other := hookRequest("ls")
	other.SessionId = "11111111-2222-3333-4444-666666666666"
	if a := recvAnswer(t, g.permissionAsync(other)); a.Decision != "" {
		t.Fatalf("a new session of the terminal was approved: %+v", a)
	}
	noSession := hookRequest("ls")
	noSession.SessionId = ""
	if a := recvAnswer(t, g.permissionAsync(noSession)); a.Decision != "" {
		t.Fatalf("a request with no session was approved: %+v", a)
	}
	elsewhere := hookRequest("ls")
	elsewhere.BlockId = "block-2"
	g.setBlock("block-2", BlockInfo{WorkspaceId: "ws-a"})
	if a := recvAnswer(t, g.permissionAsync(elsewhere)); a.Decision != "" {
		t.Fatalf("another terminal was approved: %+v", a)
	}
	if got := g.keeper.State().Approvals; len(got) != 0 {
		t.Fatalf("approvals %+v", got)
	}
}

func TestPermissionStopReturnsToAsk(t *testing.T) {
	g := makeGateService(t)
	g.autonomous(gateSession, ModeAlways, "")
	if a := recvAnswer(t, g.permissionAsync(hookRequest("ls"))); a.Decision != PermissionAllow {
		t.Fatalf("answer %+v", a)
	}
	if result := g.autonomous(gateSession, ModeAsk, ""); result.Status != ModeSet {
		t.Fatalf("stop %+v", result)
	}
	if a := recvAnswer(t, g.permissionAsync(hookRequest("ls"))); a.Decision != "" {
		t.Fatalf("a stopped session was approved: %+v", a)
	}
}

// The developer turns the mode on while a request is held: it goes through and is logged like the others.
func TestPermissionModeAllowsTheHeldRequestAndLogsIt(t *testing.T) {
	g := makeGateService(t)
	g.s.gate.env.Approved = g.s.logHeldApproval
	out, _ := g.held(hookRequest("go test ./..."))
	g.autonomous(gateSession, ModeAlways, "")
	if a := recvAnswer(t, out); a.Decision != PermissionAllow {
		t.Fatalf("the held request got %+v", a)
	}
	approvals := g.keeper.State().Approvals
	if len(approvals) != 1 || approvals[0].Source != ApprovalSourceAutonomous || approvals[0].Detail != "go test ./..." {
		t.Fatalf("approvals %+v", approvals)
	}
}

// A session can be set to approve only when MoltenTerm can answer its agent; stopping always works.
func TestAutonomyIsAvailableOnlyWhereTheHookAnswers(t *testing.T) {
	g := makeGateService(t)
	codex := molten.AgentIntegrationReport{
		BlockId: "block-2", Agent: molten.AgentIdCodex, HoldsApprovals: true,
		Added: []molten.IntegrationItem{{Kind: molten.IntegrationCoffeeApproval}},
	}
	g.reports["block-2"] = codex
	g.runs["block-2"] = molten.AgentRunInfo{
		BlockId: "block-2", Agent: molten.AgentIdCodex, Running: true, Pid: 5252, PidStartMs: gateAgentStart, SessionId: gateSession,
	}
	g.setBlock("block-2", BlockInfo{WorkspaceId: "ws-a"})
	set := func(block string) GateModeResult {
		return g.s.setAutonomy(context.Background(), GateModeRequest{BlockId: block, SessionId: gateSession, Mode: ModeAlways})
	}
	if got := set("block-2"); got.Status != ModeUnavailable || got.ReasonText == nil || got.ReasonText.Code != "keepawake.session.codexuntrusted" {
		t.Fatalf("Codex before its hook was trusted: %+v", got)
	}
	g.s.hooks.mark(molten.AgentIdCodex)
	if got := set("block-2"); got.Status != ModeSet {
		t.Fatalf("Codex once its hook ran: %+v", got)
	}

	g.setBlock("block-1", BlockInfo{WorkspaceId: "ws-a", Review: true})
	if got := set("block-1"); got.Status != ModeUnavailable || got.ReasonText.Code != "keepawake.session.review" {
		t.Fatalf("a review session: %+v", got)
	}
	g.setBlock("block-1", BlockInfo{WorkspaceId: "ws-a", Remote: true})
	if got := set("block-1"); got.Status != ModeUnavailable || got.ReasonText.Code != "keepawake.session.remote" {
		t.Fatalf("a remote terminal: %+v", got)
	}
	g.setBlock("block-1", BlockInfo{WorkspaceId: "ws-a"})
	g.reports["block-1"] = molten.AgentIntegrationReport{BlockId: "block-1", Agent: molten.AgentIdClaude}
	if got := set("block-1"); got.Status != ModeUnavailable || got.Reason == "" {
		t.Fatalf("a run with no hook: %+v", got)
	}
	g.runs["block-1"] = molten.AgentRunInfo{BlockId: "block-1", Agent: "kimi", Running: true}
	if got := set("block-1"); got.Status != ModeUnavailable {
		t.Fatalf("Kimi: %+v", got)
	}
	delete(g.runs, "block-1")
	if got := set("block-1"); got.Status != ModeUnavailable || got.ReasonText.Code != "keepawake.gate.noagent" {
		t.Fatalf("no agent: %+v", got)
	}
	if got := g.s.setAutonomy(context.Background(), GateModeRequest{BlockId: "block-1", SessionId: gateSession, Mode: ModeAsk}); got.Status != ModeSet {
		t.Fatalf("stopping is always possible: %+v", got)
	}
}

func TestWatchSaysWhatTheSessionCanDo(t *testing.T) {
	g := makeGateService(t)
	ctx := context.Background()
	if got := g.s.watch(ctx, "block-1"); !got.Available || !got.Holds || got.BlockId != "block-1" || !g.s.gate.Watching("block-1") {
		t.Fatalf("watch %+v", got)
	}
	g.reports["block-1"] = molten.AgentIntegrationReport{BlockId: "block-1", Agent: molten.AgentIdClaude, Added: claudeReport("block-1").Added}
	if got := g.s.watch(ctx, "block-1"); !got.Available || got.Holds {
		t.Fatalf("an older run: %+v", got)
	}
	g.runs["block-1"] = molten.AgentRunInfo{BlockId: "block-1", Agent: "kimi", Running: true}
	if got := g.s.watch(ctx, "block-1"); got.Available || got.Holds || got.Reason == "" || got.ReasonText == nil {
		t.Fatalf("Kimi: %+v", got)
	}
	delete(g.runs, "block-1")
	if got := g.s.watch(ctx, "block-1"); got.Available || got.Holds {
		t.Fatalf("no agent: %+v", got)
	}
	if got := g.s.watch(ctx, ""); got.Available || g.s.gate.Watching("") {
		t.Fatalf("no terminal: %+v", got)
	}
}

func TestAgentMovedFollowsTheAgentsState(t *testing.T) {
	g := makeGateService(t)
	at := int64(1_000_000)
	set := func(run molten.AgentRunInfo) { g.runs["block-1"] = run }
	for name, c := range map[string]struct {
		run   molten.AgentRunInfo
		moved bool
	}{
		"waiting for the answer":                {molten.AgentRunInfo{Running: true, State: molten.AgentStateWaiting, StateSince: at + 5000}, false},
		"working since before the request":      {molten.AgentRunInfo{Running: true, State: molten.AgentStateWorking, StateSince: at - 5000}, false},
		"working since a moment after it":       {molten.AgentRunInfo{Running: true, State: molten.AgentStateWorking, StateSince: at + 500}, false},
		"working since well after it (went on)": {molten.AgentRunInfo{Running: true, State: molten.AgentStateWorking, StateSince: at + 5000}, true},
		"done after it":                         {molten.AgentRunInfo{Running: true, State: molten.AgentStateDone, StateSince: at + 5000}, true},
		"ended":                                 {molten.AgentRunInfo{Running: false, State: molten.AgentStateWaiting, StateSince: at}, true},
	} {
		set(c.run)
		if got := g.s.agentMoved("block-1", at); got != c.moved {
			t.Errorf("%s: %v", name, got)
		}
	}
	delete(g.runs, "block-1")
	if !g.s.agentMoved("block-1", at) {
		t.Error("no agent runs: the request is over")
	}
}

// The windows (and Electron main) answer and set the modes; no terminal or forged caller does, so no agent or page can
// allow what it asks for (#2474).
func TestGateRouteIsForTheWindowsOnly(t *testing.T) {
	e := routetest.Make(t)
	g := makeGateService(t)
	link, err := localroute.MakeLink(e.Router, (&gateLink{s: g.s}).route())
	if err != nil {
		t.Fatal(err)
	}
	_, shown := g.held(hookRequest("go test ./..."))
	answer := map[string]any{"id": shown.Id, "blockid": "block-1", "decision": GateAllow}
	mode := map[string]any{"blockid": "block-1", "sessionid": gateSession, "mode": ModeAlways}
	watch := map[string]any{"blockid": "block-1"}
	nonUi := append([]routetest.From{e.Terminal()}, e.Forged()...)
	for command, data := range map[string]any{GateStateCommand: nil, GateAnswerCommand: answer, GateModeCommand: mode, GateWatchCommand: watch} {
		routetest.MustRefuse(t, link, nonUi, command, data)
	}
	if len(requestsOf(g.s.gate, "block-1")) != 1 || g.s.gate.Autonomous("block-1", gateSession, testRun) {
		t.Fatal("a refused caller answered a request or set a mode")
	}
	for _, from := range []routetest.From{e.Window(), e.Electron()} {
		for command, data := range map[string]any{GateStateCommand: nil, GateWatchCommand: watch} {
			if _, errStr := routetest.Ask(t, link, from, command, data); errStr != "" {
				t.Errorf("%s from %s: %s", command, from.Name, errStr)
			}
		}
	}
	out, errStr := routetest.Ask(t, link, e.Window(), GateAnswerCommand, answer)
	if errStr != "" || out.(map[string]any)["status"] != GateAnswered {
		t.Fatalf("the window's answer: %v %q", out, errStr)
	}
	// The agent comes from what wavesrv knows of the terminal, never from the caller.
	forged := map[string]any{"blockid": "block-1", "sessionid": gateSession, "mode": ModeAlways, "agent": "codex"}
	out, errStr = routetest.Ask(t, link, e.Window(), GateModeCommand, forged)
	if errStr != "" || out.(map[string]any)["status"] != ModeSet {
		t.Fatalf("the window's mode: %v %q", out, errStr)
	}
	if state := g.s.gate.State(); len(state.Autonomy) != 1 || state.Autonomy[0].Agent != "claude" {
		t.Fatalf("autonomy %+v", state.Autonomy)
	}
	if _, errStr := routetest.Ask(t, link, e.Window(), "agentpermitnothing", nil); errStr == "" {
		t.Fatal("an unknown command was answered")
	}
}

// The hook's own command stays the terminal's: a window cannot send a request in the agent's name (#662).
func TestGateRoutesStayApart(t *testing.T) {
	e := routetest.Make(t)
	g := makeGateService(t)
	hooks, err := localroute.MakeLink(e.Router, (&routeLink{s: g.s}).route())
	if err != nil {
		t.Fatal(err)
	}
	routetest.MustRefuseWith(t, hooks, append([]routetest.From{e.Window(), e.Electron()}, e.Forged()...), PermissionCommand, map[string]any{}, "from a local MoltenTerm terminal")
	if GateRoute == Route || GateEvent == Event {
		t.Fatal("the gate shares the keep-awake route or event")
	}
}

func TestAlwaysStoreKeepsSessionsPrivately(t *testing.T) {
	dir := t.TempDir()
	store := makeAlwaysStore(dir)
	if got := store.load(); got != nil {
		t.Fatalf("loaded %+v from nothing", got)
	}
	want := []Autonomy{{BlockId: "block-1", SessionId: gateSession, Agent: "claude", Mode: ModeAlways, Since: 5, RunPid: gateAgentPid, RunStart: gateAgentStart}}
	store.save(want)
	got := store.load()
	if len(got) != 1 || got[0] != want[0] {
		t.Fatalf("loaded %+v", got)
	}
	path := filepath.Join(dir, ApprovalLogDir, alwaysFile)
	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("the file is %v (%v)", info, err)
		}
	}
	store.save(nil)
	if got := store.load(); len(got) != 0 {
		t.Fatalf("loaded %+v after stopping", got)
	}
	if err := os.WriteFile(path, []byte("{broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := store.load(); got != nil {
		t.Fatalf("loaded %+v from a broken file", got)
	}
}
