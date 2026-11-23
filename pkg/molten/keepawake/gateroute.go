// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package keepawake

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/proctree"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

// wavesrv's side of the companion's answers (gate.go, #2474): what a hook's request gets, the route the windows use,
// and the file that keeps the "always" sessions.

const (
	// How long after a request a new agent state counts as the agent going on (the request's own waiting may come a
	// moment after it).
	gateMovedSlackMs = 1000

	alwaysFile = "agent-autonomy.json"
)

func newGateId() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(b[:])
}

func publishGate(version int64) {
	wps.Broker.Publish(wps.WaveEvent{Event: GateEvent, Data: eventSignal{Version: version}})
}

func gateAgent(agent string) bool {
	return agent == molten.AgentIdClaude || agent == molten.AgentIdCodex
}

// hold keeps a request for the companion when a window shows its terminal's companion and the run's hook has the budget
// to wait; otherwise the agent's own prompt answers at once, as it always did. The answer only says the request is held,
// for how long: the hook awaits it with a second call (PermissionWaitCommand), so that a request that is not held never
// costs more than the short time a hook always had. The time already spent since the request arrived counts in the hold.
func (s *service) hold(req PermissionRequest) PermissionAnswer {
	if req.HoldMs <= 0 || !req.FromBlock || !gateAgent(req.Agent) || !s.gate.Watching(req.BlockId) {
		return PermissionAnswer{}
	}
	report, ok := s.integration(req.BlockId)
	if !ok || !report.CanHoldApprovals() || report.Agent != req.Agent {
		return PermissionAnswer{}
	}
	hold := min(time.Duration(req.HoldMs)*time.Millisecond, GateGrace) - s.clock().Sub(req.Arrived)
	id := s.gate.Open(HoldRequest{Req: req, Hold: hold})
	if id == "" {
		return PermissionAnswer{}
	}
	return PermissionAnswer{Wait: id, WaitMs: hold.Milliseconds()}
}

// runRefOf is the run of the agent a terminal's record describes, false when it is not running or its process is not
// known: an autonomous mode is bound to a run, and a run MoltenTerm cannot tell from another has none.
func runRefOf(run molten.AgentRunInfo, ok bool) (RunRef, bool) {
	if !ok || !run.Running || run.Pid <= 0 {
		return RunRef{}, false
	}
	return RunRef{Pid: run.Pid, StartMs: run.PidStartMs}, true
}

func (s *service) runOf(blockId string) (RunRef, bool) {
	run, ok := s.agentRun(blockId)
	return runRefOf(run, ok)
}

// autonomous tells whether a request is approved without asking: its session is set to approve, in the run that is in
// the terminal now, the session is the one that run reports, and the request comes from that run's own process, not from
// another run of the agent that the first started (it inherits the terminal and its session, never the developer's choice).
func (s *service) autonomous(req PermissionRequest) bool {
	if req.SessionId == "" || !req.FromBlock {
		return false
	}
	run, ok := s.agentRun(req.BlockId)
	ref, tracked := runRefOf(run, ok)
	if !tracked {
		return false
	}
	// The session the run's own hooks report last: a request of another session is not its approved one.
	if run.SessionId != "" && !strings.EqualFold(run.SessionId, req.SessionId) {
		return false
	}
	if !s.gate.Autonomous(req.BlockId, req.SessionId, ref) {
		return false
	}
	return s.fromTrackedRun(ref, req.Pid)
}

var agentProgramNames = map[string]bool{"claude": true, "codex": true}

// fromTrackedRun tells whether the hook process comes from the run's process: the run is an ancestor of the hook, with no
// nearer process of the same program between them (the hook of a run the first one started has its own agent process
// above it, and that one is not the run the developer chose). Without the hook's process, or the table, it is not.
func (s *service) fromTrackedRun(run RunRef, hookPid int32) bool {
	if hookPid <= 0 || s.procs == nil {
		return false
	}
	table := s.procs()
	if table == nil || !table.Same(run.Pid, run.StartMs) {
		return false
	}
	name := table.Get(run.Pid).Name
	pid := hookPid
	for i := 0; i < 2*proctree.MaxDepth; i++ {
		p := table.Get(pid)
		if p == nil {
			return false
		}
		if p.Pid == run.Pid {
			return true
		}
		if (name != "" && p.Name == name) || agentProgramNames[p.Name] {
			return false
		}
		if p.Ppid == p.Pid || p.Ppid <= 0 {
			return false
		}
		pid = p.Ppid
	}
	return false
}

// agentMoved tells whether the agent of a terminal went on after a request, or ended.
func (s *service) agentMoved(blockId string, at int64) bool {
	run, ok := s.agentRun(blockId)
	if !ok || !run.Running {
		return true
	}
	return run.State != molten.AgentStateWaiting && run.StateSince > at+gateMovedSlackMs
}

// logHeldApproval logs a held request a session's new mode allowed.
func (s *service) logHeldApproval(held GateRequest) {
	info, found := s.locateBlock(context.Background(), held.BlockId)
	if !found {
		return
	}
	req := PermissionRequest{BlockId: held.BlockId, Agent: held.Agent, SessionId: held.SessionId, ToolName: held.Tool, ToolInput: held.ToolInput}
	s.recordApproval(info, req, PermissionAnswer{Decision: PermissionAllow}, ApprovalApproved, ApprovalSourceAutonomous)
}

// watch notes that a window shows the terminal's companion, and says what the terminal's agent session can do.
func (s *service) watch(ctx context.Context, blockId string) GateWatchResult {
	result := GateWatchResult{BlockId: blockId}
	if blockId == "" {
		return result
	}
	s.gate.Watch(blockId)
	info, found := s.locateBlock(ctx, blockId)
	run, running := s.agentRun(blockId)
	if !found || !running {
		return result
	}
	report, hasReport := s.integration(blockId)
	result.Available, result.Reason, result.ReasonText = s.autonomyAvailable(info, run.Agent, report, hasReport)
	result.Holds = result.Available && report.CanHoldApprovals()
	return result
}

// autonomyAvailable says whether a terminal's agent session can be set to approve its own requests, and why not.
func (s *service) autonomyAvailable(info BlockInfo, agent string, report molten.AgentIntegrationReport, hasReport bool) (bool, string, *uimsg.Text) {
	if info.Review {
		return false, ReasonReviewSession, uimsg.Make("keepawake.session.review")
	}
	return SessionApprovalText(agent, info.Remote, report, hasReport, s.hooks.ran(agent))
}

// setAutonomy sets what a session's requests get, after checking that its terminal's agent can be answered, that it is
// the run MoltenTerm can tell from another, and that the session is the one that run reports (a window's word for it is
// not enough): stopping is always possible.
func (s *service) setAutonomy(ctx context.Context, req GateModeRequest) GateModeResult {
	if req.Mode == ModeAsk {
		return s.gate.SetMode(req)
	}
	info, found := s.locateBlock(ctx, req.BlockId)
	run, running := s.agentRun(req.BlockId)
	if !found || !running {
		return GateModeResult{Status: ModeUnavailable, Reason: "no agent runs in this terminal", ReasonText: uimsg.Make("keepawake.gate.noagent")}
	}
	report, hasReport := s.integration(req.BlockId)
	if ok, reason, text := s.autonomyAvailable(info, run.Agent, report, hasReport); !ok {
		return GateModeResult{Status: ModeUnavailable, Reason: reason, ReasonText: text}
	}
	ref, known := runRefOf(run, true)
	if !known {
		return GateModeResult{Status: ModeUnavailable, Reason: "MoltenTerm cannot tell this run of the agent apart yet", ReasonText: uimsg.Make("keepawake.gate.norun")}
	}
	live := run.SessionId
	if live == "" {
		return GateModeResult{Status: ModeUnavailable, Reason: "MoltenTerm has not seen this agent's session yet", ReasonText: uimsg.Make("keepawake.gate.nosession")}
	}
	if !strings.EqualFold(live, req.SessionId) {
		return GateModeResult{Status: ModeUnavailable, Reason: "this is not the session the agent runs now", ReasonText: uimsg.Make("keepawake.gate.othersession")}
	}
	req.Agent, req.Run = run.Agent, ref
	return s.gate.SetMode(req)
}

type gateLink struct {
	s *service
}

// route lets in MoltenTerm's windows and Electron main only: the developer's own click answers a request or sets a
// mode, and no program, agent or page in a terminal can (#2474). The hook that brings the request uses the keep-awake
// route's own command, from a local terminal.
func (l *gateLink) route() localroute.Route {
	return localroute.Route{
		Id:     GateRoute,
		Policy: localroute.Policy{Default: localroute.AllowUi},
		Handler: func(ctx context.Context, command string, _ localroute.Caller, data any) (any, error) {
			return l.handle(ctx, command, data)
		},
	}
}

type gateWatchRequest struct {
	BlockId string `json:"blockid"`
}

func (l *gateLink) handle(ctx context.Context, command string, data any) (any, error) {
	ctx, cancel := context.WithTimeout(ctx, storeTimeout)
	defer cancel()
	switch command {
	case GateStateCommand:
		return l.s.gate.State(), nil
	case GateAnswerCommand:
		var req GateAnswer
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.s.gate.Answer(req), nil
	case GateModeCommand:
		var req GateModeRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.s.setAutonomy(ctx, req), nil
	case GateWatchCommand:
		var req gateWatchRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.s.watch(ctx, req.BlockId), nil
	}
	return nil, fmt.Errorf("unknown permission gate command %q", command)
}

// alwaysStore keeps the "always" sessions in a file of the data folder, for that session id only (gate.go).
type alwaysStore struct {
	lock sync.Mutex
	path string
}

func makeAlwaysStore(dataDir string) *alwaysStore {
	return &alwaysStore{path: filepath.Join(dataDir, ApprovalLogDir, alwaysFile)}
}

func (a *alwaysStore) load() []Autonomy {
	a.lock.Lock()
	defer a.lock.Unlock()
	data, err := os.ReadFile(a.path)
	if err != nil {
		return nil
	}
	var list []Autonomy
	if err := json.Unmarshal(data, &list); err != nil {
		log.Printf("molten: autonomous sessions not read: %v\n", err)
		return nil
	}
	return list
}

func (a *alwaysStore) save(list []Autonomy) {
	a.lock.Lock()
	defer a.lock.Unlock()
	if err := a.write(list); err != nil {
		log.Printf("molten: autonomous sessions not kept: %v\n", err)
	}
}

func (a *alwaysStore) write(list []Autonomy) error {
	if err := os.MkdirAll(filepath.Dir(a.path), 0o700); err != nil {
		return err
	}
	if list == nil {
		list = []Autonomy{}
	}
	data, err := json.Marshal(list)
	if err != nil {
		return err
	}
	tmp := a.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, a.path)
}
