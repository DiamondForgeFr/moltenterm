// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/proctree"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
	"github.com/wavetermdev/waveterm/pkg/molten/usage"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
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
	StatusLive              = "live"
	StatusUnsupportedFormat = "unsupportedformat"
	StatusError             = "error"

	LinkHook      = "hook"
	LinkPicked    = "picked"
	LinkDiscovery = "discovery"
	// LinkProcess: the agent's own process holds the transcript open (processlink.go, #799).
	LinkProcess = "process"
	// LinkGuessed: discovery could not tell, the companion chose the likeliest session (guess.go).
	LinkGuessed = "guessed"
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
	resumeGrace = 15 * time.Second
	maxReports  = 1000
	maxWatchers = 16
	maxLeases   = 8
	// The companion's history lists at most this many sessions.
	maxHistory = 30
	// The sessions a pane showed before its current one, kept per pane while wavesrv runs (#600).
	maxEarlier = 10
	// How often the background agents whose end was never recorded are checked for activity.
	subagentSweepInterval = time.Minute
	// Records larger than this are not decoded unless they may carry a file change: a tool's result only ends its
	// call, read from its id.
	largeRecordBytes = 1024 * 1024
)

// Without a running agent to follow (none, an ended one, a remote or unsupported one), the companion waits for its agent
// state to change (Poke), and looks again this often for what raises no event (FR-PERF-011).
const idleTickInterval = 2 * time.Second

var largeRecordMarkers = [][]byte{[]byte(`"structuredPatch"`), []byte(`"bashEditDiff"`), []byte(`"FileChange"`), []byte(`"patch_apply_begin"`)}
var asyncLaunchedMarker = []byte(`"async_launched"`)
var taskNotificationMarker = []byte(`<task-notification>`)
var resultIdRegex = regexp.MustCompile(`"(?:tool_use_id|call_id)"\s*:\s*"([^"]{1,200})"`)

type SessionInfo struct {
	Path     string `json:"path"`
	Format   string `json:"format,omitempty"`
	LinkedBy string `json:"linkedby"`
	// Guess: how a guessed session was chosen (GuessStarted, GuessActivity, GuessRecent).
	Guess string `json:"guess,omitempty"`
	// Title: the session's first real prompt (FR-SHELL-039); Command: its first slash command, the title until then.
	Title   string `json:"title,omitempty"`
	Command string `json:"command,omitempty"`
	Started int64  `json:"started,omitempty"`
	// Name: the agent's own name of the session (Claude Code's title, or the user's /rename), when it gave one.
	Name string `json:"name,omitempty"`
	// Branch: the branch the agent's records last named.
	Branch string `json:"branch,omitempty"`
	// Model, Effort: the main agent's as its latest answer records them (the status line's win in the view, #549).
	Model  string `json:"model,omitempty"`
	Effort string `json:"effort,omitempty"`
	// Ticket, Complexity: the ticket the main agent works on and its complexity label (#601).
	Ticket     int    `json:"ticket,omitempty"`
	Complexity string `json:"complexity,omitempty"`
	// Earlier: the user chose an earlier session of the pane in the history; the agent's hook reported a newer one.
	Earlier bool `json:"earlier,omitempty"`
	// LivePath: with Earlier, the session the agent runs now.
	LivePath string `json:"livepath,omitempty"`
}

// EarlierSession is a session the pane showed before the one it shows now (a /clear, a resume, another agent run).
type EarlierSession struct {
	Path    string `json:"path"`
	Title   string `json:"title,omitempty"`
	Command string `json:"command,omitempty"`
	Started int64  `json:"started,omitempty"`
	// Until: when the pane moved on from it.
	Until int64 `json:"until,omitempty"`
}

// CompanionView is what the companion view shows of a block; the earlier answers and the diffs are fetched on demand.
type CompanionView struct {
	BlockId   string `json:"blockid"`
	Version   int64  `json:"version"`
	Status    string `json:"status"`
	Agent     string `json:"agent,omitempty"`
	AgentName string `json:"agentname,omitempty"`
	Message   string `json:"message,omitempty"`
	// MessageText: Message's code for the windows (#656), none for the unsupported format's name.
	MessageText *uimsg.Text  `json:"messagetext,omitempty"`
	Session     *SessionInfo `json:"session,omitempty"`
	// Ended: the agent no longer runs; the view shows its last session.
	Ended   bool         `json:"ended,omitempty"`
	Answers []AnswerInfo `json:"answers,omitempty"`
	// Latest: in an event, its markdown is left out (Elided) when the answer did not change since the last event.
	Latest  *AnswerView `json:"latest,omitempty"`
	Files   []FileInfo  `json:"files,omitempty"`
	Todos   []Todo      `json:"todos,omitempty"`
	Pending []ToolCall  `json:"pending,omitempty"`
	// Usage: the agent's usage page when it has a usage adapter (FR-SHELL-026); the view holds no URL of its own.
	Usage *usage.UsagePage `json:"usage,omitempty"`
	// Integration: what MoltenTerm's launcher added to this run, or why nothing (FR-SHELL-036).
	Integration *molten.AgentIntegrationReport `json:"integration,omitempty"`
	// The recap (#555): the latest topics of the session, the sub-agents its agent started, its latest call.
	Topics    []TopicInfo    `json:"topics,omitempty"`
	Subagents []SubagentInfo `json:"subagents,omitempty"`
	Activity  *ActivityInfo  `json:"activity,omitempty"`
	// Earlier: the pane's earlier sessions, newest first, the one shown left out (#600).
	Earlier []EarlierSession `json:"earlier,omitempty"`
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
	// pending: the transcript did not exist yet when the hook reported it (SessionStart after /clear).
	pending bool
	// by: LinkHook, or LinkProcess for a transcript the agent's process holds open (processlink.go).
	by string
}

func (r sessionReport) linkKind() string {
	if r.by == "" {
		return LinkHook
	}
	return r.by
}

type sessionPick struct {
	agent   string
	started int64
	path    string
	// at: a pick made after the hook's report shows that session instead (an earlier session of the pane).
	at time.Time
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
	earlier  map[string][]EarlierSession
	version  int64
	// When each block's plan gauges were last published.
	usagePublished map[string]time.Time
	// Whether the last plan usage request of each block's companion came from a window that shows (NFR-SHELL-013).
	usageVisible map[string]bool
	// The status line relay's reports of each block, at most one a second (statuslinegate.go).
	statusLines   map[string]*statusLineGate
	statusLineGap time.Duration
	// The followers' loops and the usage reads they start: a closed companion's last read may still be running, and
	// tests wait for it before the next one swaps the shared Codex usage state (#796).
	running sync.WaitGroup
	// Whether Codex's plan limits are kept: set when the gauges are turned on or off, before the reloaded settings
	// say so; until then (limitsUnset) the settings tell.
	limitsState atomic.Int32
	// Session ids reported by an agent and not found among its transcripts, with when: not looked up again for a
	// while (Codex reports its thread id at every turn's end).
	idMisses map[string]time.Time
	// The complexity of the tickets the agents work on (#601, tickets.go), by folder and ticket, and the gh calls running.
	complexities  map[string]*complexityEntry
	ticketLookups int
	// The pull requests of the topics' branches (#991, branchprs.go), by folder and branch, and the gh calls running.
	prBranches map[string]*branchPREntry
	prLookups  int
	// The process links and settings follow of the agents' runs (processlink.go), by block, and which rollouts are
	// sub-agents'.
	tracks        map[string]*runTrack
	subagentPaths map[string]bool
	// identityAdapters: the adapters PaneSubagents reads with, one per agent (#1035).
	identityAdapters map[string]Adapter

	// Injected: the agent states, the object store, the event bus, the settings and the clock; replaced in tests.
	runOf          func(blockId string) (molten.AgentRunInfo, bool)
	setSettings    func(blockId string, agent string, settings molten.AgentSettings)
	integrationOf  func(blockId string) (molten.AgentIntegrationReport, bool)
	allRuns        func() []molten.AgentRunInfo
	blockInfo      func(blockId string) (blockInfo, error)
	ticketLabels   func(ctx context.Context, dir string, number int) ([]string, error)
	branchPRLookup func(ctx context.Context, dir string, branch string) ([]PRLink, error)
	publish        func(view CompanionView)
	publishUsage   func(info UsageInfo)
	writeGauges    func(agents []string) error
	writeSetting   func(key string, value any) error
	adapterFor     func(agent string) Adapter
	openFiles      func(pid int32) []string
	procTable      func() (*proctree.Table, error)
	settings       func() *wconfig.SettingsType
	now            func() time.Time
	tick           time.Duration
	idleTick       time.Duration
}

func MakeManager() *Manager {
	return &Manager{
		watchers:       map[string]*watcher{},
		reports:        map[string]sessionReport{},
		picks:          map[string]sessionPick{},
		claims:         map[string]sessionClaim{},
		earlier:        map[string][]EarlierSession{},
		usagePublished: map[string]time.Time{},
		usageVisible:   map[string]bool{},
		statusLines:    map[string]*statusLineGate{},
		statusLineGap:  statusLineMinGap,
		idMisses:       map[string]time.Time{},
		tracks:         map[string]*runTrack{},
		subagentPaths:  map[string]bool{},
		adapterFor:     AdapterFor,
		now:            time.Now,
		tick:           tickInterval,
		idleTick:       idleTickInterval,
	}
}

// Poke makes the block's companion look again now (its agent state changed).
func (m *Manager) Poke(blockId string) {
	if w := m.watcher(blockId); w != nil {
		w.poke()
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

// Refresh makes an open companion look again at once: which session is the pane's (a link that came while nobody
// looked, a newer session of the folder), what was appended, which background agents went quiet. A view asks for it
// when it opens or shows, and on a bounded interval while it shows (#600, AC5 and AC6).
func (m *Manager) Refresh(blockId string) {
	w := m.watcher(blockId)
	if w == nil {
		return
	}
	w.refreshAsked.Store(true)
	w.poke()
}

func (m *Manager) lease(blockId string, viewId string) (*watcher, error) {
	m.lock.Lock()
	defer m.lock.Unlock()
	until := m.now().Add(leaseDuration)
	w := m.watchers[blockId]
	if w != nil {
		if w.leases[viewId].IsZero() && len(w.leases) >= maxLeases {
			return nil, uimsg.Errorf(uimsg.Make("companion.toomanyviews"), "too many views of this companion")
		}
		w.leases[viewId] = until
		return w, nil
	}
	if len(m.watchers) >= maxWatchers {
		return nil, uimsg.Errorf(uimsg.Make("companion.toomanycompanions"), "too many companions open")
	}
	w = makeWatcher(m, blockId)
	w.leases[viewId] = until
	m.watchers[blockId] = w
	m.running.Add(1)
	go func() {
		defer m.running.Done()
		w.loop()
	}()
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
	delete(m.earlier, blockId)
	delete(m.usagePublished, blockId)
	delete(m.usageVisible, blockId)
	delete(m.statusLines, blockId)
	usage.DefaultStatusLineStore.Forget(blockId)
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

// weakLink: a link wavesrv made on its own, which gives way to a hook report or a pick.
func weakLink(by string) bool {
	return by == LinkDiscovery || by == LinkGuessed
}

// claim links a transcript to a block. A link by discovery or guess gives way to another block's hook report or
// pick; any other link of another block keeps the transcript.
func (m *Manager) claim(blockId string, path string, by string) bool {
	m.lock.Lock()
	defer m.lock.Unlock()
	if c, ok := m.claims[path]; ok && c.blockId != blockId {
		if !weakLink(c.by) || weakLink(by) {
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

// heldByOther is takenByOther without the sessions another block only guessed: the user may take those.
func (m *Manager) heldByOther(blockId string, path string) bool {
	m.lock.Lock()
	defer m.lock.Unlock()
	if c, ok := m.claims[path]; ok && c.blockId != blockId && c.by != LinkGuessed {
		return true
	}
	return m.reportedByOtherLocked(blockId, path)
}

// reportedByOther: another block's hook reports the session, its companion open or not.
func (m *Manager) reportedByOther(blockId string, path string) bool {
	m.lock.Lock()
	defer m.lock.Unlock()
	return m.reportedByOtherLocked(blockId, path)
}

// confidentPath is the session a block's hook report, pick or discovery links, "" when none or only a guess.
func (m *Manager) confidentPath(blockId string) string {
	m.lock.Lock()
	defer m.lock.Unlock()
	if r, ok := m.reports[blockId]; ok && m.reportCurrentLocked(blockId, r) {
		if r.pending {
			// A new session whose transcript does not exist yet: nothing of it can be read or resumed.
			return ""
		}
		return r.path
	}
	if p, ok := m.picks[blockId]; ok {
		return p.path
	}
	for path, c := range m.claims {
		if c.blockId == blockId && c.by != LinkGuessed {
			return path
		}
	}
	return ""
}

// guessedOnly: the block's only link is a guess (its companion is open on a session it guessed).
func (m *Manager) guessedOnly(blockId string) bool {
	m.lock.Lock()
	defer m.lock.Unlock()
	if r, ok := m.reports[blockId]; ok && m.reportCurrentLocked(blockId, r) {
		return false
	}
	guessed := false
	for _, c := range m.claims {
		if c.blockId != blockId {
			continue
		}
		if c.by != LinkGuessed {
			return false
		}
		guessed = true
	}
	return guessed
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
	reqPath := req.Path
	if reqPath == "" && req.SessionId != "" {
		found, err := m.findSession(req.BlockId, agent, adapter, req.SessionId)
		if err != nil {
			return err
		}
		reqPath = found
	}
	path, pending, err := ValidateReportedSessionPath(adapter, reqPath)
	if err != nil {
		return err
	}
	if err := m.recordReport(req.BlockId, agent, path, pending, LinkHook); err != nil {
		return err
	}
	if !pending {
		m.readSettings(req.BlockId, agent, adapter, path)
	}
	return nil
}

func (m *Manager) recordReport(blockId string, agent string, path string, pending bool, by string) error {
	m.lock.Lock()
	defer m.lock.Unlock()
	if m.reportedByOtherLocked(blockId, path) {
		return fmt.Errorf("this session belongs to another terminal")
	}
	prev, had := m.reports[blockId]
	if !had && len(m.reports) >= maxReports {
		m.evictOldestReportLocked()
	}
	now := m.now()
	if had && !prev.pending && prev.path != path {
		// Kept even while no companion is open: the history still offers the session the pane moved on from.
		m.addEarlierLocked(blockId, EarlierSession{Path: prev.path, Until: now.UnixMilli()})
	}
	m.reports[blockId] = sessionReport{agent: agent, path: path, at: now, pending: pending, by: by}
	if w := m.watchers[blockId]; w != nil {
		w.poke()
	}
	return nil
}

// addEarlierLocked keeps a session the pane moved on from, newest first; what is already known of it is kept.
func (m *Manager) addEarlierLocked(blockId string, s EarlierSession) {
	if s.Path == "" {
		return
	}
	list := m.earlier[blockId]
	rtn := make([]EarlierSession, 0, len(list)+1)
	for _, e := range list {
		if e.Path != s.Path {
			rtn = append(rtn, e)
			continue
		}
		if s.Title == "" {
			s.Title = e.Title
		}
		if s.Command == "" {
			s.Command = e.Command
		}
		if s.Started == 0 {
			s.Started = e.Started
		}
	}
	rtn = append([]EarlierSession{s}, rtn...)
	if len(rtn) > maxEarlier {
		rtn = rtn[:maxEarlier]
	}
	m.earlier[blockId] = rtn
}

func (m *Manager) addEarlier(blockId string, s EarlierSession) {
	m.lock.Lock()
	defer m.lock.Unlock()
	m.addEarlierLocked(blockId, s)
}

// earlierOf lists the pane's earlier sessions, the one it shows (current) left out.
func (m *Manager) earlierOf(blockId string, current string) []EarlierSession {
	m.lock.Lock()
	defer m.lock.Unlock()
	var rtn []EarlierSession
	for _, e := range m.earlier[blockId] {
		if e.Path != current {
			rtn = append(rtn, e)
		}
	}
	return rtn
}

// readSettings reads the run's model and effort from the session an agent just reported, when its transcript is the
// only place they are written (Codex's notify links the session at each turn's end, #549): one bounded read per
// report, in the background, never a poll.
func (m *Manager) readSettings(blockId string, agent string, adapter Adapter, path string) {
	reader, ok := adapter.(SettingsReader)
	if !ok || m.setSettings == nil {
		return
	}
	go func() {
		defer func() {
			panichandler.PanicHandler("molten:companion:settings", recover())
		}()
		if settings, ok := reader.ReadSettings(path); ok {
			m.setSettings(blockId, agent, settings)
		}
	}()
}

const (
	idMissTTL = time.Minute
	maxIdMiss = 256
)

// findSession resolves a session id to its transcript. The block's current report is reused when it is that
// session's (an agent reports its id at every turn), and an id just looked up in vain is not looked up again soon.
func (m *Manager) findSession(blockId string, agent string, adapter Adapter, id string) (string, error) {
	finder, ok := adapter.(SessionFinder)
	if !ok {
		return "", fmt.Errorf("%s's sessions cannot be found by id", molten.AgentDisplayName(agent))
	}
	if r, ok := m.report(blockId); ok && r.agent == agent && finder.SessionMatches(r.path, id) {
		if info, err := os.Stat(r.path); err == nil && info.Mode().IsRegular() {
			return r.path, nil
		}
	}
	key := agent + "\x00" + id
	if m.recentMiss(key) {
		return "", fmt.Errorf("no transcript was found for this session id")
	}
	found, ok := finder.FindSession(id)
	if !ok {
		m.noteMiss(key)
		return "", fmt.Errorf("no transcript was found for this session id")
	}
	if finder.IsSubagent(found) {
		return "", errors.New(molten.SubagentSessionError)
	}
	return found, nil
}

func (m *Manager) recentMiss(key string) bool {
	m.lock.Lock()
	defer m.lock.Unlock()
	at, ok := m.idMisses[key]
	return ok && m.now().Sub(at) < idMissTTL
}

func (m *Manager) noteMiss(key string) {
	m.lock.Lock()
	defer m.lock.Unlock()
	now := m.now()
	if len(m.idMisses) >= maxIdMiss {
		for k, at := range m.idMisses {
			if now.Sub(at) >= idMissTTL {
				delete(m.idMisses, k)
			}
		}
	}
	if len(m.idMisses) >= maxIdMiss {
		m.idMisses = map[string]time.Time{}
	}
	m.idMisses[key] = now
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

// report is the block's hook report; a pending one is checked again, and becomes a plain one once its transcript
// exists.
func (m *Manager) report(blockId string) (sessionReport, bool) {
	r, ok := m.storedReport(blockId)
	if !ok || !r.pending {
		return r, ok
	}
	adapter := m.adapterFor(r.agent)
	if adapter == nil {
		return r, ok
	}
	resolved, err := ValidateSessionPath(adapter, r.path)
	if err != nil {
		return r, ok
	}
	m.lock.Lock()
	defer m.lock.Unlock()
	cur, still := m.reports[blockId]
	if !still || cur.path != r.path || cur.at != r.at {
		return cur, still
	}
	cur.path, cur.pending = resolved, false
	m.reports[blockId] = cur
	return cur, true
}

func (m *Manager) storedReport(blockId string) (sessionReport, bool) {
	m.lock.Lock()
	defer m.lock.Unlock()
	r, ok := m.reports[blockId]
	return r, ok
}

// Pick links the session the user chose in the picker. An empty path drops the pick: the companion goes back to the
// session the agent's hook reports (Back to the current session).
func (m *Manager) Pick(blockId string, viewId string, path string) (CompanionView, error) {
	w, err := m.lease(blockId, viewId)
	if err != nil {
		return CompanionView{}, err
	}
	if path == "" {
		m.lock.Lock()
		delete(m.picks, blockId)
		m.lock.Unlock()
		w.refreshAsked.Store(true)
		w.poke()
		return w.view(false), nil
	}
	run, ok := w.currentRun()
	if !ok {
		return CompanionView{}, errNoAgentRuns()
	}
	adapter := m.adapterFor(run.Agent)
	if adapter == nil {
		return CompanionView{}, errNoCompanionFor(run.Agent)
	}
	resolved, err := ValidateSessionPath(adapter, path)
	if err != nil {
		return CompanionView{}, uimsg.Errorf(uimsg.Make("companion.transcriptinvalid", "detail", err.Error()), "%w", err)
	}
	if m.heldByOther(blockId, resolved) || !m.claim(blockId, resolved, LinkPicked) {
		return CompanionView{}, uimsg.Errorf(uimsg.Make("companion.sessionofother"), "this session belongs to another terminal")
	}
	m.lock.Lock()
	m.picks[blockId] = sessionPick{agent: run.Agent, started: run.Started, path: resolved, at: m.now()}
	m.lock.Unlock()
	w.poke()
	return w.view(false), nil
}

// Sessions lists the sessions of a block's folder written since its agent started, for the companion's history: the
// one the companion shows first (flagged Current), then the others no other terminal holds, newest first.
func (m *Manager) Sessions(blockId string, viewId string) ([]Candidate, error) {
	w, err := m.lease(blockId, viewId)
	if err != nil {
		return nil, err
	}
	run, ok := w.currentRun()
	if !ok {
		return nil, errNoAgentRuns()
	}
	adapter := m.adapterFor(run.Agent)
	if adapter == nil {
		return nil, errNoCompanionFor(run.Agent)
	}
	var info blockInfo
	if m.blockInfo != nil {
		info, err = m.blockInfo(blockId)
		if err != nil {
			return nil, err
		}
	}
	if info.remote {
		return nil, uimsg.Errorf(uimsg.Make("companion.remoteterminal"), "no companion for a remote terminal")
	}
	var rtn []Candidate
	current, hasCurrent := w.currentCandidate()
	if hasCurrent {
		rtn = append(rtn, current)
	}
	var found []Candidate
	if info.cwd != "" {
		found = adapter.Discover(info.cwd, time.UnixMilli(run.Started))
	}
	byPath := map[string]Candidate{}
	for _, c := range found {
		c.Path = canonicalPath(c.Path)
		byPath[c.Path] = c
	}
	listed := map[string]bool{current.Path: hasCurrent}
	if live := w.livePath(); live != "" && !listed[live] {
		c, ok := byPath[live]
		if !ok {
			c = earlierCandidate(EarlierSession{Path: live})
		}
		if c.Path != "" {
			c.Live = true
			listed[c.Path] = true
			rtn = append(rtn, c)
		}
	}
	// The pane's earlier sessions come right after its current one, those of an earlier run of the agent included.
	for _, e := range m.earlierOf(blockId, current.Path) {
		if listed[e.Path] || m.heldByOther(blockId, e.Path) {
			continue
		}
		c, ok := byPath[e.Path]
		if !ok {
			c = earlierCandidate(e)
			if c.Path == "" {
				continue
			}
		}
		c.Earlier = true
		listed[c.Path] = true
		rtn = append(rtn, c)
	}
	for _, c := range found {
		if len(rtn) >= maxHistory {
			break
		}
		c.Path = canonicalPath(c.Path)
		if listed[c.Path] {
			continue
		}
		if m.heldByOther(blockId, c.Path) {
			continue
		}
		c.Elsewhere = m.takenByOther(blockId, c.Path)
		rtn = append(rtn, c)
	}
	return rtn, nil
}

// earlierCandidate describes an earlier session of the pane that discovery no longer lists (written before the
// agent's current run); empty when its transcript is gone.
func earlierCandidate(e EarlierSession) Candidate {
	info, err := os.Stat(e.Path)
	if err != nil || !info.Mode().IsRegular() {
		return Candidate{}
	}
	return Candidate{
		Path:     e.Path,
		Id:       strings.TrimSuffix(filepath.Base(e.Path), ".jsonl"),
		Started:  e.Started,
		Modified: info.ModTime().UnixMilli(),
		Prompt:   e.Title,
		Command:  e.Command,
	}
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
		return AnswerView{}, errNotOpen()
	}
	return w.answer(index)
}

func (m *Manager) Diff(blockId string, path string) (FileDiff, error) {
	w := m.watcher(blockId)
	if w == nil {
		return FileDiff{}, errNotOpen()
	}
	return w.diff(path)
}

// The errors a companion window shows, worded there by their codes (#656).
func errNotOpen() error {
	return uimsg.Errorf(uimsg.Make("companion.notopen"), "the companion of this terminal is not open")
}

func errNoSession() error {
	return uimsg.Errorf(uimsg.Make("companion.nosession"), "no session")
}

func errNoAgentRuns() error {
	return uimsg.Errorf(uimsg.Make("companion.noagentruns"), "no agent runs in this terminal")
}

func errNoCompanionFor(agent string) error {
	name := molten.AgentDisplayName(agent)
	return uimsg.Errorf(uimsg.Make("companion.nocompanionfor", "agent", name), "no companion exists for %s", name)
}

// sameFolderRuns counts the blocks running the same agent in the same folder (discovery cannot tell their sessions
// apart).
func (m *Manager) sameFolderRuns(agent string, cwd string) int {
	if m.allRuns == nil {
		return 1
	}
	return len(m.sameFolderRunList(agent, cwd))
}

func (m *Manager) sameFolderRunList(agent string, cwd string) []molten.AgentRunInfo {
	if m.allRuns == nil {
		return nil
	}
	var rtn []molten.AgentRunInfo
	for _, run := range m.allRuns() {
		if run.Agent != agent || !run.Running {
			continue
		}
		info, err := m.blockInfo(run.BlockId)
		if err != nil || info.remote || !samePath(info.cwd, cwd) {
			continue
		}
		rtn = append(rtn, run)
	}
	return rtn
}

// blockLinked tells whether a block has a session of its own: followed by its companion, or reported by its hook.
func (m *Manager) blockLinked(blockId string) bool {
	m.lock.Lock()
	defer m.lock.Unlock()
	for _, c := range m.claims {
		if c.blockId == blockId {
			return true
		}
	}
	r, ok := m.reports[blockId]
	return ok && m.reportCurrentLocked(blockId, r)
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
	status      string
	message     string
	messageText *uimsg.Text
	agent       string
	runStarted  int64
	hasRun      bool
	ended       bool
	path        string
	linkedBy    string
	guess       string
	session     *Session
	version     int64
	// earlier: the session shown is an earlier one of the pane the user chose; the hook reports a newer one, live.
	earlier bool
	live    string
	// integration: the launcher's report for the current run, nil without one.
	integration *molten.AgentIntegrationReport

	// The loop's own state.
	follower      *follower
	adapter       Adapter
	info          blockInfo
	infoAt        time.Time
	discoveredAt  time.Time
	processAt     time.Time
	linkedStarted int64
	// sawRun: the agent states knew this block's agent; a hook report alone then no longer makes a run.
	sawRun        bool
	published     string
	latestIndex   int
	latestRev     int64
	latestStarted bool
	// The Codex session whose plan limits were last published, and their revision.
	limitsSession *Session
	limitsRev     int64
	limitsReady   bool
	// reread: the plan limits were forgotten, so the session is read again from its start (guarded by lock).
	reread bool
	// refreshAsked: a view asked to look again now (Refresh); quietAt: when the background agents were last checked.
	refreshAsked atomic.Bool
	quietAt      time.Time
	// factsAsked: a refresh asked to read the running sub-agents' own transcripts and to look tickets up (#601).
	factsAsked bool
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

// currentCandidate describes the session the companion shows, as a history entry.
func (w *watcher) currentCandidate() (Candidate, bool) {
	w.lock.Lock()
	defer w.lock.Unlock()
	if w.path == "" || w.session == nil {
		return Candidate{}, false
	}
	c := Candidate{
		Path:    w.path,
		Id:      w.session.Id,
		Started: w.session.StartedAt(),
		Prompt:  w.session.Title(),
		Command: w.session.FirstCommand(),
		Current: true,
	}
	if info, err := os.Stat(w.path); err == nil {
		c.Modified = info.ModTime().UnixMilli()
	}
	return c, true
}

func (w *watcher) loop() {
	defer func() {
		panichandler.PanicHandler("molten:companion", recover())
	}()
	defer w.closeFollower()
	timer := time.NewTimer(w.m.tick)
	defer timer.Stop()
	for {
		if w.m.leaseExpired(w) {
			return
		}
		more := w.step()
		w.publishIfChanged()
		w.publishLimitsIfChanged()
		if more {
			continue
		}
		wait := w.m.tick
		if w.idle() {
			wait = w.m.idleTick
		}
		timer.Reset(wait)
		select {
		case <-w.stop:
			return
		case <-w.wake:
			// Go 1.23 timers: a stopped timer delivers no stale tick, Reset needs no drain.
			timer.Stop()
		case <-timer.C:
		}
	}
}

// idle tells a companion with no running agent's session to follow: nothing is appended until a state changes.
func (w *watcher) idle() bool {
	w.lock.Lock()
	defer w.lock.Unlock()
	switch w.status {
	case StatusNoAgent, StatusUnsupportedAgent, StatusRemote, StatusError:
		return true
	}
	return w.ended
}

func (w *watcher) closeFollower() {
	if w.follower != nil {
		w.follower.close()
		w.follower = nil
	}
}

// setStatus: text is message's code for the windows (#656), nil without a message.
func (w *watcher) setStatus(status string, text *uimsg.Text, message string) {
	w.lock.Lock()
	defer w.lock.Unlock()
	if w.status == status && w.message == message {
		return
	}
	w.status, w.message, w.messageText = status, message, text
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
	if w.refreshAsked.Swap(false) {
		w.discoveredAt, w.infoAt, w.quietAt = time.Time{}, time.Time{}, time.Time{}
		w.factsAsked = true
	}
	w.refreshIntegration()
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
			w.setStatus(StatusError, uimsg.Make("companion.terminalunreadable"), "This terminal could not be read.")
			return false
		}
	}
	if w.adapter == nil {
		w.setStatus(StatusUnsupportedAgent, nil, "")
		return false
	}
	if w.info.remote {
		w.setStatus(StatusRemote, nil, "")
		return false
	}
	w.rereadIfAsked()
	w.link(run)
	if w.follower == nil {
		return false
	}
	more := w.read()
	if !more {
		w.settleSubagents()
		w.readAgentFacts()
	}
	return more
}

// settleSubagents checks, at most once a subagentSweepInterval, the background agents whose end the transcript did
// not tell: one silent for long is no longer shown as at work (#600). A few stats, only while the companion is open.
func (w *watcher) settleSubagents() {
	now := w.m.now()
	if !w.quietAt.IsZero() && now.Sub(w.quietAt) < subagentSweepInterval {
		return
	}
	w.quietAt = now
	writer, _ := w.adapter.(SubagentWriter)
	w.lock.Lock()
	defer w.lock.Unlock()
	if w.session == nil {
		return
	}
	path := w.path
	var lastWrite func(string) int64
	if writer != nil {
		lastWrite = func(agentId string) int64 { return writer.SubagentWritten(path, agentId) }
	}
	w.session.QuietSubagents(now.UnixMilli(), lastWrite)
}

// readAgentFacts gives the agents their ticket and its complexity (#601). Only a refresh (a view that shows asked)
// reads the running sub-agents' own transcripts and may start a gh lookup; any other pass answers from the cache.
func (w *watcher) readAgentFacts() {
	fetch := w.factsAsked
	w.factsAsked = false
	reader, _ := w.adapter.(SubagentReader)
	dir := w.info.cwd
	w.lock.Lock()
	defer w.lock.Unlock()
	if w.session == nil {
		return
	}
	if fetch {
		w.readFolderBranch(dir)
	}
	if fetch && reader != nil {
		w.readSubagents(reader)
	}
	w.session.ResolveTickets(func(number int, wanted bool) (string, bool) {
		return w.m.ticketComplexity(dir, number, fetch && wanted)
	})
	prDir := w.session.Cwd
	if prDir == "" {
		prDir = dir
	}
	w.session.ResolveBranchPRs(func(branch string) []PRLink {
		return w.m.branchPRs(prDir, branch, fetch)
	})
	w.readSessionName()
}

// readSessionName takes the name the agent keeps outside the transcript (Codex's session index, #991): a stat a
// pass, the index read again only when it changed.
func (w *watcher) readSessionName() {
	namer, ok := w.adapter.(SessionNamer)
	if !ok || w.session.Id == "" {
		return
	}
	if name, ok := namer.SessionName(w.path, w.session.Id); ok {
		w.session.SetSessionName(name, false)
	}
}

// readFolderBranch reads the main agent's branch from its session's folder (its records' cwd, else the pane's), not
// from the branch its records name (#967).
func (w *watcher) readFolderBranch(paneDir string) {
	dir := w.session.Cwd
	if dir == "" {
		dir = paneDir
	}
	if dir == "" {
		return
	}
	w.session.SetFolderBranch(FolderBranch(dir))
}

// readSubagents reads the running sub-agents' own transcripts: the meta files only while one's agent id is unknown.
func (w *watcher) readSubagents(reader SubagentReader) {
	if finder, ok := reader.(SubagentFinder); ok {
		w.findSubagents(finder)
	}
	running := w.session.runningSubagents()
	var ids map[string]string
	for _, sa := range running {
		agentId := sa.agentId
		if agentId == "" {
			if ids == nil {
				ids = reader.SubagentIds(w.path)
				if ids == nil {
					ids = map[string]string{}
				}
			}
			agentId = ids[sa.callId]
			w.session.SetSubagentId(sa.callId, agentId)
		}
		if agentId == "" {
			continue
		}
		if facts, ok := reader.ReadSubagent(w.path, agentId); ok {
			w.session.SetSubagentFacts(sa.callId, facts)
		}
	}
}

// findSubagents looks, while sub-agents run, for the agents they started (#986), and for the thread of a running one
// whose start gave none (the session's own children).
func (w *watcher) findSubagents(finder SubagentFinder) {
	running := w.session.runningSubagents()
	if len(running) == 0 {
		return
	}
	var parents []string
	since := int64(0)
	unlinked := false
	for _, sa := range running {
		if sa.agentId != "" {
			parents = append(parents, sa.agentId)
		} else {
			unlinked = true
		}
		if sa.started > 0 && (since == 0 || sa.started < since) {
			since = sa.started
		}
	}
	if unlinked && w.session.Id != "" {
		parents = append(parents, w.session.Id)
	}
	for _, f := range finder.FindSubagents(w.path, parents, since) {
		w.session.AddFoundSubagent(f)
	}
}

// refreshIntegration follows the launcher's report of the block's run; a new or gone report is a new view.
func (w *watcher) refreshIntegration() {
	var current *molten.AgentIntegrationReport
	if w.m.integrationOf != nil {
		if rep, ok := w.m.integrationOf(w.blockId); ok {
			current = &rep
		}
	}
	w.lock.Lock()
	defer w.lock.Unlock()
	if sameIntegration(w.integration, current) {
		return
	}
	w.integration = current
	w.version++
}

func sameIntegration(a *molten.AgentIntegrationReport, b *molten.AgentIntegrationReport) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.At == b.At && a.BlockId == b.BlockId
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
	w.setStatus(StatusNoAgent, nil, "")
}

func (w *watcher) unlink() {
	w.retire()
	w.giveBack()
}

// giveBack drops the link without keeping the session among the pane's earlier ones: it is another terminal's.
func (w *watcher) giveBack() {
	w.closeFollower()
	w.m.releaseClaims(w.blockId)
	w.lock.Lock()
	defer w.lock.Unlock()
	w.path, w.linkedBy, w.guess, w.session, w.ended, w.earlier, w.live = "", "", "", nil, false, false, ""
	w.linkedStarted = 0
	w.discoveredAt = time.Time{}
	w.version++
}

// retire keeps the session the companion leaves among the pane's earlier ones, unless it was only a guess (which
// may be another pane's).
func (w *watcher) retire() {
	w.lock.Lock()
	// An earlier session the user looks at is already among them, and the session it replaced is the agent's own.
	if w.path == "" || w.session == nil || w.linkedBy == LinkGuessed || w.earlier {
		w.lock.Unlock()
		return
	}
	e := EarlierSession{Path: w.path, Title: w.session.Title(), Command: w.session.FirstCommand(), Started: w.session.StartedAt(), Until: w.m.now().UnixMilli()}
	w.lock.Unlock()
	w.m.addEarlier(w.blockId, e)
}

// link finds the session to follow, the most reliable source first: the agent hook's report, the user's pick, then
// discovery. A link by discovery gives way to a report or a pick, this block's or another's.
func (w *watcher) link(run molten.AgentRunInfo) {
	if w.follower != nil && w.m.claimOwner(w.path) != w.blockId {
		// Another terminal's hook or pick took the session discovery had linked here.
		w.giveBack()
	}
	if by, _ := w.linkKind(); w.follower != nil && weakLink(by) && w.m.reportedByOther(w.blockId, w.path) {
		// Another terminal's hook reports it while that terminal's companion is closed (no claim of its own).
		w.giveBack()
	}
	pick, picked := w.m.pick(w.blockId)
	picked = picked && pick.agent == run.Agent && pick.started == run.Started
	if report, ok := w.m.report(w.blockId); ok && report.agent == run.Agent && !report.at.Before(time.UnixMilli(run.Started).Add(-reportSlack)) {
		if picked && pick.at.After(report.at) && pick.path != report.path {
			// The user chose an earlier session of the pane after the hook's report: it shows until the next report
			// or Back to the current session.
			w.setEarlier(true, report.path)
			w.follow(pick.path, LinkPicked, 0, "")
			return
		}
		if report.pending {
			w.waitForReported(report.path)
			return
		}
		w.follow(report.path, report.linkKind(), 0, "")
		w.setEarlier(false, "")
		return
	}
	if w.linkByProcess(run) {
		return
	}
	if picked {
		w.follow(pick.path, LinkPicked, 0, "")
		w.setEarlier(false, "")
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
		w.setStatus(StatusSearching, uimsg.Make("companion.foldernotknown"), "This terminal's folder is not known yet.")
		return
	}
	var free []Candidate
	var current *Candidate
	written := 0
	// guessedElsewhere: sessions left out only because another pane guessed them, which discovery cannot rule out.
	guessedElsewhere := 0
	for _, c := range w.adapter.Discover(w.info.cwd, time.UnixMilli(run.Started)) {
		c.Path = canonicalPath(c.Path)
		if c.Modified >= run.Started {
			written++
		}
		if !w.m.takenByOther(w.blockId, c.Path) {
			free = append(free, c)
			if c.Path == w.path {
				current = &free[len(free)-1]
			}
		} else if !w.m.heldByOther(w.blockId, c.Path) {
			guessedElsewhere++
		}
	}
	runs := w.m.sameFolderRuns(run.Agent, w.info.cwd)
	if now.Sub(time.UnixMilli(run.Started)) < resumeGrace {
		written = 0
	}
	if by, _ := w.linkKind(); w.follower != nil && by == LinkGuessed && current != nil && guessedElsewhere == 0 {
		// A guess made while discovery could not tell (within the resume grace, before the session's first record)
		// becomes discovery's link once discovery would choose the same session on its own (#799).
		if chosen, ambiguous := chooseCandidate(free, written, run.Started, runs); chosen != nil && !ambiguous && chosen.Path == w.path {
			w.follow(w.path, LinkDiscovery, chosen.Started, "")
			return
		}
	}
	if by, _ := w.linkKind(); w.follower != nil && by == LinkGuessed {
		// Several panes of the folder keep a guess from following a /clear by the rule below. A guess moves to a
		// session started after the linked one only when this pane's agent wrote it as far as its activity tells and
		// no other pane's agent may have: otherwise two panes would race for the newest session.
		if current != nil && w.wrongGuess(run, *current) {
			// Another pane's agent explains the guessed session and this one's does not: give it back and guess again.
			w.unlink()
			current = nil
		} else {
			guess, reason := w.guessSession(run, free)
			if guess != nil && guess.Path != w.path && guess.Started > w.linkedStarted && reason == GuessActivity && !w.othersMayHaveWritten(run, *guess) {
				w.follow(guess.Path, LinkGuessed, guess.Started, reason)
			}
			return
		}
	}
	if w.follower != nil {
		// Already linked by discovery: move only to the one session started after the linked one (a /clear).
		var newer []Candidate
		for _, c := range free {
			if c.Path != w.path && c.Started > w.linkedStarted {
				newer = append(newer, c)
			}
		}
		if len(newer) == 1 && runs <= 1 {
			by, guess := w.linkKind()
			w.follow(newer[0].Path, by, newer[0].Started, guess)
		}
		return
	}
	chosen, ambiguous := chooseCandidate(free, written, run.Started, runs)
	if chosen != nil && !ambiguous && guessedElsewhere == 0 {
		w.follow(chosen.Path, LinkDiscovery, chosen.Started, "")
		return
	}
	// Discovery cannot tell: the companion opens on the likeliest session rather than on a list (DS-SHELL-060).
	if guess, reason := w.guessSession(run, free); guess != nil {
		w.follow(guess.Path, LinkGuessed, guess.Started, reason)
		return
	}
	w.setStatus(StatusSearching, nil, "")
}

// guessSession weighs this block's agent against the other unlinked agents of the same folder.
func (w *watcher) guessSession(run molten.AgentRunInfo, free []Candidate) (*Candidate, string) {
	if len(free) == 0 {
		return nil, ""
	}
	self := makeGuessRun(run)
	self.blockId = w.blockId
	var others, witnesses []guessRun
	for _, other := range w.m.sameFolderRunList(run.Agent, w.info.cwd) {
		if other.BlockId == w.blockId {
			continue
		}
		if !w.m.blockLinked(other.BlockId) {
			others = append(others, makeGuessRun(other))
		} else if w.m.guessedOnly(other.BlockId) {
			witnesses = append(witnesses, makeGuessRun(other))
		}
	}
	return guessCandidate(free, self, others, witnesses, w.m.now().UnixMilli())
}

// wrongGuess: this pane's agent activity does not explain its guessed session and another pane's (unlinked or
// guessing too) does: two busy panes paired the wrong way round, or the other pane's agent wrote it since.
func (w *watcher) wrongGuess(run molten.AgentRunInfo, current Candidate) bool {
	self := makeGuessRun(run)
	if activityMatch(self, current) {
		return false
	}
	for _, other := range w.m.sameFolderRunList(run.Agent, w.info.cwd) {
		if other.BlockId == w.blockId || w.m.confidentPath(other.BlockId) != "" {
			continue
		}
		if activityMatch(makeGuessRun(other), current) {
			return true
		}
	}
	return false
}

// othersMayHaveWritten: another pane's agent of the folder worked when the session was written, unless that pane's
// hook, pick or discovery links another session (its writes go there).
func (w *watcher) othersMayHaveWritten(run molten.AgentRunInfo, c Candidate) bool {
	for _, other := range w.m.sameFolderRunList(run.Agent, w.info.cwd) {
		if other.BlockId == w.blockId {
			continue
		}
		if path := w.m.confidentPath(other.BlockId); path != "" && path != c.Path {
			continue
		}
		if activityMatch(makeGuessRun(other), c) {
			return true
		}
	}
	return false
}

func (w *watcher) linkKind() (string, string) {
	w.lock.Lock()
	defer w.lock.Unlock()
	return w.linkedBy, w.guess
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

// waitForReported: the hook reported a session whose transcript does not exist yet (Claude Code's SessionStart after
// /clear comes before the new session's first record). The session shown until then is the pane's previous one, so
// it is left (kept among the earlier sessions) and the companion waits; each step looks for the file again.
func (w *watcher) waitForReported(path string) {
	w.lock.Lock()
	following := w.path != "" && w.path != path
	w.lock.Unlock()
	if following {
		w.unlink()
	}
	w.setStatus(StatusSearching, uimsg.Make("companion.newsession"), "A new session started. It shows here once the agent writes its first message.")
}

func (w *watcher) livePath() string {
	w.lock.Lock()
	defer w.lock.Unlock()
	if !w.earlier {
		return ""
	}
	return w.live
}

// setEarlier tells whether the session shown is an earlier one the user chose, and live the one the agent runs then.
func (w *watcher) setEarlier(earlier bool, live string) {
	w.lock.Lock()
	defer w.lock.Unlock()
	if w.earlier == earlier && w.live == live {
		return
	}
	w.earlier, w.live = earlier, live
	w.version++
}

func (w *watcher) follow(path string, linkedBy string, started int64, guess string) {
	w.lock.Lock()
	same := w.path == path && w.follower != nil
	if same && (w.linkedBy != linkedBy || w.guess != guess) {
		w.linkedBy, w.guess = linkedBy, guess
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
		w.setStatus(StatusSearching, uimsg.Make("companion.transcriptinvalid", "detail", err.Error()), "The session transcript cannot be read: "+err.Error())
		return
	}
	if !w.m.claim(w.blockId, resolved, linkedBy) {
		w.setStatus(StatusSearching, uimsg.Make("companion.followedelsewhere"), "This session is followed by another terminal.")
		return
	}
	w.retire()
	w.closeFollower()
	f, err := openFollower(resolved)
	if err != nil {
		w.m.releaseClaims(w.blockId)
		w.setStatus(StatusSearching, uimsg.Make("companion.transcriptunopened"), "The session transcript could not be opened.")
		return
	}
	w.follower = f
	w.linkedStarted = started
	w.quietAt = time.Time{}
	w.lock.Lock()
	defer w.lock.Unlock()
	w.path, w.linkedBy, w.guess, w.session = resolved, linkedBy, guess, MakeSession()
	// Another session's answer may have the same index and revision: the first event of this one carries its text.
	w.latestStarted = false
	w.status, w.message, w.messageText = StatusLoading, "", nil
	w.version++
}

// parseLine reads one record into the session. A very large record (a tool's whole output) is decoded only when it
// may carry a file change; otherwise only the call it ends is read from it.
func (w *watcher) parseLine(s *Session, line []byte) {
	parseRecordLine(w.adapter, s, line)
}

func parseRecordLine(adapter Adapter, s *Session, line []byte) {
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
				s.SubagentResult(string(m[1]), bytes.Contains(line, asyncLaunchedMarker), false, "")
			}
			if bytes.Contains(line, taskNotificationMarker) {
				ends, _ := taskNotifications(string(line))
				for _, end := range ends {
					s.EndSubagent(end[0], end[1])
				}
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
	s.countLine(true, adapter.Parse(rec, s))
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
		w.messageText = uimsg.Make("companion.transcriptgone")
		w.version++
		w.m.releaseClaims(w.blockId)
		return false
	}
	// Limits that arrive while the gauges are off are not kept.
	if w.agent == "codex" && !w.m.codexLimitsKept() {
		w.session.ClearCodexLimits()
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
		// The unsupported format's message is its name, not a sentence.
		w.status, w.message, w.messageText = status, message, nil
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
		BlockId: w.blockId,
		Version: w.m.nextVersion(),
		Status:  w.status,
		Agent:   w.agent,
		Message: w.message,
		Ended:   w.ended,
	}
	v.MessageText = w.messageText
	v.Integration = w.integration
	if w.agent != "" {
		v.AgentName = molten.AgentDisplayName(w.agent)
		v.Usage = usage.PageOf(w.agent)
	}
	v.Earlier = w.m.earlierOf(w.blockId, w.path)
	if w.path == "" || w.session == nil {
		return v
	}
	v.Session = &SessionInfo{
		Earlier:  w.earlier,
		LivePath: w.live,
		Path:     w.path,
		Format:   w.session.Format,
		LinkedBy: w.linkedBy,
		Guess:    w.guess,
		Title:    w.session.Title(),
		Command:  w.session.FirstCommand(),
		Started:  w.session.StartedAt(),
		Name:     w.session.Name(),
		Branch:   w.session.Branch(),
		Model:    w.session.Model(),
		Effort:   w.session.Effort(),
	}
	v.Session.Ticket, v.Session.Complexity = w.session.Ticket()
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
	v.Topics = w.session.Topics()
	v.Subagents = w.session.Subagents()
	v.Activity = w.session.Activity()
	return v
}

func (w *watcher) answer(index int) (AnswerView, error) {
	w.lock.Lock()
	defer w.lock.Unlock()
	if w.session == nil {
		return AnswerView{}, errNoSession()
	}
	a, ok := w.session.Answer(index)
	if !ok {
		return AnswerView{}, uimsg.Errorf(uimsg.Make("companion.answergone"), "this answer is no longer kept")
	}
	return a, nil
}

func (w *watcher) diff(path string) (FileDiff, error) {
	w.lock.Lock()
	defer w.lock.Unlock()
	if w.session == nil {
		return FileDiff{}, errNoSession()
	}
	d, ok := w.session.Diff(path)
	if !ok {
		return FileDiff{}, uimsg.Errorf(uimsg.Make("companion.nofilechange"), "no change of this file in the session")
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
