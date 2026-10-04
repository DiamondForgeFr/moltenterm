// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"bytes"
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// The companion of a terminal block follows its agent's session while a view looks at it: each view opens it and
// renews its own lease; a follower without a live lease stops, and so does the one of a closed block.

// must match frontend/moltenterm-shell/companion/companion-model.ts
const (
	StatusLoading           = "loading"
	StatusNoAgent           = "noagent"
	StatusUnsupportedAgent  = "unsupportedagent"
	StatusRemote            = "remote"
	StatusSearching         = "searching"
	StatusChoose            = "choose"
	StatusLive              = "live"
	StatusUnsupportedFormat = "unsupportedformat"
	StatusError             = "error"

	LinkHook      = "hook"
	LinkPicked    = "picked"
	LinkDiscovery = "discovery"
)

const (
	tickInterval     = 250 * time.Millisecond
	leaseDuration    = 45 * time.Second
	discoverInterval = time.Second
	// While linked by discovery, a newer session of the same folder (Claude Code's /clear) is looked for this often.
	rediscoverInterval = 3 * time.Second
	blockInfoInterval  = 2 * time.Second
	// A hook reports its session after the agent started; a report older than the run is a previous run's.
	reportSlack = 5 * time.Second
	// A report for a block whose agent states know no run (no shell integration) holds this long.
	reportUntracked = 24 * time.Hour
	// A new agent writes its own session only at its first prompt: until then, another program's session of the
	// folder (an IDE's) would pass for a resumed one. The resumed-session rule waits this long after the agent started.
	resumeGrace  = 15 * time.Second
	maxReports   = 1000
	maxWatchers  = 16
	maxLeases    = 8
	maxCandidate = 10
	// Records larger than this are not decoded unless they may carry a file change: a tool's result only ends its
	// call, read from its id.
	largeRecordBytes = 1024 * 1024
)

var largeRecordMarkers = [][]byte{[]byte(`"structuredPatch"`), []byte(`"bashEditDiff"`), []byte(`"FileChange"`), []byte(`"patch_apply_begin"`)}
var resultIdRegex = regexp.MustCompile(`"(?:tool_use_id|call_id)"\s*:\s*"([^"]{1,200})"`)

type SessionInfo struct {
	Path     string `json:"path"`
	Format   string `json:"format,omitempty"`
	LinkedBy string `json:"linkedby"`
}

// CompanionView is what the companion view shows of a block; the earlier answers and the diffs are fetched on demand.
type CompanionView struct {
	BlockId    string       `json:"blockid"`
	Version    int64        `json:"version"`
	Status     string       `json:"status"`
	Agent      string       `json:"agent,omitempty"`
	AgentName  string       `json:"agentname,omitempty"`
	Message    string       `json:"message,omitempty"`
	Session    *SessionInfo `json:"session,omitempty"`
	Candidates []Candidate  `json:"candidates,omitempty"`
	// Ended: the agent no longer runs; the view shows its last session.
	Ended   bool         `json:"ended,omitempty"`
	Answers []AnswerInfo `json:"answers,omitempty"`
	// Latest: in an event, its markdown is left out (Elided) when the answer did not change since the last event.
	Latest  *AnswerView `json:"latest,omitempty"`
	Files   []FileInfo  `json:"files,omitempty"`
	Todos   []Todo      `json:"todos,omitempty"`
	Pending []ToolCall  `json:"pending,omitempty"`
}

type blockInfo struct {
	cwd    string
	remote bool
	term   bool
}

type sessionReport struct {
	agent string
	path  string
	at    time.Time
}

type sessionPick struct {
	agent   string
	started int64
	path    string
}

type sessionClaim struct {
	blockId string
	by      string
}

// Manager holds the followers of the blocks whose companion is open.
type Manager struct {
	lock     sync.Mutex
	watchers map[string]*watcher
	reports  map[string]sessionReport
	picks    map[string]sessionPick
	claims   map[string]sessionClaim
	version  int64

	// Injected: the agent states, the object store, the event bus and the clock; replaced in tests.
	runOf      func(blockId string) (molten.AgentRunInfo, bool)
	allRuns    func() []molten.AgentRunInfo
	blockInfo  func(blockId string) (blockInfo, error)
	publish    func(view CompanionView)
	adapterFor func(agent string) Adapter
	now        func() time.Time
	tick       time.Duration
}

func MakeManager() *Manager {
	return &Manager{
		watchers:   map[string]*watcher{},
		reports:    map[string]sessionReport{},
		picks:      map[string]sessionPick{},
		claims:     map[string]sessionClaim{},
		adapterFor: AdapterFor,
		now:        time.Now,
		tick:       tickInterval,
	}
}

func (m *Manager) nextVersion() int64 {
	m.lock.Lock()
	defer m.lock.Unlock()
	m.version++
	return m.version
}

// Open starts (or keeps) following a terminal block for one view and returns what is known now.
func (m *Manager) Open(blockId string, viewId string) (CompanionView, error) {
	if blockId == "" {
		return CompanionView{}, fmt.Errorf("no block")
	}
	if m.blockInfo != nil {
		if _, err := m.blockInfo(blockId); err != nil {
			return CompanionView{}, err
		}
	}
	w, err := m.lease(blockId, viewId)
	if err != nil {
		return CompanionView{}, err
	}
	return w.view(false), nil
}

func (m *Manager) lease(blockId string, viewId string) (*watcher, error) {
	m.lock.Lock()
	defer m.lock.Unlock()
	until := m.now().Add(leaseDuration)
	w := m.watchers[blockId]
	if w != nil {
		if w.leases[viewId].IsZero() && len(w.leases) >= maxLeases {
			return nil, fmt.Errorf("too many views of this companion")
		}
		w.leases[viewId] = until
		return w, nil
	}
	if len(m.watchers) >= maxWatchers {
		return nil, fmt.Errorf("too many companions open")
	}
	w = makeWatcher(m, blockId)
	w.leases[viewId] = until
	m.watchers[blockId] = w
	go w.loop()
	return w, nil
}

// leaseExpired drops the expired leases of a watcher; it tells whether the watcher must stop.
func (m *Manager) leaseExpired(w *watcher) bool {
	m.lock.Lock()
	defer m.lock.Unlock()
	if m.watchers[w.blockId] != w {
		return true
	}
	now := m.now()
	for id, until := range w.leases {
		if !now.Before(until) {
			delete(w.leases, id)
		}
	}
	if len(w.leases) > 0 {
		return false
	}
	delete(m.watchers, w.blockId)
	m.releaseClaimsLocked(w.blockId)
	return true
}

// Close ends one view's lease; the follower stops with its last view.
func (m *Manager) Close(blockId string, viewId string) {
	m.lock.Lock()
	defer m.lock.Unlock()
	w := m.watchers[blockId]
	if w == nil {
		return
	}
	delete(w.leases, viewId)
	if len(w.leases) == 0 {
		m.stopLocked(blockId)
	}
}

func (m *Manager) stopLocked(blockId string) {
	w := m.watchers[blockId]
	if w == nil {
		return
	}
	delete(m.watchers, blockId)
	m.releaseClaimsLocked(blockId)
	close(w.stop)
}

// ForgetBlock drops everything known of a closed block.
func (m *Manager) ForgetBlock(blockId string) {
	m.lock.Lock()
	defer m.lock.Unlock()
	m.stopLocked(blockId)
	delete(m.reports, blockId)
	delete(m.picks, blockId)
}

func (m *Manager) releaseClaimsLocked(blockId string) {
	for path, c := range m.claims {
		if c.blockId == blockId {
			delete(m.claims, path)
		}
	}
}

func (m *Manager) releaseClaims(blockId string) {
	m.lock.Lock()
	defer m.lock.Unlock()
	m.releaseClaimsLocked(blockId)
}

// claim links a transcript to a block. A link by discovery gives way to another block's hook report or pick; any
// other link of another block keeps the transcript.
func (m *Manager) claim(blockId string, path string, by string) bool {
	m.lock.Lock()
	defer m.lock.Unlock()
	if c, ok := m.claims[path]; ok && c.blockId != blockId {
		if c.by != LinkDiscovery || by == LinkDiscovery {
			return false
		}
	}
	m.releaseClaimsLocked(blockId)
	m.claims[path] = sessionClaim{blockId: blockId, by: by}
	return true
}

func (m *Manager) claimOwner(path string) string {
	m.lock.Lock()
	defer m.lock.Unlock()
	return m.claims[path].blockId
}

// reportCurrentLocked tells whether a block's report still speaks for its agent: not older than the block's run.
func (m *Manager) reportCurrentLocked(blockId string, r sessionReport) bool {
	if m.runOf != nil {
		if run, ok := m.runOf(blockId); ok {
			return !r.at.Before(time.UnixMilli(run.Started).Add(-reportSlack))
		}
	}
	return m.now().Sub(r.at) < reportUntracked
}

// takenByOther tells whether a transcript belongs to another block: followed by its companion, or reported by its
// agent's hook for its current run.
func (m *Manager) takenByOther(blockId string, path string) bool {
	m.lock.Lock()
	defer m.lock.Unlock()
	if c, ok := m.claims[path]; ok && c.blockId != blockId {
		return true
	}
	return m.reportedByOtherLocked(blockId, path)
}

func (m *Manager) reportedByOtherLocked(blockId string, path string) bool {
	for other, report := range m.reports {
		if other != blockId && report.path == path && m.reportCurrentLocked(other, report) {
			return true
		}
	}
	return false
}

// ReportSession takes a hook's report of the transcript of the agent in a block (`molten agent session`).
func (m *Manager) ReportSession(req molten.AgentSessionRequest) error {
	if req.BlockId == "" {
		return fmt.Errorf("molten agent session must run in a MoltenTerm terminal")
	}
	if m.blockInfo != nil {
		info, err := m.blockInfo(req.BlockId)
		if err != nil {
			return err
		}
		if info.remote {
			return fmt.Errorf("no companion for a remote terminal")
		}
	}
	agent := req.Agent
	if agent == "" && m.runOf != nil {
		if run, ok := m.runOf(req.BlockId); ok {
			agent = run.Agent
		}
	}
	if agent == "" {
		return fmt.Errorf("no agent is known in this terminal: name it with --agent")
	}
	adapter := m.adapterFor(agent)
	if adapter == nil {
		return fmt.Errorf("no companion exists for %s", molten.AgentDisplayName(agent))
	}
	path, err := ValidateSessionPath(adapter, req.Path)
	if err != nil {
		return err
	}
	m.lock.Lock()
	defer m.lock.Unlock()
	if m.reportedByOtherLocked(req.BlockId, path) {
		return fmt.Errorf("this session belongs to another terminal")
	}
	if _, ok := m.reports[req.BlockId]; !ok && len(m.reports) >= maxReports {
		m.evictOldestReportLocked()
	}
	m.reports[req.BlockId] = sessionReport{agent: agent, path: path, at: m.now()}
	if w := m.watchers[req.BlockId]; w != nil {
		w.poke()
	}
	return nil
}

func (m *Manager) evictOldestReportLocked() {
	oldestId := ""
	var oldest time.Time
	for id, r := range m.reports {
		if oldestId == "" || r.at.Before(oldest) {
			oldestId, oldest = id, r.at
		}
	}
	delete(m.reports, oldestId)
}

func (m *Manager) report(blockId string) (sessionReport, bool) {
	m.lock.Lock()
	defer m.lock.Unlock()
	r, ok := m.reports[blockId]
	return r, ok
}

// Pick links the session the user chose in the picker.
func (m *Manager) Pick(blockId string, viewId string, path string) (CompanionView, error) {
	w, err := m.lease(blockId, viewId)
	if err != nil {
		return CompanionView{}, err
	}
	run, ok := w.currentRun()
	if !ok {
		return CompanionView{}, fmt.Errorf("no agent runs in this terminal")
	}
	adapter := m.adapterFor(run.Agent)
	if adapter == nil {
		return CompanionView{}, fmt.Errorf("no companion exists for %s", molten.AgentDisplayName(run.Agent))
	}
	resolved, err := ValidateSessionPath(adapter, path)
	if err != nil {
		return CompanionView{}, err
	}
	if m.takenByOther(blockId, resolved) || !m.claim(blockId, resolved, LinkPicked) {
		return CompanionView{}, fmt.Errorf("this session belongs to another terminal")
	}
	m.lock.Lock()
	m.picks[blockId] = sessionPick{agent: run.Agent, started: run.Started, path: resolved}
	m.lock.Unlock()
	w.poke()
	return w.view(false), nil
}

func (m *Manager) pick(blockId string) (sessionPick, bool) {
	m.lock.Lock()
	defer m.lock.Unlock()
	p, ok := m.picks[blockId]
	return p, ok
}

func (m *Manager) watcher(blockId string) *watcher {
	m.lock.Lock()
	defer m.lock.Unlock()
	return m.watchers[blockId]
}

func (m *Manager) Answer(blockId string, index int) (AnswerView, error) {
	w := m.watcher(blockId)
	if w == nil {
		return AnswerView{}, fmt.Errorf("the companion of this terminal is not open")
	}
	return w.answer(index)
}

func (m *Manager) Diff(blockId string, path string) (FileDiff, error) {
	w := m.watcher(blockId)
	if w == nil {
		return FileDiff{}, fmt.Errorf("the companion of this terminal is not open")
	}
	return w.diff(path)
}

// sameFolderRuns counts the blocks running the same agent in the same folder (discovery cannot tell their sessions
// apart).
func (m *Manager) sameFolderRuns(agent string, cwd string) int {
	if m.allRuns == nil {
		return 1
	}
	count := 0
	for _, run := range m.allRuns() {
		if run.Agent != agent || !run.Running {
			continue
		}
		info, err := m.blockInfo(run.BlockId)
		if err != nil || info.remote || !samePath(info.cwd, cwd) {
			continue
		}
		count++
	}
	return count
}

// watcher follows one block's agent session.
type watcher struct {
	m       *Manager
	blockId string
	// leases, by view; guarded by the manager's lock.
	leases map[string]time.Time
	stop   chan struct{}
	wake   chan struct{}

	lock sync.Mutex
	// Guarded by lock: read by the commands while the loop updates them.
	status     string
	message    string
	agent      string
	runStarted int64
	hasRun     bool
	ended      bool
	path       string
	linkedBy   string
	session    *Session
	candidates []Candidate
	version    int64

	// The loop's own state.
	follower      *follower
	adapter       Adapter
	info          blockInfo
	infoAt        time.Time
	discoveredAt  time.Time
	linkedStarted int64
	// sawRun: the agent states knew this block's agent; a hook report alone then no longer makes a run.
	sawRun        bool
	published     string
	latestIndex   int
	latestRev     int64
	latestStarted bool
}

func makeWatcher(m *Manager, blockId string) *watcher {
	return &watcher{m: m, blockId: blockId, leases: map[string]time.Time{}, stop: make(chan struct{}), wake: make(chan struct{}, 1), status: StatusLoading}
}

func (w *watcher) poke() {
	select {
	case w.wake <- struct{}{}:
	default:
	}
}

func (w *watcher) currentRun() (molten.AgentRunInfo, bool) {
	w.lock.Lock()
	defer w.lock.Unlock()
	return molten.AgentRunInfo{BlockId: w.blockId, Agent: w.agent, Started: w.runStarted}, w.hasRun
}

func (w *watcher) loop() {
	defer func() {
		panichandler.PanicHandler("molten:companion", recover())
	}()
	defer w.closeFollower()
	ticker := time.NewTicker(w.m.tick)
	defer ticker.Stop()
	for {
		if w.m.leaseExpired(w) {
			return
		}
		more := w.step()
		w.publishIfChanged()
		if more {
			continue
		}
		select {
		case <-w.stop:
			return
		case <-w.wake:
		case <-ticker.C:
		}
	}
}

func (w *watcher) closeFollower() {
	if w.follower != nil {
		w.follower.close()
		w.follower = nil
	}
}

func (w *watcher) setStatus(status string, message string) {
	w.lock.Lock()
	defer w.lock.Unlock()
	if w.status == status && w.message == message {
		return
	}
	w.status, w.message = status, message
	w.version++
}

// resolveRun returns the agent the block runs: the agent states', else (a terminal without shell integration) the
// agent a hook reported a session for.
func (w *watcher) resolveRun() (molten.AgentRunInfo, bool) {
	if w.m.runOf != nil {
		if run, ok := w.m.runOf(w.blockId); ok {
			w.sawRun = true
			return run, true
		}
	}
	if w.sawRun {
		return molten.AgentRunInfo{}, false
	}
	if report, ok := w.m.report(w.blockId); ok {
		return molten.AgentRunInfo{BlockId: w.blockId, Agent: report.agent, Started: report.at.UnixMilli(), Running: true}, true
	}
	return molten.AgentRunInfo{}, false
}

func (w *watcher) refreshInfo(force bool) error {
	now := w.m.now()
	if !force && now.Sub(w.infoAt) < blockInfoInterval {
		return nil
	}
	info, err := w.m.blockInfo(w.blockId)
	if err != nil {
		return err
	}
	w.info, w.infoAt = info, now
	return nil
}

// step does one pass: which agent runs, which session is its, what was appended. It tells whether unread bytes
// remain.
func (w *watcher) step() bool {
	run, ok := w.resolveRun()
	if !ok {
		w.noRun()
		return false
	}
	w.lock.Lock()
	newRun := !w.hasRun || run.Agent != w.agent || run.Started != w.runStarted
	ended := !run.Running && w.path != ""
	if ended != w.ended {
		w.version++
	}
	w.hasRun, w.ended = true, ended
	if newRun {
		w.agent, w.runStarted = run.Agent, run.Started
		w.version++
	}
	w.lock.Unlock()
	if newRun {
		w.unlink()
		w.adapter = w.m.adapterFor(run.Agent)
		if err := w.refreshInfo(true); err != nil {
			w.setStatus(StatusError, "This terminal could not be read.")
			return false
		}
	}
	if w.adapter == nil {
		w.setStatus(StatusUnsupportedAgent, "")
		return false
	}
	if w.info.remote {
		w.setStatus(StatusRemote, "")
		return false
	}
	w.link(run)
	if w.follower == nil {
		return false
	}
	return w.read()
}

func (w *watcher) noRun() {
	w.lock.Lock()
	hadSession := w.path != ""
	if hadSession && !w.ended {
		w.ended = true
		w.version++
	}
	w.lock.Unlock()
	if hadSession {
		// The agent exited: its last session stays on screen, still followed (it may be resumed).
		if w.follower != nil {
			w.read()
		}
		return
	}
	w.setStatus(StatusNoAgent, "")
}

func (w *watcher) unlink() {
	w.closeFollower()
	w.m.releaseClaims(w.blockId)
	w.lock.Lock()
	defer w.lock.Unlock()
	w.path, w.linkedBy, w.session, w.candidates, w.ended = "", "", nil, nil, false
	w.linkedStarted = 0
	w.discoveredAt = time.Time{}
	w.version++
}

// link finds the session to follow, the most reliable source first: the agent hook's report, the user's pick, then
// discovery. A link by discovery gives way to a report or a pick, this block's or another's.
func (w *watcher) link(run molten.AgentRunInfo) {
	if w.follower != nil && w.m.claimOwner(w.path) != w.blockId {
		// Another terminal's hook or pick took the session discovery had linked here.
		w.unlink()
	}
	if report, ok := w.m.report(w.blockId); ok && report.agent == run.Agent && !report.at.Before(time.UnixMilli(run.Started).Add(-reportSlack)) {
		w.follow(report.path, LinkHook, 0)
		return
	}
	if pick, ok := w.m.pick(w.blockId); ok && pick.agent == run.Agent && pick.started == run.Started {
		w.follow(pick.path, LinkPicked, 0)
		return
	}
	now := w.m.now()
	interval := discoverInterval
	if w.follower != nil {
		interval = rediscoverInterval
	}
	if now.Sub(w.discoveredAt) < interval {
		return
	}
	w.discoveredAt = now
	w.refreshInfo(false)
	if w.info.cwd == "" {
		w.setStatus(StatusSearching, "This terminal's folder is not known yet.")
		return
	}
	var free []Candidate
	written := 0
	for _, c := range w.adapter.Discover(w.info.cwd, time.UnixMilli(run.Started)) {
		c.Path = canonicalPath(c.Path)
		if c.Modified >= run.Started {
			written++
		}
		if !w.m.takenByOther(w.blockId, c.Path) {
			free = append(free, c)
		}
	}
	runs := w.m.sameFolderRuns(run.Agent, w.info.cwd)
	if w.follower != nil {
		// Already linked by discovery: move only to the one session started after the linked one (a /clear).
		var newer []Candidate
		for _, c := range free {
			if c.Path != w.path && c.Started > w.linkedStarted {
				newer = append(newer, c)
			}
		}
		if len(newer) == 1 && runs <= 1 {
			w.follow(newer[0].Path, LinkDiscovery, newer[0].Started)
		}
		return
	}
	if now.Sub(time.UnixMilli(run.Started)) < resumeGrace {
		written = 0
	}
	chosen, ambiguous := chooseCandidate(free, written, run.Started, runs)
	if chosen != nil && !ambiguous {
		w.follow(chosen.Path, LinkDiscovery, chosen.Started)
		return
	}
	if len(free) == 0 {
		w.setCandidates(nil)
		w.setStatus(StatusSearching, "")
		return
	}
	if len(free) > maxCandidate {
		free = free[:maxCandidate]
	}
	w.setCandidates(free)
	w.setStatus(StatusChoose, "")
}

// canonicalPath resolves symlinks, so a session reached through two paths is claimed once.
func canonicalPath(path string) string {
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return path
	}
	return resolved
}

// chooseCandidate picks the session discovery may link without asking, when no other pane runs the same agent in the
// same folder: the only one started after the agent, else (a resumed session, which started before the agent) the
// only session of the folder written since the agent started, when no other terminal holds it. written counts the
// sessions written since the agent started, held by another terminal or not. Anything else is ambiguous: the user
// picks.
func chooseCandidate(free []Candidate, written int, runStarted int64, runsInFolder int) (*Candidate, bool) {
	if len(free) == 0 {
		return nil, false
	}
	if runsInFolder > 1 {
		return nil, true
	}
	var after []Candidate
	for _, c := range free {
		if c.Started != 0 && c.Started >= runStarted-startSlack.Milliseconds() {
			after = append(after, c)
		}
	}
	if len(after) == 1 {
		return &after[0], false
	}
	if len(after) == 0 && written == 1 && len(free) == 1 && free[0].Modified >= runStarted {
		return &free[0], false
	}
	return nil, true
}

func (w *watcher) setCandidates(list []Candidate) {
	w.lock.Lock()
	defer w.lock.Unlock()
	if candidatesEqual(w.candidates, list) {
		return
	}
	w.candidates = list
	w.version++
}

func candidatesEqual(a []Candidate, b []Candidate) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Path != b[i].Path || a[i].Modified != b[i].Modified {
			return false
		}
	}
	return true
}

func (w *watcher) follow(path string, linkedBy string, started int64) {
	w.lock.Lock()
	same := w.path == path && w.follower != nil
	if same && w.linkedBy != linkedBy {
		w.linkedBy = linkedBy
		w.version++
	}
	w.lock.Unlock()
	if same {
		w.m.claim(w.blockId, path, linkedBy)
		return
	}
	// Every path is checked again, discovered ones included: under the agent's session root, no symlink.
	resolved, err := ValidateSessionPath(w.adapter, path)
	if err != nil {
		w.setStatus(StatusSearching, "The session transcript cannot be read: "+err.Error())
		return
	}
	if !w.m.claim(w.blockId, resolved, linkedBy) {
		w.setStatus(StatusSearching, "This session is followed by another terminal.")
		return
	}
	w.closeFollower()
	f, err := openFollower(resolved)
	if err != nil {
		w.m.releaseClaims(w.blockId)
		w.setStatus(StatusSearching, "The session transcript could not be opened.")
		return
	}
	w.follower = f
	w.linkedStarted = started
	w.lock.Lock()
	defer w.lock.Unlock()
	w.path, w.linkedBy, w.session, w.candidates = resolved, linkedBy, MakeSession(), nil
	w.status, w.message = StatusLoading, ""
	w.version++
}

// parseLine reads one record into the session. A very large record (a tool's whole output) is decoded only when it
// may carry a file change; otherwise only the call it ends is read from it.
func (w *watcher) parseLine(s *Session, line []byte) {
	if len(line) > largeRecordBytes {
		carries := false
		for _, marker := range largeRecordMarkers {
			if bytes.Contains(line, marker) {
				carries = true
				break
			}
		}
		if !carries {
			if m := resultIdRegex.FindSubmatch(line); m != nil {
				s.ResolveTool(string(m[1]))
			}
			s.countLine(true, true)
			return
		}
	}
	var rec map[string]any
	if json.Unmarshal(line, &rec) != nil {
		s.countLine(false, false)
		return
	}
	s.countLine(true, w.adapter.Parse(rec, s))
}

// read parses what was appended to the transcript. The lock is held per chunk (tailChunkMax), so the commands wait
// at most one chunk's parsing.
func (w *watcher) read() bool {
	w.lock.Lock()
	defer w.lock.Unlock()
	reset, more, err := w.follower.poll(func(line []byte) {
		w.parseLine(w.session, line)
	})
	if reset {
		// Replaced or truncated: read it again from the start, into a new session.
		w.session = MakeSession()
		w.version++
		return true
	}
	if err != nil {
		w.follower.close()
		w.follower = nil
		w.path = ""
		w.status, w.message = StatusSearching, "The session transcript is no longer readable."
		w.version++
		w.m.releaseClaims(w.blockId)
		return false
	}
	status, message := StatusLive, ""
	if more {
		status = StatusLoading
	}
	if w.session.Unsupported() {
		status = StatusUnsupportedFormat
		message = w.session.Format
	}
	if w.status != status || w.message != message {
		w.status, w.message = status, message
		w.version++
	}
	return more
}

func (w *watcher) viewKey() string {
	w.lock.Lock()
	defer w.lock.Unlock()
	sv := int64(0)
	if w.session != nil {
		sv = w.session.Version
	}
	return fmt.Sprintf("%d/%d", w.version, sv)
}

func (w *watcher) publishIfChanged() {
	if w.m.publish == nil {
		return
	}
	key := w.viewKey()
	if key == w.published {
		return
	}
	w.published = key
	w.m.publish(w.view(true))
}

// view builds what the companion shows. For an event (elide), the latest answer's markdown is left out when it did
// not change since the previous event: the view keeps its copy (or asks for it when it missed one).
func (w *watcher) view(elide bool) CompanionView {
	w.lock.Lock()
	defer w.lock.Unlock()
	v := CompanionView{
		BlockId:    w.blockId,
		Version:    w.m.nextVersion(),
		Status:     w.status,
		Agent:      w.agent,
		Message:    w.message,
		Ended:      w.ended,
		Candidates: w.candidates,
	}
	if w.agent != "" {
		v.AgentName = molten.AgentDisplayName(w.agent)
	}
	if w.path == "" || w.session == nil {
		return v
	}
	v.Session = &SessionInfo{Path: w.path, Format: w.session.Format, LinkedBy: w.linkedBy}
	if w.status == StatusUnsupportedFormat {
		return v
	}
	v.Answers = w.session.Answers()
	if latest, ok := w.session.Answer(0); ok {
		if elide {
			if w.latestStarted && latest.Index == w.latestIndex && latest.Rev == w.latestRev {
				latest.Markdown = ""
				latest.Elided = true
			}
			w.latestStarted, w.latestIndex, w.latestRev = true, latest.Index, latest.Rev
		}
		v.Latest = &latest
	}
	v.Files = w.session.Files()
	v.Todos = w.session.Todos()
	v.Pending = w.session.Pending()
	return v
}

func (w *watcher) answer(index int) (AnswerView, error) {
	w.lock.Lock()
	defer w.lock.Unlock()
	if w.session == nil {
		return AnswerView{}, fmt.Errorf("no session")
	}
	a, ok := w.session.Answer(index)
	if !ok {
		return AnswerView{}, fmt.Errorf("this answer is no longer kept")
	}
	return a, nil
}

func (w *watcher) diff(path string) (FileDiff, error) {
	w.lock.Lock()
	defer w.lock.Unlock()
	if w.session == nil {
		return FileDiff{}, fmt.Errorf("no session")
	}
	d, ok := w.session.Diff(path)
	if !ok {
		return FileDiff{}, fmt.Errorf("no change of this file in the session")
	}
	return d, nil
}

// OpenBlocks lists the blocks followed now (tests, diagnostics).
func (m *Manager) OpenBlocks() []string {
	m.lock.Lock()
	defer m.lock.Unlock()
	rtn := make([]string, 0, len(m.watchers))
	for id := range m.watchers {
		rtn = append(rtn, id)
	}
	sort.Strings(rtn)
	return rtn
}
