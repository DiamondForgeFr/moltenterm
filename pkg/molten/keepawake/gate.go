// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package keepawake

import (
	"context"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// The companion's answer to an agent's permission request (#2474, FR-SHELL-018, FR-SHELL-063 AC9 to AC12). The agent's
// PermissionRequest hook (`molten agent permission`) reaches wavesrv, which keeps the request while a window shows that
// terminal's companion, and the hook prints the developer's answer: the agent goes on as if it had been answered in its
// terminal. Autonomous mode is the same hook answered by memory: one agent session may have its requests approved for a
// period or always, which the developer sets and ends from a window.
//
//   - Each held request has an id of its own, random, kept in memory: an answer counts only for the request still held
//     under that id in that terminal, so none is replayed after the hook gave up, after a restart, or after a newer
//     request of the terminal took its place.
//   - Only a window answers (the route lets in the windows and Electron main, never a terminal), so no agent, program or
//     page can allow what it asks for.
//   - Nothing is held for a request the deny list keeps for the developer, nor while no window shows the terminal's
//     companion, nor for a run whose hook has not the budget to wait (molten.AgentIntegrationReport.CanHoldApprovals): the
//     agent's own prompt answers those at once, as before.
//   - A request is opened in one call, which answers at once, and awaited in a second the hook makes only when the first
//     said the request is held: a slow wavesrv costs a prompt that is not held no more than the short budget it always had.
//   - An autonomous mode belongs to one terminal, one agent session id and one run of the agent (its process). It is never
//     inherited by a new session nor by a new run of the same session (`claude --continue`, `--resume`, `--session-id`);
//     a period ends by itself; "always" is the only one kept across a restart of MoltenTerm, in a file of the data folder,
//     for that session and the run that goes on.

const (
	GateRoute = "molten:agentpermit"
	// GateEvent says the gate's state changed; it carries the version only, readers ask the route for the state.
	GateEvent = "molten:agentpermit"

	GateStateCommand  = "agentpermitstate"
	GateAnswerCommand = "agentpermitanswer"
	GateModeCommand   = "agentpermitmode"
	GateWatchCommand  = "agentpermitwatch"

	// The developer's decisions on a held request.
	GateAllow    = "allow"
	GateDeny     = "deny"
	GateTerminal = "terminal"

	GateAnswered = "answered"
	GateGone     = "gone"
	GateInvalid  = "invalid"

	// What a request is for the windows: held for the developer's answer, or only to be answered in the terminal.
	RequestHeld     = "held"
	RequestTerminal = "terminal"

	// The modes of a session; a session with none asks (the default).
	ModeAsk    = "ask"
	ModeFor    = "for"
	ModeAlways = "always"

	PeriodQuarter   = "15m"
	PeriodHour      = "1h"
	PeriodFourHours = "4h"
	PeriodTonight   = "tonight"

	ModeSet         = "set"
	ModeInvalid     = "invalid"
	ModeUnavailable = "unavailable"

	// GateGrace: the longest a request waits in wavesrv for the developer's answer before the agent's own prompt takes it.
	GateGrace = molten.CompanionPermissionGrace
	// WatchLease: how long a window's word that it shows a terminal's companion holds; the window renews it.
	WatchLease = 30 * time.Second

	// A request kept only to be answered in the terminal goes after this, if the agent never reported moving on.
	terminalKeep = 10 * time.Minute
	// A held request is not shown for less than this: the hook's own budget may leave no more.
	minHold = 2 * time.Second
	// A request that left the list (answered, released) stays here for its hook, which awaits it in a second call.
	parkKeep = 30 * time.Second

	maxGateRequests = 50
	maxAlways       = 100
	alwaysKeep      = 30 * 24 * time.Hour
	// What a request shows of one text of its input; the agent gets the input as it sent it.
	maxShownText = 4000

	// The evening the "until tonight" period reaches, from when the evening starts; past it, the next morning.
	tonightHour     = 22
	tonightFromHour = 21
	morningHour     = 6

	// Start times of one process, read at different times, differ by what a platform rounds.
	runStartTolerance = 1000

	gateDenyMessage = "The developer denied this in MoltenTerm."
)

// RunRef is a run of an agent in a terminal: its process, and when it started to tell a reused pid apart.
type RunRef struct {
	Pid     int32 `json:"runpid,omitempty"`
	StartMs int64 `json:"runstart,omitempty"`
}

// Known: the run can be told from another.
func (r RunRef) Known() bool {
	return r.Pid > 0
}

// SameRun tells whether a and b are one process.
func SameRun(a RunRef, b RunRef) bool {
	if !a.Known() || a.Pid != b.Pid {
		return false
	}
	if a.StartMs <= 0 || b.StartMs <= 0 {
		return true
	}
	diff := a.StartMs - b.StartMs
	return diff > -runStartTolerance && diff < runStartTolerance
}

// GateRequest is a request as the windows show it.
type GateRequest struct {
	Id        string         `json:"id"`
	BlockId   string         `json:"blockid"`
	SessionId string         `json:"sessionid,omitempty"`
	Agent     string         `json:"agent,omitempty"`
	Tool      string         `json:"tool"`
	ToolInput map[string]any `json:"toolinput,omitempty"`
	// Clipped: a text of the input is shown cut. Such a request is never allowed from a window: what the developer
	// cannot read in full is answered in the terminal.
	Clipped bool   `json:"clipped,omitempty"`
	Cwd     string `json:"cwd,omitempty"`
	// At is when the request came, Unix milliseconds; Deadline when a held one goes back to the agent's prompt.
	At       int64  `json:"at"`
	State    string `json:"state"`
	Deadline int64  `json:"deadline,omitempty"`
	// Reason: why the request stays with the developer (the deny list's), State RequestTerminal.
	Reason     string      `json:"reason,omitempty"`
	ReasonText *uimsg.Text `json:"reasontext,omitempty"`
}

// Autonomy is a session whose requests are approved without asking, for the run it was set in.
type Autonomy struct {
	BlockId   string `json:"blockid"`
	SessionId string `json:"sessionid"`
	Agent     string `json:"agent,omitempty"`
	Mode      string `json:"mode"`
	// Since: when the developer set it; Until: when a period ends, 0 for always (Unix milliseconds).
	Since int64 `json:"since"`
	Until int64 `json:"until,omitempty"`
	// Approved: how many requests it approved since Since.
	Approved int `json:"approved"`
	// The run it was set in: another run of the agent in the terminal, whatever its session, does not have it.
	RunPid   int32 `json:"runpid,omitempty"`
	RunStart int64 `json:"runstart,omitempty"`
}

func (a Autonomy) run() RunRef {
	return RunRef{Pid: a.RunPid, StartMs: a.RunStart}
}

type GateState struct {
	Version  int64         `json:"version"`
	Requests []GateRequest `json:"requests"`
	Autonomy []Autonomy    `json:"autonomy"`
}

// GateAnswer is a window's click on a held request.
type GateAnswer struct {
	Id       string `json:"id"`
	BlockId  string `json:"blockid"`
	Decision string `json:"decision"`
}

type GateResult struct {
	Status string `json:"status"`
}

// GateModeRequest is a window's choice for one agent session. Agent and Run are set by the route from what it knows of
// the terminal's agent, never read from the caller.
type GateModeRequest struct {
	BlockId   string `json:"blockid"`
	SessionId string `json:"sessionid"`
	Mode      string `json:"mode"`
	Period    string `json:"period,omitempty"`
	Agent     string `json:"-"`
	Run       RunRef `json:"-"`
}

type GateModeResult struct {
	Status     string      `json:"status"`
	Autonomy   *Autonomy   `json:"autonomy,omitempty"`
	Reason     string      `json:"reason,omitempty"`
	ReasonText *uimsg.Text `json:"reasontext,omitempty"`
}

// GateWatchResult answers a window's word that it shows a terminal's companion: whether its agent session can be set
// to approve automatically (and why not), and whether its requests are held for the companion.
type GateWatchResult struct {
	BlockId    string      `json:"blockid"`
	Available  bool        `json:"available"`
	Holds      bool        `json:"holds"`
	Reason     string      `json:"reason,omitempty"`
	ReasonText *uimsg.Text `json:"reasontext,omitempty"`
}

// GateEnv is what the gate reaches outside itself; the tests give fakes.
type GateEnv struct {
	Now   func() time.Time
	NewId func() string
	// Timer returns a channel that receives after d, and the call that stops it.
	Timer func(d time.Duration) (<-chan time.Time, func())
	// Publish tells the windows the state changed; it is called outside the gate's lock.
	Publish func(version int64)
	// Moved tells whether the agent of a terminal went on after at (Unix milliseconds): the request was answered
	// elsewhere, or the agent ended.
	Moved func(blockId string, at int64) bool
	// RunOf tells the run of the agent in a terminal now; false when none runs there or MoltenTerm cannot tell it from
	// another (its process is not known).
	RunOf func(blockId string) (RunRef, bool)
	// LoadAlways and SaveAlways keep the "always" sessions across a restart; nil keeps them in memory only. SaveAlways
	// is called outside the gate's lock, in the order of the changes.
	LoadAlways func() []Autonomy
	SaveAlways func([]Autonomy)
	// Approved is told of a held request a session's new mode allowed, so that it is logged like the others.
	Approved func(req GateRequest)
}

type gateDecision struct {
	decision string
}

type gateEntry struct {
	view GateRequest
	// answer receives the developer's decision of a held request; finished is closed when the request left the list,
	// answered or not; stop ends its deadline's timer.
	answer   chan gateDecision
	finished chan struct{}
	stop     func()
	// taken: the request left the gate's list (answered, released, replaced or dropped).
	taken    bool
	parkedAt time.Time
}

type gateMode struct {
	view Autonomy
	// quit ends the expiry's wait when the mode is replaced or stopped.
	quit chan struct{}
}

type Gate struct {
	env GateEnv

	lock    sync.Mutex
	version int64
	pending map[string]*gateEntry
	// parked: held requests that left the list, until their hook awaited them or parkKeep passed.
	parked map[string]*gateEntry
	modes  map[string]*gateMode
	leases map[string]time.Time
	// seen: the run last seen alive in a terminal, to tell its end from MoltenTerm not knowing it yet after a restart.
	seen map[string]RunRef

	saveLock sync.Mutex
	saveSeq  int64
	saved    int64
}

func realTimer(d time.Duration) (<-chan time.Time, func()) {
	t := time.NewTimer(d)
	return t.C, func() { t.Stop() }
}

func MakeGate(env GateEnv) *Gate {
	if env.Now == nil {
		env.Now = time.Now
	}
	if env.NewId == nil {
		env.NewId = newGateId
	}
	if env.Timer == nil {
		env.Timer = realTimer
	}
	g := &Gate{
		env: env, pending: map[string]*gateEntry{}, parked: map[string]*gateEntry{}, modes: map[string]*gateMode{},
		leases: map[string]time.Time{}, seen: map[string]RunRef{},
	}
	if env.LoadAlways != nil {
		g.loadAlways(env.LoadAlways())
	}
	return g
}

func (g *Gate) loadAlways(list []Autonomy) {
	now := g.env.Now()
	for _, a := range list {
		if a.Mode != ModeAlways || !validSessionId(a.SessionId) || a.BlockId == "" || !a.run().Known() || len(g.modes) >= maxAlways {
			continue
		}
		if a.Since > 0 && now.Sub(time.UnixMilli(a.Since)) > alwaysKeep {
			continue
		}
		a.Until, a.Approved = 0, 0
		g.modes[modeKey(a.BlockId, a.SessionId)] = &gateMode{view: a, quit: make(chan struct{})}
	}
}

func modeKey(blockId string, sessionId string) string {
	return blockId + "\x00" + strings.ToLower(sessionId)
}

var sessionIdPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{8,200}$`)

func validSessionId(id string) bool {
	return sessionIdPattern.MatchString(id)
}

// changed tells the windows; call it outside the lock.
func (g *Gate) changed() {
	g.lock.Lock()
	g.version++
	version := g.version
	g.lock.Unlock()
	if g.env.Publish != nil {
		g.env.Publish(version)
	}
}

// State is what the windows read.
func (g *Gate) State() GateState {
	g.lock.Lock()
	defer g.lock.Unlock()
	now := g.env.Now()
	state := GateState{Version: g.version, Requests: []GateRequest{}, Autonomy: []Autonomy{}}
	for _, e := range g.pending {
		if e.view.State == RequestTerminal && now.Sub(time.UnixMilli(e.view.At)) > terminalKeep {
			continue
		}
		state.Requests = append(state.Requests, e.view)
	}
	sort.Slice(state.Requests, func(i, j int) bool {
		a, b := state.Requests[i], state.Requests[j]
		if a.At != b.At {
			return a.At < b.At
		}
		return a.Id < b.Id
	})
	for _, m := range g.modes {
		if m.expired(now) {
			continue
		}
		state.Autonomy = append(state.Autonomy, m.view)
	}
	sort.Slice(state.Autonomy, func(i, j int) bool {
		a, b := state.Autonomy[i], state.Autonomy[j]
		if a.Since != b.Since {
			return a.Since < b.Since
		}
		return a.BlockId+a.SessionId < b.BlockId+b.SessionId
	})
	return state
}

func (m *gateMode) expired(now time.Time) bool {
	return m.view.Until > 0 && now.UnixMilli() >= m.view.Until
}

// Watch notes that a window shows the terminal's companion for the lease's time: only then is a request held.
func (g *Gate) Watch(blockId string) {
	if blockId == "" {
		return
	}
	g.lock.Lock()
	defer g.lock.Unlock()
	now := g.env.Now()
	for id, until := range g.leases {
		if !until.After(now) {
			delete(g.leases, id)
		}
	}
	g.leases[blockId] = now.Add(WatchLease)
}

func (g *Gate) Watching(blockId string) bool {
	g.lock.Lock()
	defer g.lock.Unlock()
	until, ok := g.leases[blockId]
	return ok && until.After(g.env.Now())
}

// HoldRequest is a request to keep for the developer's answer, at most Hold.
type HoldRequest struct {
	Req  PermissionRequest
	Hold time.Duration
}

// Open keeps the request for the developer's answer, at most Hold from now, and says at once that it does: the hook
// awaits it with Wait. It returns "" when there is no time to be answered (Hold under minHold).
func (g *Gate) Open(h HoldRequest) string {
	if h.Hold < minHold {
		return ""
	}
	now := g.env.Now()
	e := g.makeEntry(h.Req, RequestHeld, "")
	e.view.Deadline = now.Add(h.Hold).UnixMilli()
	e.answer, e.finished = make(chan gateDecision, 1), make(chan struct{})
	timer, stop := g.env.Timer(h.Hold)
	e.stop = stop
	g.add(e)
	go func() {
		defer func() {
			panichandler.PanicHandler("molten:keepawake:gatedeadline", recover())
		}()
		select {
		case <-timer:
			if g.dropIfPending(e) {
				g.changed()
			}
		case <-e.finished:
		}
	}()
	g.changed()
	return e.view.Id
}

// Wait waits for the request opened under that id in that terminal: the developer's answer, or an empty answer when it
// went back to the agent's prompt (on the developer's word, at its deadline, with the agent going on, replaced) or when
// the hook gives up (ctx). A request that is not there is answered empty.
func (g *Gate) Wait(ctx context.Context, id string, blockId string) PermissionAnswer {
	e := g.entryToWait(id, blockId)
	if e == nil {
		return PermissionAnswer{}
	}
	defer g.forgetParked(e)
	select {
	case d := <-e.answer:
		return answerOfDecision(d)
	case <-e.finished:
	case <-ctx.Done():
		if g.dropIfPending(e) {
			g.changed()
			return PermissionAnswer{}
		}
	}
	// Taken a moment before: an answer sent then is honoured, a release is not an answer.
	select {
	case d := <-e.answer:
		return answerOfDecision(d)
	default:
		return PermissionAnswer{}
	}
}

// Hold opens a request and waits for it, for a caller that holds it in one go.
func (g *Gate) Hold(ctx context.Context, h HoldRequest) PermissionAnswer {
	id := g.Open(h)
	if id == "" {
		return PermissionAnswer{}
	}
	return g.Wait(ctx, id, h.Req.BlockId)
}

func (g *Gate) entryToWait(id string, blockId string) *gateEntry {
	if id == "" {
		return nil
	}
	g.lock.Lock()
	defer g.lock.Unlock()
	e := g.pending[id]
	if e == nil {
		e = g.parked[id]
	}
	if e == nil || e.view.BlockId != blockId || e.answer == nil {
		return nil
	}
	return e
}

func (g *Gate) forgetParked(e *gateEntry) {
	g.lock.Lock()
	defer g.lock.Unlock()
	delete(g.parked, e.view.Id)
}

func answerOfDecision(d gateDecision) PermissionAnswer {
	if d.decision == GateAllow {
		return PermissionAnswer{Decision: PermissionAllow}
	}
	return PermissionAnswer{Decision: PermissionDeny, Message: gateDenyMessage}
}

// NoteTerminalOnly shows a request the developer answers in the terminal only, with the reason, until the agent goes on.
func (g *Gate) NoteTerminalOnly(req PermissionRequest, reason string) {
	g.add(g.makeEntry(req, RequestTerminal, reason))
	g.changed()
}

func (g *Gate) makeEntry(req PermissionRequest, state string, reason string) *gateEntry {
	input, clipped := shownInput(req.ToolInput)
	return &gateEntry{view: GateRequest{
		Id: g.env.NewId(), BlockId: req.BlockId, SessionId: req.SessionId, Agent: req.Agent, Tool: req.ToolName,
		ToolInput: input, Clipped: clipped, Cwd: req.Cwd, At: g.env.Now().UnixMilli(), State: state,
		Reason: reason, ReasonText: DenyReasonText(reason),
	}}
}

// add keeps the entry in place of an older one of the same terminal: an agent asks one thing at a time, so an older
// request still kept was answered in its terminal. A held older one goes back to the agent's prompt.
func (g *Gate) add(e *gateEntry) {
	g.lock.Lock()
	defer g.lock.Unlock()
	now := g.env.Now()
	for id, p := range g.parked {
		if now.Sub(p.parkedAt) > parkKeep {
			delete(g.parked, id)
		}
	}
	for id, old := range g.pending {
		if old.view.BlockId == e.view.BlockId {
			delete(g.pending, id)
			g.takeLocked(old)
		}
	}
	for len(g.pending) >= maxGateRequests {
		g.dropOldestLocked()
	}
	g.pending[e.view.Id] = e
}

func (g *Gate) dropOldestLocked() {
	var oldest *gateEntry
	for _, e := range g.pending {
		if oldest == nil || e.view.At < oldest.view.At {
			oldest = e
		}
	}
	if oldest != nil {
		delete(g.pending, oldest.view.Id)
		g.takeLocked(oldest)
	}
}

// takeLocked ends the entry's wait without an answer, once; a held request is parked for its hook, which awaits it.
func (g *Gate) takeLocked(e *gateEntry) {
	if e.taken {
		return
	}
	e.taken = true
	if e.finished == nil {
		return
	}
	close(e.finished)
	if e.stop != nil {
		e.stop()
	}
	e.parkedAt = g.env.Now()
	g.parked[e.view.Id] = e
}

// dropIfPending removes the entry, false when it was taken already (answered, released or replaced).
func (g *Gate) dropIfPending(e *gateEntry) bool {
	g.lock.Lock()
	defer g.lock.Unlock()
	if e.taken {
		return false
	}
	delete(g.pending, e.view.Id)
	g.takeLocked(e)
	return true
}

// Answer gives the developer's decision to the request held under that id in that terminal; anything else is gone. An
// Allow is refused for a request whose input is shown cut: what cannot be read in full is answered in the terminal.
func (g *Gate) Answer(a GateAnswer) GateResult {
	if a.Decision != GateAllow && a.Decision != GateDeny && a.Decision != GateTerminal {
		return GateResult{Status: GateInvalid}
	}
	result := g.answer(a)
	if result.Status == GateAnswered {
		g.changed()
	}
	return result
}

func (g *Gate) answer(a GateAnswer) GateResult {
	g.lock.Lock()
	defer g.lock.Unlock()
	e := g.pending[a.Id]
	if e == nil || a.Id == "" || e.view.BlockId != a.BlockId || e.view.State != RequestHeld || e.taken {
		return GateResult{Status: GateGone}
	}
	if a.Decision == GateAllow && e.view.Clipped {
		return GateResult{Status: GateInvalid}
	}
	delete(g.pending, a.Id)
	if a.Decision != GateTerminal {
		e.answer <- gateDecision{decision: a.Decision}
	}
	g.takeLocked(e)
	return GateResult{Status: GateAnswered}
}

// Settle lets go of what the agents' state changes ended; wavesrv calls it on every one: the requests whose agent went
// on (it was answered in the terminal, or the agent ended), and the modes of a run that ended or that another run took
// the place of.
func (g *Gate) Settle() {
	g.settleRequests()
	g.settleModes()
}

func (g *Gate) settleRequests() {
	if g.env.Moved == nil {
		return
	}
	g.lock.Lock()
	entries := make([]*gateEntry, 0, len(g.pending))
	for _, e := range g.pending {
		entries = append(entries, e)
	}
	g.lock.Unlock()
	var moved []*gateEntry
	for _, e := range entries {
		if g.env.Moved(e.view.BlockId, e.view.At) {
			moved = append(moved, e)
		}
	}
	if len(moved) == 0 {
		return
	}
	g.lock.Lock()
	for _, e := range moved {
		if g.pending[e.view.Id] == e {
			delete(g.pending, e.view.Id)
			g.takeLocked(e)
		}
	}
	g.lock.Unlock()
	g.changed()
}

// settleModes ends a terminal's modes when its agent's run ended (it was seen alive, and is gone), and those set in
// another run than the one that runs there now. A run MoltenTerm has not seen yet (it restarted, its process is not
// found yet) leaves them as they are: "always" goes on with the run that goes on.
func (g *Gate) settleModes() {
	if g.env.RunOf == nil {
		return
	}
	g.lock.Lock()
	blocks := map[string]bool{}
	for _, m := range g.modes {
		blocks[m.view.BlockId] = true
	}
	g.lock.Unlock()
	if len(blocks) == 0 {
		return
	}
	current := map[string]RunRef{}
	for block := range blocks {
		if run, ok := g.env.RunOf(block); ok {
			current[block] = run
		}
	}
	g.lock.Lock()
	ended, persist := false, false
	for key, m := range g.modes {
		block := m.view.BlockId
		run, alive := current[block]
		if alive {
			g.seen[block] = run
			if SameRun(m.view.run(), run) {
				continue
			}
		} else if !SameRun(m.view.run(), g.seen[block]) {
			continue
		}
		g.endModeLocked(key, m)
		ended, persist = true, persist || m.view.Mode == ModeAlways
	}
	for block := range blocks {
		if _, alive := current[block]; !alive {
			delete(g.seen, block)
		}
	}
	g.lock.Unlock()
	if persist {
		g.persist()
	}
	if ended {
		g.changed()
	}
}

// ForgetBlock lets go of everything of a closed terminal: its requests, its lease and its sessions' modes.
func (g *Gate) ForgetBlock(blockId string) {
	g.lock.Lock()
	touched := false
	for id, e := range g.pending {
		if e.view.BlockId == blockId {
			delete(g.pending, id)
			g.takeLocked(e)
			touched = true
		}
	}
	delete(g.leases, blockId)
	delete(g.seen, blockId)
	persist := false
	for key, m := range g.modes {
		if m.view.BlockId == blockId {
			g.endModeLocked(key, m)
			persist = persist || m.view.Mode == ModeAlways
			touched = true
		}
	}
	g.lock.Unlock()
	if persist {
		g.persist()
	}
	if touched {
		g.changed()
	}
}

func (g *Gate) endModeLocked(key string, m *gateMode) {
	delete(g.modes, key)
	close(m.quit)
}

// SetMode sets what a session's requests get: ModeAsk ends the session's mode at once. The caller has checked that the
// terminal's agent can be answered, that the session is the one it runs now, and gives its run. A request the gate holds
// for the session is answered by the new mode.
func (g *Gate) SetMode(req GateModeRequest) GateModeResult {
	if req.BlockId == "" || !validSessionId(req.SessionId) {
		return GateModeResult{Status: ModeInvalid}
	}
	key := modeKey(req.BlockId, req.SessionId)
	switch req.Mode {
	case ModeAsk:
		g.stopMode(key)
		return GateModeResult{Status: ModeSet}
	case ModeFor, ModeAlways:
	default:
		return GateModeResult{Status: ModeInvalid}
	}
	if !req.Run.Known() {
		return GateModeResult{Status: ModeInvalid}
	}
	now := g.env.Now()
	view := Autonomy{
		BlockId: req.BlockId, SessionId: req.SessionId, Agent: req.Agent, Mode: req.Mode, Since: now.UnixMilli(),
		RunPid: req.Run.Pid, RunStart: req.Run.StartMs,
	}
	if req.Mode == ModeFor {
		end, ok := periodEnd(now, req.Period)
		if !ok {
			return GateModeResult{Status: ModeInvalid}
		}
		view.Until = end.UnixMilli()
	}
	m := &gateMode{view: view, quit: make(chan struct{})}
	answered := g.setMode(key, m)
	g.persist()
	if req.Mode == ModeFor {
		g.watchExpiry(key, m, time.UnixMilli(view.Until).Sub(now))
	}
	if g.env.Approved != nil {
		for _, e := range answered {
			g.env.Approved(e.view)
		}
	}
	g.changed()
	return GateModeResult{Status: ModeSet, Autonomy: g.autonomyOf(key)}
}

func (g *Gate) autonomyOf(key string) *Autonomy {
	g.lock.Lock()
	defer g.lock.Unlock()
	m := g.modes[key]
	if m == nil {
		return nil
	}
	view := m.view
	return &view
}

// setMode keeps the mode and allows the requests the session holds that can be read in full: the developer turned it on
// while looking at one. They count as approved; the caller logs them.
func (g *Gate) setMode(key string, m *gateMode) []*gateEntry {
	g.lock.Lock()
	defer g.lock.Unlock()
	if old := g.modes[key]; old != nil {
		g.endModeLocked(key, old)
	}
	g.modes[key] = m
	g.seen[m.view.BlockId] = m.view.run()
	var answered []*gateEntry
	for id, e := range g.pending {
		if e.view.State != RequestHeld || e.view.Clipped || e.view.BlockId != m.view.BlockId || !strings.EqualFold(e.view.SessionId, m.view.SessionId) {
			continue
		}
		delete(g.pending, id)
		e.answer <- gateDecision{decision: GateAllow}
		g.takeLocked(e)
		m.view.Approved++
		answered = append(answered, e)
	}
	return answered
}

func (g *Gate) stopMode(key string) {
	g.lock.Lock()
	m := g.modes[key]
	if m == nil {
		g.lock.Unlock()
		return
	}
	g.endModeLocked(key, m)
	g.lock.Unlock()
	g.persist()
	g.changed()
}

// watchExpiry ends a period's mode when its time comes: the windows then show "ask" again.
func (g *Gate) watchExpiry(key string, m *gateMode, d time.Duration) {
	timer, stop := g.env.Timer(d)
	go func() {
		defer func() {
			panichandler.PanicHandler("molten:keepawake:expiry", recover())
		}()
		defer stop()
		select {
		case <-timer:
			g.expire(key, m)
		case <-m.quit:
		}
	}()
}

// expire ends the mode when its time has come. A timer that goes off before the wall clock reaches the end (the clock was
// set back, the computer slept on a monotonic clock) leaves the mode and waits for the time that remains.
func (g *Gate) expire(key string, m *gateMode) {
	g.lock.Lock()
	if g.modes[key] != m {
		g.lock.Unlock()
		return
	}
	now := g.env.Now()
	if !m.expired(now) {
		left := time.UnixMilli(m.view.Until).Sub(now)
		g.lock.Unlock()
		if left > 0 {
			g.watchExpiry(key, m, left)
		}
		g.changed()
		return
	}
	g.endModeLocked(key, m)
	g.lock.Unlock()
	g.changed()
}

// Autonomous tells whether the requests of the run, of the session, are approved without asking now. An ended period is
// dropped, and so is a mode set in another run than the one that asks: a run that comes after the one the developer
// chose (`claude --continue`, `--resume`, `--session-id`) never inherits what it chose.
func (g *Gate) Autonomous(blockId string, sessionId string, run RunRef) bool {
	if blockId == "" || sessionId == "" || !run.Known() {
		return false
	}
	key := modeKey(blockId, sessionId)
	g.lock.Lock()
	m := g.modes[key]
	if m == nil {
		g.lock.Unlock()
		return false
	}
	now := g.env.Now()
	ended := m.expired(now) || !SameRun(m.view.run(), run)
	if !ended {
		g.seen[blockId] = run
		g.lock.Unlock()
		return true
	}
	g.endModeLocked(key, m)
	g.lock.Unlock()
	if m.view.Mode == ModeAlways {
		g.persist()
	}
	g.changed()
	return false
}

// NoteApproved counts a request the session's mode approved.
func (g *Gate) NoteApproved(blockId string, sessionId string) {
	g.lock.Lock()
	m := g.modes[modeKey(blockId, sessionId)]
	if m != nil {
		m.view.Approved++
	}
	g.lock.Unlock()
	if m != nil {
		g.changed()
	}
}

// persist keeps the "always" sessions, the only mode that survives a restart. The file is written outside the gate's
// lock, and in the order the changes were made: a write that comes after a newer one is dropped.
func (g *Gate) persist() {
	if g.env.SaveAlways == nil {
		return
	}
	g.lock.Lock()
	var always []Autonomy
	for _, m := range g.modes {
		if m.view.Mode == ModeAlways {
			always = append(always, m.view)
		}
	}
	sort.Slice(always, func(i, j int) bool { return always[i].Since < always[j].Since })
	g.saveSeq++
	seq := g.saveSeq
	g.lock.Unlock()
	g.saveLock.Lock()
	defer g.saveLock.Unlock()
	if seq < g.saved {
		return
	}
	g.saved = seq
	g.env.SaveAlways(always)
}

// periodEnd is when a period set at now ends.
func periodEnd(now time.Time, period string) (time.Time, bool) {
	switch period {
	case PeriodQuarter:
		return now.Add(15 * time.Minute), true
	case PeriodHour:
		return now.Add(time.Hour), true
	case PeriodFourHours:
		return now.Add(4 * time.Hour), true
	case PeriodTonight:
		return untilTonight(now), true
	}
	return time.Time{}, false
}

// untilTonight is the end of the evening: tonight's tonightHour, or the next morning once the evening is on (and
// through the small hours).
func untilTonight(now time.Time) time.Time {
	year, month, day := now.Date()
	loc := now.Location()
	switch hour := now.Hour(); {
	case hour < morningHour:
		return time.Date(year, month, day, morningHour, 0, 0, 0, loc)
	case hour < tonightFromHour:
		return time.Date(year, month, day, tonightHour, 0, 0, 0, loc)
	}
	return time.Date(year, month, day+1, morningHour, 0, 0, 0, loc)
}

// shownInput is the input as a window shows it: texts longer than maxShownText cut, which the agent's own copy never is.
func shownInput(input map[string]any) (map[string]any, bool) {
	if input == nil {
		return nil, false
	}
	clipped := false
	out, _ := clipValue(input, &clipped).(map[string]any)
	return out, clipped
}

func clipValue(v any, clipped *bool) any {
	switch value := v.(type) {
	case string:
		if utf8.RuneCountInString(value) <= maxShownText {
			return value
		}
		*clipped = true
		return string([]rune(value)[:maxShownText]) + "…"
	case map[string]any:
		rtn := make(map[string]any, len(value))
		for k, item := range value {
			rtn[k] = clipValue(item, clipped)
		}
		return rtn
	case []any:
		rtn := make([]any, len(value))
		for i, item := range value {
			rtn[i] = clipValue(item, clipped)
		}
		return rtn
	}
	return v
}
