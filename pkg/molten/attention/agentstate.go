// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package attention

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// Agent states (FR-SHELL-011, DS-SHELL-011). wavesrv keeps, per terminal block, the coding agent running in it and
// its state. Sources, from the most to the least precise:
//   - the agent's own hooks, through `molten agent state` (AgentStateSetCommand);
//   - the attention signals of DS-SHELL-004 (bell, OSC 9, OSC 777): the agent waits for the user, or says it is done;
//   - the shell integration's command lifecycle (OSC 16162 C, D, A): the agent starts, exits, fails;
//   - the pane's output activity (agentactivity.go), for an agent whose hooks never reported in the pane: working
//     while its output keeps coming, idle once it stays quiet.
// An agent that started, or that the user answered, may as well sit at its prompt, and nothing would end a guessed
// working state (no turn ends after `/clear`): working comes from a hook, or from output that ends it by stopping.
// Enter typed in a pane whose agent waits (or is done) means the user answered: the dot goes back to idle. Nothing is
// read from the screen: the output activity uses only when output comes, never what it says. States live in memory
// only: a restart starts over, as the agents' processes do.

const (
	ShellMarkCommand = "C"
	ShellMarkDone    = "D"
	ShellMarkPrompt  = "A"

	// A hook's notification and the agent's own OSC signal for the same event make one notification.
	agentNoticeWindow  = AttentionDedup
	agentLocateTimeout = 5 * time.Second
	agentSigint        = 130
)

const (
	noticeFromSignal = "signal"
	noticeFromHook   = "hook"
)

const (
	sourceCommand = "command"
	sourceHook    = "hook"
	sourceProcess = "process"
)

// ShellMark is one shell integration mark (OSC 16162) wavesrv needs: a command starts (with its command line), ends
// (with its exit code) or the prompt is back.
type ShellMark struct {
	Kind     string
	Cmd      string
	ExitCode *int
}

var cmd64Regex = regexp.MustCompile(`"cmd64"\s*:\s*"([A-Za-z0-9+/=]*)`)

// ParseShellMark reads an OSC 16162 payload ("16162;C;{"cmd64":"..."}", "16162;D;{"exitcode":0}", "16162;A").
func ParseShellMark(payload string) (ShellMark, bool) {
	rest, found := strings.CutPrefix(payload, "16162;")
	if !found {
		return ShellMark{}, false
	}
	kind, data, _ := strings.Cut(rest, ";")
	switch kind {
	case ShellMarkPrompt:
		return ShellMark{Kind: kind}, true
	case ShellMarkCommand:
		return ShellMark{Kind: kind, Cmd: decodeCmd64(data)}, true
	case ShellMarkDone:
		var d struct {
			ExitCode *int `json:"exitcode"`
		}
		json.Unmarshal([]byte(data), &d)
		return ShellMark{Kind: kind, ExitCode: d.ExitCode}, true
	}
	return ShellMark{}, false
}

// A long command line is cut by the scanner's limit: its JSON no longer parses, but the start of its base64 still
// names the command.
func decodeCmd64(data string) string {
	m := cmd64Regex.FindStringSubmatch(data)
	if m == nil {
		return ""
	}
	enc := m[1]
	if len(enc)%4 != 0 {
		enc = enc[:len(enc)/4*4]
	}
	out, err := base64.StdEncoding.DecodeString(enc)
	if err != nil {
		return ""
	}
	return string(out)
}

type agentRecord struct {
	agent   string
	state   string
	message string
	since   int64
	version int64
	// started: when the agent's command started (or its first report came), for the companion's session discovery.
	started int64
	// running: the agent's command still runs (an exited agent keeps its error until the next command).
	running bool
	located bool
	tabId   string
	wsId    string
	// source: what made the record (the command line, a hook, the process tree); pid: the agent's process when the
	// process tree found it.
	source string
	pid    int32
	// fromActivity: the working state came from the pane's output activity (agentactivity.go), which also ends it.
	fromActivity bool
}

type noticeMark struct {
	at     time.Time
	source string
}

type agentStates struct {
	lock    sync.Mutex
	records map[string]*agentRecord
	// Blocks whose state changed since the publisher's last pass.
	dirty   map[string]bool
	version int64
	notices map[string]noticeMark
	panes   map[string]*paneActivity
	// hookedAgents: the agents whose hooks reported in this run; onHooked is told of each once (agenthookoffer.go).
	hookedAgents map[string]bool
	onHooked     func(agent string)
	wake         chan struct{}
	now          func() time.Time
	// Injected: wavesrv's object store and event bus, replaced in tests.
	locate  func(blockId string) (string, string, error)
	publish func(info molten.AgentStateInfo)
	notify  func(blockId string, signal AttentionSignal, kind string)
	// procs: the process-tree watcher (procwatch.go), told when commands start and end; nil in tests.
	procs *procWatcher
}

func makeAgentStates() *agentStates {
	return &agentStates{
		records:      map[string]*agentRecord{},
		dirty:        map[string]bool{},
		notices:      map[string]noticeMark{},
		panes:        map[string]*paneActivity{},
		hookedAgents: map[string]bool{},
		wake:         make(chan struct{}, 1),
		now:          time.Now,
		locate:       locateBlock,
		publish:      publishAgentState,
		notify: func(blockId string, signal AttentionSignal, kind string) {
			go recordAgentNotice(blockId, signal, kind)
		},
	}
}

var defaultAgentStates = makeDefaultAgentStates()

// Only wavesrv's own states remember hooked agents in the data folder; tests' states do not.
func makeDefaultAgentStates() *agentStates {
	a := makeAgentStates()
	a.onHooked = func(agent string) {
		go rememberHookedAgent(agent)
	}
	return a
}

var defaultProcWatcher = makeDefaultProcWatcher()

func makeDefaultProcWatcher() *procWatcher {
	w := makeProcWatcher(defaultAgentStates)
	defaultAgentStates.procs = w
	return w
}

func (a *agentStates) markDirtyLocked(blockId string) {
	a.version++
	if rec := a.records[blockId]; rec != nil {
		rec.version = a.version
	}
	a.dirty[blockId] = true
	select {
	case a.wake <- struct{}{}:
	default:
	}
}

func (a *agentStates) setStateLocked(blockId string, rec *agentRecord, state string, message string) bool {
	if rec.state == state && rec.message == message {
		return false
	}
	if rec.state != state {
		rec.since = a.now().UnixMilli()
		rec.fromActivity = false
	}
	rec.state = state
	rec.message = message
	a.markDirtyLocked(blockId)
	return true
}

func (a *agentStates) removeLocked(blockId string) {
	if a.records[blockId] == nil {
		return
	}
	delete(a.records, blockId)
	a.markDirtyLocked(blockId)
}

func (a *agentStates) shellMark(blockId string, mark ShellMark) {
	if a.procs == nil {
		a.applyShellMark(blockId, mark)
		return
	}
	a.procs.shellMark(blockId, mark.Kind, func() { a.applyShellMark(blockId, mark) })
}

func (a *agentStates) applyShellMark(blockId string, mark ShellMark) {
	a.lock.Lock()
	defer a.lock.Unlock()
	rec := a.records[blockId]
	switch mark.Kind {
	case ShellMarkCommand:
		agent := molten.MatchAgentCommand(mark.Cmd)
		if agent == "" {
			a.removeLocked(blockId)
			return
		}
		now := a.now().UnixMilli()
		a.records[blockId] = &agentRecord{agent: agent, state: molten.AgentStateIdle, since: now, started: now, running: true, source: sourceCommand}
		a.markDirtyLocked(blockId)
	case ShellMarkDone:
		if rec == nil || !rec.running {
			return
		}
		if mark.ExitCode != nil && *mark.ExitCode != 0 && *mark.ExitCode != agentSigint {
			rec.running = false
			a.setStateLocked(blockId, rec, molten.AgentStateError, fmt.Sprintf("Exited with code %d", *mark.ExitCode))
			return
		}
		a.removeLocked(blockId)
	case ShellMarkPrompt:
		// The prompt without the end of the command (an older shell integration, a killed agent).
		if rec != nil && rec.running {
			a.removeLocked(blockId)
		}
	}
}

func (a *agentStates) attention(blockId string, signal AttentionSignal) {
	a.lock.Lock()
	defer a.lock.Unlock()
	rec := a.records[blockId]
	if rec == nil || !rec.running {
		return
	}
	a.setStateLocked(blockId, rec, molten.AttentionAgentState(signal.Title, signal.Message), "")
}

// input sees what the user types in a terminal: Enter in a pane whose agent waits (or is done) is an answer. The
// agent's UserPromptSubmit hook, if any, reports working right after.
func (a *agentStates) input(blockId string, data []byte) {
	now := a.now()
	a.lock.Lock()
	defer a.lock.Unlock()
	a.typedLocked(blockId, now)
	if !bytes.ContainsAny(data, "\r\n") {
		return
	}
	rec := a.records[blockId]
	if rec == nil || !rec.running {
		return
	}
	switch rec.state {
	case molten.AgentStateWaiting, molten.AgentStateDone:
		a.setStateLocked(blockId, rec, molten.AgentStateIdle, "")
	}
}

// report applies a hook's report; it returns the notification to raise, if any.
func (a *agentStates) report(req molten.AgentStateRequest) (*AttentionSignal, string, error) {
	if !molten.ValidAgentState(req.State) {
		return nil, "", fmt.Errorf("unknown state %q (working, waiting, done, error or idle)", req.State)
	}
	if req.Agent != "" && !molten.ValidAgentId(req.Agent) {
		return nil, "", fmt.Errorf("invalid agent name %q", req.Agent)
	}
	message := molten.CleanAgentMessage(req.Message)
	a.lock.Lock()
	defer a.lock.Unlock()
	rec := a.records[req.BlockId]
	if rec == nil {
		if req.Agent == "" {
			return nil, "", fmt.Errorf("no agent is known in this terminal: name it with --agent")
		}
		rec = &agentRecord{agent: req.Agent, running: true, started: a.now().UnixMilli(), source: sourceHook}
		a.records[req.BlockId] = rec
	}
	rec.running = true
	previous := rec.state
	if req.Agent != "" && req.Agent != rec.agent {
		rec.agent = req.Agent
		rec.started = a.now().UnixMilli()
		rec.located = false
		rec.source = sourceHook
		rec.pid = 0
		a.markDirtyLocked(req.BlockId)
	}
	a.hookedLocked(req.BlockId, rec.agent)
	a.agentHookedLocked(rec.agent)
	rec.fromActivity = false
	a.setStateLocked(req.BlockId, rec, req.State, message)
	if previous == req.State || (req.State != molten.AgentStateWaiting && req.State != molten.AgentStateDone) {
		return nil, "", nil
	}
	if !a.allowNoticeLocked(req.BlockId, noticeFromHook) {
		return nil, "", nil
	}
	name := molten.AgentDisplayName(rec.agent)
	if req.State == molten.AgentStateWaiting {
		return &AttentionSignal{Title: name + " is waiting for you", Message: message}, "warning", nil
	}
	return &AttentionSignal{Title: name + " is done", Message: message}, "success", nil
}

// allowNotice tells whether a notification for the block may be raised now: not when the other source (a hook, or
// the agent's own signal) raised one for the same moment.
func (a *agentStates) allowNotice(blockId string, source string) bool {
	a.lock.Lock()
	defer a.lock.Unlock()
	return a.allowNoticeLocked(blockId, source)
}

func (a *agentStates) allowNoticeLocked(blockId string, source string) bool {
	now := a.now()
	last, ok := a.notices[blockId]
	if ok && last.source != source && now.Sub(last.at) < agentNoticeWindow {
		return false
	}
	a.notices[blockId] = noticeMark{at: now, source: source}
	return true
}

func (a *agentStates) forget(blockId string) {
	a.forgetRecord(blockId)
	if a.procs != nil {
		a.procs.forget(blockId)
	}
}

func (a *agentStates) forgetRecord(blockId string) {
	a.lock.Lock()
	defer a.lock.Unlock()
	delete(a.notices, blockId)
	delete(a.panes, blockId)
	a.removeLocked(blockId)
}

// processAgent applies what the process tree says of a terminal (procwatch.go). found: the agent running in its
// foreground, if any; its state is unknown, idle until a signal. A hook's agent is kept; a command line's guess gives
// way to the process actually running.
func (a *agentStates) processAgent(blockId string, found molten.AgentProcess, ok bool) {
	a.lock.Lock()
	defer a.lock.Unlock()
	rec := a.records[blockId]
	if !ok {
		if rec != nil && rec.running && rec.source == sourceProcess {
			a.removeLocked(blockId)
		}
		return
	}
	if rec != nil && rec.running {
		// The same agent in a new process, with no command seen in between, is a new run (a block command restarted).
		newProcess := rec.source == sourceProcess && rec.pid != 0 && rec.pid != found.Pid
		if (rec.agent == found.Agent && !newProcess) || rec.source == sourceHook {
			rec.pid = found.Pid
			return
		}
	}
	now := a.now().UnixMilli()
	started := found.StartMs
	if started <= 0 || started > now {
		started = now
	}
	a.records[blockId] = &agentRecord{agent: found.Agent, state: molten.AgentStateIdle, since: now, started: started, running: true, source: sourceProcess, pid: found.Pid}
	a.markDirtyLocked(blockId)
}

func (a *agentStates) infoLocked(blockId string, rec *agentRecord) molten.AgentStateInfo {
	return molten.AgentStateInfo{
		BlockId:     blockId,
		TabId:       rec.tabId,
		WorkspaceId: rec.wsId,
		Agent:       rec.agent,
		AgentName:   molten.AgentDisplayName(rec.agent),
		State:       rec.state,
		Message:     rec.message,
		Since:       rec.since,
		Version:     rec.version,
		Hooked:      a.hookedAgents[rec.agent],
	}
}

// agentHookedLocked notes the first report of an agent's hooks: every terminal running it is published again, so
// their headers drop the hook setup offer.
func (a *agentStates) agentHookedLocked(agent string) {
	if a.hookedAgents[agent] {
		return
	}
	a.hookedAgents[agent] = true
	for blockId, rec := range a.records {
		if rec.agent == agent {
			a.markDirtyLocked(blockId)
		}
	}
	if a.onHooked != nil {
		a.onHooked(agent)
	}
}

func (a *agentStates) isAgentHooked(agent string) bool {
	a.lock.Lock()
	defer a.lock.Unlock()
	return a.hookedAgents[agent]
}

func (a *agentStates) snapshot() []molten.AgentStateInfo {
	a.lock.Lock()
	defer a.lock.Unlock()
	rtn := make([]molten.AgentStateInfo, 0, len(a.records))
	for blockId, rec := range a.records {
		rtn = append(rtn, a.infoLocked(blockId, rec))
	}
	sort.Slice(rtn, func(i, j int) bool { return rtn[i].BlockId < rtn[j].BlockId })
	return rtn
}

type pendingState struct {
	blockId string
	info    molten.AgentStateInfo
	locate  bool
}

func (a *agentStates) takeDirty() []pendingState {
	a.lock.Lock()
	defer a.lock.Unlock()
	var rtn []pendingState
	for blockId := range a.dirty {
		rec := a.records[blockId]
		if rec == nil {
			rtn = append(rtn, pendingState{blockId: blockId, info: molten.AgentStateInfo{BlockId: blockId, Version: a.version, Cleared: true}})
			continue
		}
		rtn = append(rtn, pendingState{blockId: blockId, info: a.infoLocked(blockId, rec), locate: !rec.located})
	}
	a.dirty = map[string]bool{}
	sort.Slice(rtn, func(i, j int) bool { return rtn[i].info.Version < rtn[j].info.Version })
	return rtn
}

// storeLocation keeps where the block is for the rest of its agent's run (a new run looks again: the pane may have
// moved to another tab).
func (a *agentStates) storeLocation(blockId string, tabId string, wsId string) {
	a.lock.Lock()
	defer a.lock.Unlock()
	rec := a.records[blockId]
	if rec == nil {
		return
	}
	rec.tabId, rec.wsId, rec.located = tabId, wsId, true
}

// flush publishes the blocks that changed, in the order they changed. The location is looked up once per agent run,
// off the output path.
func (a *agentStates) flush() {
	for _, p := range a.takeDirty() {
		if p.locate {
			tabId, wsId, err := a.locate(p.blockId)
			if err == nil {
				a.storeLocation(p.blockId, tabId, wsId)
				p.info.TabId, p.info.WorkspaceId = tabId, wsId
			}
		}
		a.publish(p.info)
	}
}

func (a *agentStates) run() {
	defer func() {
		panichandler.PanicHandler("molten:agentStates", recover())
	}()
	for range a.wake {
		a.flush()
	}
}

func locateBlock(blockId string) (string, string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), agentLocateTimeout)
	defer cancel()
	tabId, err := wstore.DBFindTabForBlockId(ctx, blockId)
	if err != nil {
		return "", "", err
	}
	wsId, err := wstore.DBFindWorkspaceForTabId(ctx, tabId)
	if err != nil {
		return tabId, "", nil
	}
	return tabId, wsId, nil
}

func publishAgentState(info molten.AgentStateInfo) {
	scopes := []string{waveobj.MakeORef(waveobj.OType_Block, info.BlockId).String()}
	if info.WorkspaceId != "" {
		scopes = append(scopes, waveobj.MakeORef(waveobj.OType_Workspace, info.WorkspaceId).String())
	}
	wps.Broker.Publish(wps.WaveEvent{Event: molten.AgentStateEvent, Scopes: scopes, Data: info})
}

// TerminalInput is called with what the user sends to a terminal (blockcontroller.SendInput).
func TerminalInput(blockId string, data []byte) {
	defaultAgentStates.input(blockId, data)
}

// TerminalResize is called when a terminal is resized (blockcontroller.SendInput): the redraw that follows is, like
// the echo of what the user types, no output activity.
func TerminalResize(blockId string) {
	defaultAgentStates.resized(blockId)
}

// ReportAgentState applies a report of `molten agent state` for a terminal block.
func ReportAgentState(ctx context.Context, req molten.AgentStateRequest) error {
	if req.BlockId == "" {
		return fmt.Errorf("molten agent state must run in a MoltenTerm terminal")
	}
	block, err := wstore.DBGet[*waveobj.Block](ctx, req.BlockId)
	if err != nil {
		return err
	}
	if block == nil || block.Meta.GetString(waveobj.MetaKey_View, "") != "term" {
		return fmt.Errorf("block %s is not a terminal", req.BlockId)
	}
	signal, kind, err := defaultAgentStates.report(req)
	if err != nil {
		return err
	}
	if signal != nil {
		defaultAgentStates.notify(req.BlockId, *signal, kind)
	}
	return nil
}

// AgentRun tells which agent runs in a terminal block and since when (the agent companion, DS-SHELL-019).
func AgentRun(blockId string) (molten.AgentRunInfo, bool) {
	return defaultAgentStates.runOf(blockId)
}

// AgentRuns lists the agents running in every terminal block.
func AgentRuns() []molten.AgentRunInfo {
	return defaultAgentStates.allRuns()
}

func (a *agentStates) runOf(blockId string) (molten.AgentRunInfo, bool) {
	a.lock.Lock()
	defer a.lock.Unlock()
	rec := a.records[blockId]
	if rec == nil {
		return molten.AgentRunInfo{}, false
	}
	return molten.AgentRunInfo{BlockId: blockId, Agent: rec.agent, Started: rec.started, Running: rec.running, State: rec.state}, true
}

func (a *agentStates) allRuns() []molten.AgentRunInfo {
	a.lock.Lock()
	defer a.lock.Unlock()
	rtn := make([]molten.AgentRunInfo, 0, len(a.records))
	for blockId, rec := range a.records {
		rtn = append(rtn, molten.AgentRunInfo{BlockId: blockId, Agent: rec.agent, Started: rec.started, Running: rec.running, State: rec.state})
	}
	return rtn
}

func AgentStatesSnapshot() []molten.AgentStateInfo {
	return defaultAgentStates.snapshot()
}

// ForgetBlock drops what is known of a closed block.
func ForgetBlock(blockId string) {
	defaultAttentionWatcher.forget(blockId)
	defaultAgentStates.forget(blockId)
	defaultIntegrationReports.forget(blockId)
}

var startOnce sync.Once

// StartAgentStates starts the publisher; wavesrv calls it once at startup.
func StartAgentStates() {
	startOnce.Do(func() {
		go defaultAgentStates.run()
		go defaultAgentStates.runSettle()
		defaultProcWatcher.locator = getShellLocator()
		go defaultProcWatcher.run()
	})
}
