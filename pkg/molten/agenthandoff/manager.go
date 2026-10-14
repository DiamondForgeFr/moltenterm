// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agenthandoff

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/molten"
)

const (
	// The developer has this long to answer the first send between two agents: under Codex's default 60-second MCP
	// tool timeout, so the agent reads the outcome instead of a timeout.
	DefaultApprovalTimeout = 50 * time.Second
	// A queued handoff waits this long for its receiver's idle prompt.
	DefaultQueueTimeout = time.Hour
	DefaultQueuePoll    = time.Second
	// After a delivery, the next one for the same receiver waits for this turn to start.
	afterDeliveryPause = 3 * time.Second
	// The MCP server asks for the agent's own name at its start, maybe before MoltenTerm sees the agent.
	nameWait     = 2 * time.Second
	nameWaitPoll = 100 * time.Millisecond

	logPrefix = "molten agent handoff:"

	errNotInMoltenTerm = "Not running in a MoltenTerm terminal"
	errRemote          = "Handoffs between agents work in local terminals only, not over SSH or WSL"
	errNotUi           = "only a MoltenTerm window can answer a handoff request"
	errNoAnswer        = "No answer from the developer (50 seconds): nothing was sent. Ask them, then send again."
	errDismissed       = "The developer did not allow this handoff: nothing was sent."
)

// Location is where a pane is now.
type Location struct {
	WorkspaceId   string
	WorkspaceName string
	TabId         string
	TabName       string
	// Folder: the pane's current folder; ProjectDir: the workspace's project when the folder is in it, else the
	// folder's git root, else the folder.
	Folder     string
	ProjectDir string
	Local      bool
}

// TypeResult is what typing the prompt did. Retry: the receiver could not take it now (busy, another program in the
// foreground), try again later.
type TypeResult struct {
	Sent      bool
	Submitted bool
	Retry     bool
	Message   string
}

// Env is what the handoffs need from wavesrv; tests replace it.
type Env interface {
	VerifyToken(token string) (string, error)
	Runs() []molten.AgentRunInfo
	Run(blockId string) (molten.AgentRunInfo, bool)
	Locate(ctx context.Context, blockId string) (Location, error)
	TypePrompt(ctx context.Context, blockId string, line string) TypeResult
	BrowserPage(ctx context.Context, blockId string, tabId int64) (url string, title string, ok bool)
	Notify(input molten.NotificationInput)
	ResolveNotification(key string)
	DataDir() string
}

type pendingAnswer struct {
	pair   string
	answer chan string
}

type delivery struct {
	from      Party
	to        Party
	line      string
	briefPath string
	queuedAt  time.Time
}

type Manager struct {
	env  Env
	now  func() time.Time
	logf func(format string, args ...any)

	approvalTimeout time.Duration
	queueTimeout    time.Duration
	queuePoll       time.Duration
	sleep           func(time.Duration)

	lock sync.Mutex
	// pairs: always or block, for a pair of panes, until MoltenTerm restarts (NFR-CONT-005).
	pairs   map[string]string
	pending map[string]*pendingAnswer
	// queues: the handoffs waiting for a receiver's idle prompt, oldest first; a receiver with a queue has one loop.
	queues map[string][]*delivery
}

func MakeManager(env Env) *Manager {
	return &Manager{
		env:             env,
		now:             time.Now,
		logf:            log.Printf,
		approvalTimeout: DefaultApprovalTimeout,
		queueTimeout:    DefaultQueueTimeout,
		queuePoll:       DefaultQueuePoll,
		sleep:           time.Sleep,
		pairs:           map[string]string{},
		pending:         map[string]*pendingAnswer{},
		queues:          map[string][]*delivery{},
	}
}

// foldName compares first names without case or accents: "jerome" finds Jérôme.
func foldName(name string) string {
	name = strings.ToLower(strings.TrimSpace(name))
	return strings.Map(func(r rune) rune {
		switch r {
		case 'à', 'â', 'ä', 'á', 'ã':
			return 'a'
		case 'é', 'è', 'ê', 'ë':
			return 'e'
		case 'î', 'ï', 'í', 'ì':
			return 'i'
		case 'ô', 'ö', 'ó', 'ò', 'õ':
			return 'o'
		case 'ù', 'û', 'ü', 'ú':
			return 'u'
		case 'ç':
			return 'c'
		case 'ÿ':
			return 'y'
		case 'ñ':
			return 'n'
		}
		return r
	}, name)
}

// capitalize starts a sentence that may begin with "a terminal".
func capitalize(text string) string {
	for i, r := range text {
		return string(unicode.ToUpper(r)) + text[i+utf8.RuneLen(r):]
	}
	return text
}

func pairKey(a string, b string) string {
	if a > b {
		a, b = b, a
	}
	return a + "|" + b
}

func isUiSource(source string) bool {
	return strings.HasPrefix(source, "tab:") || source == "electron"
}

// sender verifies the token and returns its pane, which must be a local terminal.
func (m *Manager) sender(ctx context.Context, token string) (string, Location, error) {
	if token == "" {
		return "", Location{}, errors.New(errNotInMoltenTerm)
	}
	blockId, err := m.env.VerifyToken(token)
	if err != nil || blockId == "" {
		return "", Location{}, errors.New(errNotInMoltenTerm)
	}
	loc, err := m.env.Locate(ctx, blockId)
	if err != nil {
		return "", Location{}, errors.New(errNotInMoltenTerm)
	}
	if !loc.Local {
		return "", Location{}, errors.New(errRemote)
	}
	return blockId, loc, nil
}

func projectName(dir string) string {
	if dir == "" {
		return ""
	}
	base := dir[strings.LastIndexAny(dir, `/\`)+1:]
	if base == "" {
		return dir
	}
	return base
}

func (m *Manager) party(blockId string, run molten.AgentRunInfo, hasRun bool, loc Location) Party {
	p := Party{
		BlockId:    blockId,
		Project:    projectName(loc.ProjectDir),
		ProjectDir: loc.ProjectDir,
		Folder:     loc.Folder,
		Workspace:  loc.WorkspaceName,
		Tab:        loc.TabName,
	}
	p.WorkspaceId = loc.WorkspaceId
	if hasRun && run.Running {
		p.FirstName = run.FirstName
		p.Agent = run.Agent
		p.AgentName = molten.AgentDisplayName(run.Agent)
	}
	return p
}

func entryOf(p Party, state string) AgentEntry {
	return AgentEntry{
		FirstName:  p.FirstName,
		Agent:      p.Agent,
		AgentName:  p.AgentName,
		State:      state,
		Project:    p.Project,
		ProjectDir: p.ProjectDir,
		Folder:     p.Folder,
		Workspace:  p.Workspace,
		Tab:        p.Tab,
	}
}

// waitRun gives the pane's agent run, waiting a little for it to be seen with its first name when asked.
func (m *Manager) waitRun(blockId string, wait bool) (molten.AgentRunInfo, bool) {
	deadline := m.now().Add(nameWait)
	for {
		run, ok := m.env.Run(blockId)
		if (ok && run.Running && run.FirstName != "") || !wait || !m.now().Before(deadline) {
			return run, ok && run.Running
		}
		m.sleep(nameWaitPoll)
	}
}

// activeParties: the local agents with a first name, each with where it is.
func (m *Manager) activeParties(ctx context.Context) []activeAgent {
	var rtn []activeAgent
	for _, run := range m.env.Runs() {
		if !run.Running || run.FirstName == "" {
			continue
		}
		loc, err := m.env.Locate(ctx, run.BlockId)
		if err != nil || !loc.Local {
			continue
		}
		e := activeAgent{AgentEntry: entryOf(m.party(run.BlockId, run, true, loc), run.State), blockId: run.BlockId}
		rtn = append(rtn, e)
	}
	sort.Slice(rtn, func(i, j int) bool {
		a, b := rtn[i], rtn[j]
		if a.Workspace != b.Workspace {
			return a.Workspace < b.Workspace
		}
		if a.Tab != b.Tab {
			return a.Tab < b.Tab
		}
		return foldName(a.FirstName) < foldName(b.FirstName)
	})
	return rtn
}

// List returns the active agents the caller may address, itself marked.
func (m *Manager) List(ctx context.Context, req ListRequest) (ListResult, error) {
	blockId, _, err := m.sender(ctx, req.Token)
	if err != nil {
		return ListResult{}, err
	}
	m.waitRun(blockId, req.WaitName)
	rtn := ListResult{Agents: []AgentEntry{}}
	for _, e := range m.activeParties(ctx) {
		entry := e.AgentEntry
		if e.blockId == blockId {
			entry.You = true
			you := entry
			rtn.You = &you
		}
		rtn.Agents = append(rtn.Agents, entry)
	}
	return rtn, nil
}

func activeNames(entries []activeAgent, except string) string {
	var names []string
	for _, e := range entries {
		if e.blockId == except {
			continue
		}
		names = append(names, fmt.Sprintf("%s (%s, %s)", e.FirstName, e.AgentName, orDash(e.Project)))
	}
	if len(names) == 0 {
		return "no other agent is active"
	}
	return "active agents: " + strings.Join(names, ", ")
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// resolve finds the active agent holding the name: exactly first, then without case or accents.
func resolve(entries []activeAgent, name string) (activeAgent, bool) {
	want := strings.TrimSpace(name)
	for _, e := range entries {
		if strings.EqualFold(e.FirstName, want) {
			return e, true
		}
	}
	var found []activeAgent
	for _, e := range entries {
		if foldName(e.FirstName) == foldName(want) {
			found = append(found, e)
		}
	}
	if len(found) == 1 {
		return found[0], true
	}
	return activeAgent{}, false
}

// Send hands the brief to the agent named To (FR-CONT-015).
func (m *Manager) Send(ctx context.Context, req SendRequest) (SendResult, error) {
	senderId, senderLoc, err := m.sender(ctx, req.Token)
	if err != nil {
		return SendResult{}, err
	}
	senderRun, senderHasRun := m.waitRun(senderId, false)
	from := m.party(senderId, senderRun, senderHasRun, senderLoc)
	brief, err := cleanBrief(req.Brief, senderLoc.Folder)
	if err != nil {
		return SendResult{}, err
	}
	name := cleanLine(req.To)
	if name == "" {
		return SendResult{}, errors.New("name the agent to send to (its first name, see list_agents)")
	}
	active := m.activeParties(ctx)
	target, ok := resolve(active, name)
	if !ok {
		return SendResult{}, fmt.Errorf("No active agent is named %q: %s. A subagent has no first name and cannot be addressed.", name, activeNames(active, senderId))
	}
	if target.blockId == senderId {
		return SendResult{}, fmt.Errorf("%s is you: name another agent (%s)", target.FirstName, activeNames(active, senderId))
	}
	targetLoc, err := m.env.Locate(ctx, target.blockId)
	if err != nil {
		return SendResult{}, fmt.Errorf("%s's terminal could not be found", target.FirstName)
	}
	targetRun, _ := m.env.Run(target.blockId)
	to := m.party(target.blockId, targetRun, true, targetLoc)
	if err := m.resolveBrowserLinks(ctx, senderId, &brief); err != nil {
		return SendResult{}, err
	}
	if err := m.approve(ctx, from, to, brief); err != nil {
		m.logf("%s from=%q to=%q refused: %v\n", logPrefix, from.callName(), to.callName(), err)
		return SendResult{}, err
	}
	path, err := writeBrief(m.env.DataDir(), from, to, brief, m.now())
	if err != nil {
		return SendResult{}, fmt.Errorf("MoltenTerm could not write the brief: %v", err)
	}
	d := &delivery{from: from, to: to, line: promptLine(from, brief, path), briefPath: path, queuedAt: m.now()}
	return m.deliver(ctx, d)
}

// resolveBrowserLinks reads the pages of the sender's browser tabs a link names by id.
func (m *Manager) resolveBrowserLinks(ctx context.Context, senderId string, b *Brief) error {
	for i := range b.Links {
		l := &b.Links[i]
		if l.TabId <= 0 {
			continue
		}
		url, title, ok := m.env.BrowserPage(ctx, senderId, l.TabId)
		if !ok {
			return fmt.Errorf("browser tab %d is not one of your open MoltenTerm browser tabs with a web page (see tabs_context)", l.TabId)
		}
		l.Url = url
		if l.Title == "" {
			l.Title = title
		}
	}
	return nil
}

func (m *Manager) pairDecision(key string) string {
	m.lock.Lock()
	defer m.lock.Unlock()
	return m.pairs[key]
}

func (m *Manager) setPairDecision(key string, decision string) {
	m.lock.Lock()
	defer m.lock.Unlock()
	m.pairs[key] = decision
}

func (m *Manager) addPending(id string, p *pendingAnswer) {
	m.lock.Lock()
	defer m.lock.Unlock()
	m.pending[id] = p
}

func (m *Manager) takePending(id string) *pendingAnswer {
	m.lock.Lock()
	defer m.lock.Unlock()
	p := m.pending[id]
	delete(m.pending, id)
	return p
}

// approve asks the developer for the first send between two panes (NFR-CONT-005): Allow once, Always for this pair,
// Block. Nothing else answers it: coffee mode approves agents' own permission requests, never this one.
func (m *Manager) approve(ctx context.Context, from Party, to Party, b Brief) error {
	key := pairKey(from.BlockId, to.BlockId)
	switch m.pairDecision(key) {
	case DecisionAlways:
		return nil
	case DecisionBlock:
		return fmt.Errorf("The developer blocked handoffs between %s and %s until MoltenTerm restarts: nothing was sent.", from.callName(), to.callName())
	}
	id := uuid.NewString()
	p := &pendingAnswer{pair: key, answer: make(chan string, 1)}
	m.addPending(id, p)
	notifKey := NotificationKeyPrefix + id
	m.env.Notify(approvalNotification(notifKey, id, from, to, b))
	defer m.env.ResolveNotification(notifKey)
	timer := time.NewTimer(m.approvalTimeout)
	defer timer.Stop()
	var decision string
	select {
	case decision = <-p.answer:
	case <-timer.C:
		m.takePending(id)
		return errors.New(errNoAnswer)
	case <-ctx.Done():
		m.takePending(id)
		return errors.New("Cancelled: nothing was sent.")
	}
	switch decision {
	case DecisionOnce:
		return nil
	case DecisionAlways:
		m.setPairDecision(key, DecisionAlways)
		return nil
	case DecisionBlock:
		m.setPairDecision(key, DecisionBlock)
		return fmt.Errorf("The developer blocked handoffs between %s and %s: nothing was sent.", from.callName(), to.callName())
	}
	return errors.New(errDismissed)
}

func approvalNotification(key string, id string, from Party, to Party, b Brief) molten.NotificationInput {
	action := func(actionId string, label string, decision string) molten.NotificationAction {
		return molten.NotificationAction{Id: actionId, Label: label, Kind: "gesture", Gesture: AnswerGesture,
			Args: map[string]any{"requestid": id, "decision": decision}}
	}
	fromWhere := from.label()
	if from.Project != "" {
		fromWhere += " in " + from.Project
	}
	toWhere := to.label()
	if to.Project != "" {
		toWhere += " in " + to.Project
	}
	return molten.NotificationInput{
		Key:    key,
		Source: NotificationSource,
		Title:  capitalize(fmt.Sprintf("%s wants to hand work to %s", from.callName(), to.callName())),
		Message: fmt.Sprintf("%s → %s: %s. Allowing it types a prompt in %s's terminal.", capitalize(fromWhere), toWhere,
			cut(cleanLine(b.Goal), 160), to.callName()),
		Kind:        "warning",
		WorkspaceId: from.WorkspaceId,
		Actions: []molten.NotificationAction{
			action("once", "Allow once", DecisionOnce),
			action("always", "Always for this pair", DecisionAlways),
			action("block", "Block", DecisionBlock),
		},
	}
}

// Answer is the developer's answer from a window.
func (m *Manager) Answer(source string, req AnswerRequest) error {
	if !isUiSource(source) {
		return errors.New(errNotUi)
	}
	switch req.Decision {
	case DecisionOnce, DecisionAlways, DecisionBlock, DecisionDismiss:
	default:
		return fmt.Errorf("unknown decision %q", req.Decision)
	}
	p := m.takePending(req.RequestId)
	if p == nil {
		return errors.New("This handoff request is no longer waiting")
	}
	p.answer <- req.Decision
	return nil
}

func receiverBusy(run molten.AgentRunInfo) bool {
	return run.State == molten.AgentStateWorking || run.State == molten.AgentStateWaiting
}

// deliver types the prompt now when the receiver's prompt is idle, else queues it.
func (m *Manager) deliver(ctx context.Context, d *delivery) (SendResult, error) {
	rtn := SendResult{To: d.to.FirstName, BriefPath: d.briefPath}
	reason := "it is working or waiting for an answer"
	if m.hasQueue(d.to.BlockId) {
		reason = "other handoffs wait before this one"
	} else {
		if run, ok := m.env.Run(d.to.BlockId); ok && run.Running && !receiverBusy(run) {
			out := m.env.TypePrompt(ctx, d.to.BlockId, d.line)
			if out.Sent {
				m.logf("%s from=%q to=%q delivered submitted=%v\n", logPrefix, d.from.callName(), d.to.callName(), out.Submitted)
				if out.Submitted {
					rtn.Status, rtn.Message = StatusDelivered, fmt.Sprintf("Sent to %s. The brief is at %s.", d.to.FirstName, d.briefPath)
					return rtn, nil
				}
				rtn.Status = StatusTyped
				rtn.Message = fmt.Sprintf("Typed in %s's prompt without Enter, because the developer may have an unsent message there: "+
					"it starts when they press Enter. The brief is at %s.", d.to.FirstName, d.briefPath)
				return rtn, nil
			}
			if !out.Retry {
				m.logf("%s from=%q to=%q not delivered: %s\n", logPrefix, d.from.callName(), d.to.callName(), out.Message)
				return SendResult{}, fmt.Errorf("Not delivered to %s: %s The brief is at %s.", d.to.FirstName, out.Message, d.briefPath)
			}
			reason = out.Message
		}
	}
	m.enqueue(d)
	m.logf("%s from=%q to=%q queued: %s\n", logPrefix, d.from.callName(), d.to.callName(), reason)
	rtn.Status = StatusQueued
	rtn.Message = fmt.Sprintf("%s cannot take it now (%s): the handoff is queued and typed in its terminal when its prompt is "+
		"idle (within an hour). The brief is at %s.", d.to.FirstName, strings.TrimSuffix(reason, "."), d.briefPath)
	return rtn, nil
}

func (m *Manager) hasQueue(blockId string) bool {
	m.lock.Lock()
	defer m.lock.Unlock()
	return len(m.queues[blockId]) > 0
}

// enqueue adds the delivery; the first one of a receiver starts its loop.
func (m *Manager) enqueue(d *delivery) {
	if m.pushQueue(d) {
		go m.runQueue(d.to.BlockId)
	}
}

func (m *Manager) pushQueue(d *delivery) bool {
	m.lock.Lock()
	defer m.lock.Unlock()
	start := len(m.queues[d.to.BlockId]) == 0
	m.queues[d.to.BlockId] = append(m.queues[d.to.BlockId], d)
	return start
}

func (m *Manager) peekQueue(blockId string) *delivery {
	m.lock.Lock()
	defer m.lock.Unlock()
	q := m.queues[blockId]
	if len(q) == 0 {
		return nil
	}
	return q[0]
}

// popQueue removes the head and tells whether more wait.
func (m *Manager) popQueue(blockId string) bool {
	m.lock.Lock()
	defer m.lock.Unlock()
	q := m.queues[blockId]
	if len(q) <= 1 {
		delete(m.queues, blockId)
		return false
	}
	m.queues[blockId] = q[1:]
	return true
}

// dropQueue empties a receiver's queue and returns what was in it.
func (m *Manager) dropQueue(blockId string) []*delivery {
	m.lock.Lock()
	defer m.lock.Unlock()
	q := m.queues[blockId]
	delete(m.queues, blockId)
	return q
}

func (m *Manager) runQueue(blockId string) {
	defer func() {
		if r := recover(); r != nil {
			m.logf("%s queue panic: %v\n", logPrefix, r)
		}
	}()
	lastRefusal := ""
	for {
		d := m.peekQueue(blockId)
		if d == nil {
			return
		}
		run, ok := m.env.Run(blockId)
		if !ok || !run.Running || run.FirstName == "" {
			for _, gone := range m.dropQueue(blockId) {
				m.notifyUndelivered(gone, fmt.Sprintf("%s ended before its prompt was idle.", gone.to.callName()))
			}
			return
		}
		if m.now().Sub(d.queuedAt) > m.queueTimeout {
			m.notifyUndelivered(d, fmt.Sprintf("%s's prompt was not idle within an hour.", d.to.callName()))
			if !m.popQueue(blockId) {
				return
			}
			continue
		}
		if receiverBusy(run) {
			m.sleep(m.queuePoll)
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		out := m.env.TypePrompt(ctx, blockId, d.line)
		cancel()
		if !out.Sent && out.Retry {
			if out.Message != lastRefusal {
				lastRefusal = out.Message
				m.logf("%s to=%q waiting: %s\n", logPrefix, d.to.callName(), out.Message)
			}
			m.sleep(m.queuePoll)
			continue
		}
		if out.Sent {
			m.logf("%s from=%q to=%q delivered from the queue submitted=%v\n", logPrefix, d.from.callName(), d.to.callName(), out.Submitted)
		} else {
			m.notifyUndelivered(d, out.Message)
		}
		if !m.popQueue(blockId) {
			return
		}
		m.sleep(afterDeliveryPause)
	}
}

func (m *Manager) notifyUndelivered(d *delivery, reason string) {
	m.logf("%s from=%q to=%q not delivered: %s\n", logPrefix, d.from.callName(), d.to.callName(), reason)
	m.env.Notify(molten.NotificationInput{
		Source:  NotificationSource,
		Title:   capitalize(fmt.Sprintf("%s's handoff to %s was not delivered", d.from.callName(), d.to.callName())),
		Message: fmt.Sprintf("%s The brief is at %s.", reason, d.briefPath),
		Kind:    "error",
	})
}
