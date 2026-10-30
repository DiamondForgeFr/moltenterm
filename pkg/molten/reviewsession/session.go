// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package reviewsession is wavesrv's side of the review session (FR-REV-004, DS-REV-004, DS-REV-005, DS-REV-011): the
// developer's own Claude Code or Codex, started by MoltenTerm in a terminal of the Review tab, in the PR's worktree,
// read-only, with the molten-review MCP tools. One session per PR; it lives as long as its terminal, which is a durable
// terminal, so it survives a MoltenTerm restart: the session is kept in the terminal block's meta and found again.
// The token minted for a session reaches the agent through its environment only, and a molten-review call is answered
// only for the terminal the token was given to, on a local link.
package reviewsession

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentchoice"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const (
	logPrefix = "molten: review session:"
	// Getting the worktree may fetch the PR's branch.
	startTimeout = 90 * time.Second
	// The shell's first prompt, then the typed line.
	typeTimeout = 30 * time.Second
	maxPosts    = 200
)

var repoPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)

// record is what a session's terminal block keeps (mcpreview.SessionMetaKey). It holds the token: the block meta is in
// MoltenTerm's own database, like the terminal's environment (cmd:env), which holds it too.
type record struct {
	Id           string `json:"id"`
	Token        string `json:"token"`
	Repo         string `json:"repo"`
	Number       int    `json:"number"`
	Title        string `json:"title,omitempty"`
	ProjectDir   string `json:"projectdir"`
	HeadRef      string `json:"headref"`
	HeadOid      string `json:"headoid"`
	BaseRef      string `json:"baseref,omitempty"`
	Worktree     string `json:"worktree"`
	WorktreeKind string `json:"worktreekind"`
	Agent        string `json:"agent"`
	Command      string `json:"command,omitempty"`
	StartedAt    int64  `json:"startedat"`
}

type session struct {
	rec     record
	blockId string
	tabId   string
	state   string
	message string
	// reason: the code of message (mcpreview.Reason…), which the windows show in their language.
	reason string

	selection *mcpreview.SelectionRequest
	// discussed: the comments the developer discussed in this session, the only ones the agent may reply on.
	discussed map[string]bool
	// translation: the latest translation request (FR-REV-010), the only items review_set_translation takes.
	translation *mcpreview.TranslateRequest
	posts       []mcpreview.Post
	nextPost    int
	// postPrefix makes the posts' ids unique across sessions and restarts, as the review store keeps them.
	postPrefix string
	// The questions waiting for the agent to be idle (questions.go).
	questions    []mcpreview.QueuedQuestion
	nextQuestion int
	queueRunning bool
	// queueHold: the last question was typed without Enter, after a draft of the developer's; the next ones wait
	// until the agent has started working on it.
	queueHold bool
	queueNote queueNote
	// baseOid: the merge base of the head with the base branch, read once per head.
	baseOid string
	// sources: the PR's sources for review_context, read once per head (context.go).
	sources *prSources
	// connectedAt: when the agent's review tools first connected (ready.go).
	connectedAt time.Time
}

func (s *session) key() string {
	return sessionKey(s.rec.Repo, s.rec.Number)
}

func sessionKey(repo string, number int) string {
	return strings.ToLower(repo) + "#" + fmt.Sprint(number)
}

func (s *session) info(connected bool) mcpreview.SessionInfo {
	return mcpreview.SessionInfo{
		Id: s.rec.Id, Repo: s.rec.Repo, Number: s.rec.Number, Title: s.rec.Title, ProjectDir: s.rec.ProjectDir,
		HeadRef: s.rec.HeadRef, HeadOid: s.rec.HeadOid, BaseRef: s.rec.BaseRef, Worktree: s.rec.Worktree,
		WorktreeKind: s.rec.WorktreeKind, Agent: s.rec.Agent, AgentName: molten.AgentDisplayName(s.rec.Agent),
		BlockId: s.blockId, TabId: s.tabId, Command: s.rec.Command, State: s.state, Message: s.message, Reason: s.reason,
		StartedAt: s.rec.StartedAt, Connected: connected, Questions: slices.Clone(s.questions), QueueNote: s.queueNote.text,
		QueueNoteReason: s.queueNote.reason, QueueNoteCause: s.queueNote.cause,
	}
}

// queueNote is the question queue's note: wavesrv's English text and its code (mcpreview.ReasonQueue…), with the
// typing path's reason when a queued question failed.
type queueNote struct {
	text   string
	reason string
	cause  string
}

// ReviewBlock is a terminal block that holds a review session.
type ReviewBlock struct {
	BlockId string
	TabId   string
	Meta    waveobj.MetaMapType
}

// Env is what the manager does in wavesrv, injected so tests need none.
type Env struct {
	DataDir string
	// MoltenPath: MoltenTerm's molten command, which serves `molten mcp review`; "" when it is not installed.
	MoltenPath func() string
	Now        func() time.Time
	Git        GitRunner
	// AgentInstalled tells whether an agent's program is on the login PATH.
	AgentInstalled func(agent string) bool
	// AgentOrder: the agent registry's ids, the preferred first.
	AgentOrder []string
	// GlobalAgent and ProjectAgent: the developer's choice of coding agent (agentchoice, #845); nil reads none.
	GlobalAgent  func() string
	ProjectAgent func(dir string) string
	// WriteFile writes a generated file (content-addressed) and returns its path.
	WriteFile func(prefix string, ext string, data []byte) (string, error)
	Guide     func() ([]byte, error)
	// CreateTerminal creates a terminal block in the tab and puts it in the tab's layout: split under afterBlockId
	// when it is in the tab, else added; a block whose meta has mcpreview.HiddenMetaKey stays out of the layout.
	CreateTerminal func(ctx context.Context, tabId string, afterBlockId string, meta waveobj.MetaMapType) (string, error)
	// StartAndType starts the terminal's shell, waits for its first prompt and types the line with Enter.
	StartAndType func(ctx context.Context, tabId string, blockId string, line string) error
	// CloseTerminal deletes the terminal block (its shell and agent end with it).
	CloseTerminal func(ctx context.Context, tabId string, blockId string) error
	// ReviewBlocks lists the blocks holding a review session.
	ReviewBlocks func(ctx context.Context) ([]ReviewBlock, error)
	// BlockExists tells whether a block is still there.
	BlockExists func(ctx context.Context, blockId string) bool
	// VerifyToken returns the terminal block of a WAVETERM_JWT.
	VerifyToken func(token string) (string, error)
	// BlockIsLocal: the terminal's connection is this computer.
	BlockIsLocal func(ctx context.Context, blockId string) bool
	Publish      func(scope string, update mcpreview.Update)
	// ReadFile reads a file of the project (.saasfoundry.json), nil when absent.
	ReadFile func(path string) []byte
	// Locale is the interface language (app:language resolved, DS-I18N-006), e.g. "fr".
	Locale func() string
	// Language is the review:language setting, "" when unset (then Locale decides).
	Language func() string
	// PublishLanguage is the review:publishlanguage setting, "" when unset (FR-REV-010).
	PublishLanguage func() string
	// Gh runs the developer's gh (the PR's sources, read-only).
	Gh GhRunner
	// TypePrompt types a prompt into the agent of a terminal, only when the agent is its foreground program and neither
	// working nor waiting, and submits it unless the prompt may hold an unsent draft of the developer's.
	TypePrompt func(ctx context.Context, blockId string, line string) TypeOutcome
	// SaveRecord writes a session's record back to its terminal block's meta.
	SaveRecord func(ctx context.Context, blockId string, rec any) error
	// AgentRun is the agent's run in a terminal as its state hooks report it (working, waiting, idle…); false when
	// MoltenTerm has no record of one.
	AgentRun func(blockId string) (molten.AgentRunInfo, bool)
	// AgentHooked tells whether the agent of a terminal reported its state through its hooks, so its prompt can be read
	// (ready.go); nil: the manager types without waiting for a starting agent.
	AgentHooked func(blockId string) bool
	// Sleep waits between two looks at a busy agent (questions.go); tests make it instant.
	Sleep func(d time.Duration)
}

// conn is one molten-review server connected to its session.
type conn struct {
	id        string
	source    string
	sessionId string
}

type Manager struct {
	env Env

	lock     sync.Mutex
	loaded   bool
	sessions map[string]*session
	// starting: the keys of PRs whose session is being started.
	starting map[string]bool
	conns    map[string]*conn
}

func MakeManager(env Env) *Manager {
	if env.Now == nil {
		env.Now = time.Now
	}
	return &Manager{env: env, sessions: map[string]*session{}, starting: map[string]bool{}, conns: map[string]*conn{}}
}

// ensureLoaded finds the sessions of the review terminals once: after a restart, their durable terminals are back.
func (m *Manager) ensureLoaded(ctx context.Context) {
	if !m.markLoaded() || m.env.ReviewBlocks == nil {
		return
	}
	blocks, err := m.env.ReviewBlocks(ctx)
	if err != nil {
		log.Printf("%s reading the review terminals: %v\n", logPrefix, err)
		return
	}
	for _, b := range blocks {
		rec, ok := readRecord(b.Meta)
		if !ok {
			continue
		}
		m.addSession(&session{rec: rec, blockId: b.BlockId, tabId: b.TabId, state: mcpreview.StateRunning})
	}
}

func (m *Manager) markLoaded() bool {
	m.lock.Lock()
	defer m.lock.Unlock()
	if m.loaded {
		return false
	}
	m.loaded = true
	return true
}

func readRecord(meta waveobj.MetaMapType) (record, bool) {
	raw, ok := meta[mcpreview.SessionMetaKey]
	if !ok || raw == nil {
		return record{}, false
	}
	var rec record
	if err := reUnmarshal(&rec, raw); err != nil || rec.Id == "" || rec.Token == "" || rec.Repo == "" || rec.Number <= 0 {
		return record{}, false
	}
	return rec, true
}

func (m *Manager) addSession(s *session) {
	m.lock.Lock()
	defer m.lock.Unlock()
	if old := m.sessions[s.key()]; old != nil && old.rec.Id != s.rec.Id {
		// Two terminals for one PR (a copy of the tab): the first one found keeps it.
		return
	}
	m.sessions[s.key()] = s
}

func (m *Manager) find(key mcpreview.SessionKey) *session {
	m.lock.Lock()
	defer m.lock.Unlock()
	if key.Id != "" {
		for _, s := range m.sessions {
			if s.rec.Id == key.Id {
				return s
			}
		}
		return nil
	}
	return m.sessions[sessionKey(key.Repo, key.Number)]
}

func (m *Manager) remove(s *session) bool {
	m.lock.Lock()
	defer m.lock.Unlock()
	if m.sessions[s.key()] != s {
		return false
	}
	delete(m.sessions, s.key())
	for id, c := range m.conns {
		if c.sessionId == s.rec.Id {
			delete(m.conns, id)
		}
	}
	return true
}

func (m *Manager) connected(sessionId string) bool {
	m.lock.Lock()
	defer m.lock.Unlock()
	for _, c := range m.conns {
		if c.sessionId == sessionId {
			return true
		}
	}
	return false
}

func (m *Manager) infoOf(s *session) mcpreview.SessionInfo {
	connected := m.connected(s.rec.Id)
	m.lock.Lock()
	defer m.lock.Unlock()
	return s.info(connected)
}

func (m *Manager) publish(s *session, ended bool) {
	if m.env.Publish == nil {
		return
	}
	info := m.infoOf(s)
	m.env.Publish(mcpreview.ScopeOf(s.rec.Repo, s.rec.Number), mcpreview.Update{Session: &info, Ended: ended})
}

func (m *Manager) setState(s *session, state string, reason string, message string) {
	m.lock.Lock()
	s.state, s.reason, s.message = state, reason, message
	live := m.sessions[s.key()] == s
	m.lock.Unlock()
	if live {
		m.publish(s, false)
	}
}

func (m *Manager) claimStart(key string) bool {
	m.lock.Lock()
	defer m.lock.Unlock()
	if m.starting[key] {
		return false
	}
	m.starting[key] = true
	return true
}

func (m *Manager) releaseStart(key string) {
	m.lock.Lock()
	defer m.lock.Unlock()
	delete(m.starting, key)
}

func checkStart(req mcpreview.StartRequest) error {
	if !repoPattern.MatchString(req.Repo) {
		return fmt.Errorf("repo must be owner/name")
	}
	if req.Number <= 0 {
		return fmt.Errorf("number must be the PR's number")
	}
	if req.ProjectDir == "" || !filepath.IsAbs(req.ProjectDir) {
		return fmt.Errorf("projectdir must be the project's absolute folder")
	}
	if !validRef(req.HeadRef) {
		return fmt.Errorf("headref must be the PR's head branch")
	}
	if req.BaseRef != "" && !validRef(req.BaseRef) {
		return fmt.Errorf("baseref is not a branch name")
	}
	if req.Agent != "" && !isSupportedAgent(req.Agent) {
		return fmt.Errorf("agent must be claude or codex")
	}
	return nil
}

// pickAgent (#845): the requested agent, else the project's choice, else the global default, else the first installed
// in the registry's order. A requested or chosen agent that is not installed is never replaced: the result says so and
// lists the installed agents (Installed) for the developer to pick.
func (m *Manager) pickAgent(requested string, projectDir string) (string, mcpreview.StartResult) {
	resolver := agentchoice.Resolver{Order: m.env.AgentOrder, Installed: m.env.AgentInstalled, Global: m.env.GlobalAgent,
		Project: m.env.ProjectAgent}
	choice := resolver.Resolve(projectDir, requested)
	if choice.Agent != "" {
		return choice.Agent, mcpreview.StartResult{}
	}
	var installed []string
	for _, a := range choice.Agents {
		if a.Installed {
			installed = append(installed, a.Id)
		}
	}
	if choice.Missing {
		name := choice.ChosenName
		return "", mcpreview.StartResult{Status: mcpreview.StatusNoAgent, Reason: mcpreview.ReasonAgentMissing, AgentName: name,
			Installed: installed,
			Message:   fmt.Sprintf("%s is not installed, so the review has no AI. The diff, the comments, publishing and merging work without it.", name)}
	}
	return "", mcpreview.StartResult{Status: mcpreview.StatusNoAgent, Reason: mcpreview.ReasonNotInstalled,
		Message: "No supported coding agent is installed, so the review has no AI. The diff, the comments, publishing and merging work without it."}
}

// Start starts the PR's review session, or reattaches the one it has (its terminal still there). callerTab is the
// calling window's tab, used when the request names none.
func (m *Manager) Start(ctx context.Context, callerTab string, req mcpreview.StartRequest) (mcpreview.StartResult, error) {
	if err := checkStart(req); err != nil {
		return mcpreview.StartResult{}, err
	}
	m.ensureLoaded(ctx)
	key := sessionKey(req.Repo, req.Number)
	if !m.claimStart(key) {
		return mcpreview.StartResult{Status: mcpreview.StatusFailed, Reason: mcpreview.ReasonAlreadyStarting, Message: "This PR's review session is already starting."}, nil
	}
	defer m.releaseStart(key)
	if s := m.find(mcpreview.SessionKey{Repo: req.Repo, Number: req.Number}); s != nil {
		if m.env.BlockExists == nil || m.env.BlockExists(ctx, s.blockId) {
			info := m.infoOf(s)
			return mcpreview.StartResult{Status: mcpreview.StatusAttached, Session: &info}, nil
		}
		m.remove(s)
	}
	agent, none := m.pickAgent(req.Agent, req.ProjectDir)
	if agent == "" {
		return none, nil
	}
	moltenPath := ""
	if m.env.MoltenPath != nil {
		moltenPath = m.env.MoltenPath()
	}
	if moltenPath == "" {
		return mcpreview.StartResult{Status: mcpreview.StatusFailed, Reason: mcpreview.ReasonNoMolten, Message: "MoltenTerm's molten command is not installed: the review tools cannot be given to the agent."}, nil
	}
	tabId := req.TabId
	if tabId == "" {
		tabId = callerTab
	}
	if tabId == "" {
		return mcpreview.StartResult{}, fmt.Errorf("tabid is required")
	}
	startCtx, cancel := context.WithTimeout(ctx, startTimeout)
	defer cancel()
	head, err := resolveHead(startCtx, m.env.Git, req.ProjectDir, req.HeadRef, req.HeadOid)
	if err != nil {
		return mcpreview.StartResult{Status: mcpreview.StatusFailed, Reason: mcpreview.ReasonHead, Message: err.Error()}, nil
	}
	tree, kind, err := ResolveWorktree(startCtx, m.env.Git, m.env.DataDir, req.ProjectDir, req.Number, req.HeadRef, head)
	if err != nil {
		return mcpreview.StartResult{Status: mcpreview.StatusFailed, Reason: mcpreview.ReasonWorktree, Message: err.Error()}, nil
	}
	token, err := newToken()
	if err != nil {
		return mcpreview.StartResult{}, err
	}
	rec := record{
		Id: uuid.NewString(), Token: token, Repo: req.Repo, Number: req.Number, Title: req.Title, ProjectDir: req.ProjectDir,
		HeadRef: req.HeadRef, HeadOid: head, BaseRef: req.BaseRef, Worktree: tree, WorktreeKind: kind, Agent: agent,
		StartedAt: m.env.Now().UnixMilli(),
	}
	prompt := ""
	if req.Brief {
		prompt = mcpreview.BriefingPrompt(head, false)
	}
	rec.Command, err = m.agentCommand(agent, moltenPath, prompt, []string{rec.Worktree, rec.ProjectDir})
	if err != nil {
		return mcpreview.StartResult{Status: mcpreview.StatusFailed, Reason: mcpreview.ReasonCommand, Message: err.Error()}, nil
	}
	meta := waveobj.MetaMapType{
		waveobj.MetaKey_View:       "term",
		waveobj.MetaKey_Controller: "shell",
		waveobj.MetaKey_CmdCwd:     tree,
		waveobj.MetaKey_CmdEnv:     map[string]any{mcpreview.SessionTokenVarName: token},
		mcpreview.SessionMetaKey:   rec,
		// The AI panel shows the agent's cards; its terminal is shown on demand (DS-REV-012, #916).
		mcpreview.HiddenMetaKey: true,
	}
	blockId, err := m.env.CreateTerminal(ctx, tabId, req.AfterBlockId, meta)
	if err != nil {
		return mcpreview.StartResult{Status: mcpreview.StatusFailed, Reason: mcpreview.ReasonTerminal, Message: err.Error()}, nil
	}
	s := &session{rec: rec, blockId: blockId, tabId: tabId, state: mcpreview.StateStarting}
	m.addSession(s)
	log.Printf("%s %s#%d started: %s in %s (%s worktree)\n", logPrefix, rec.Repo, rec.Number, agent, tree, kind)
	m.publish(s, false)
	go m.typeCommand(s)
	info := m.infoOf(s)
	return mcpreview.StartResult{Status: mcpreview.StatusStarted, Session: &info}, nil
}

// typeCommand starts the terminal and types the agent's command line at its first prompt. Without a prompt (the
// developer's startup files ask a question, say), nothing is typed and the session says what to type.
func (m *Manager) typeCommand(s *session) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("%s panic: %v\n", logPrefix, r)
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), typeTimeout)
	defer cancel()
	if m.env.StartAndType == nil {
		return
	}
	if err := m.env.StartAndType(ctx, s.tabId, s.blockId, s.rec.Command); err != nil {
		// The window words it with the session's Command (review.session.reason.notstarted); the message is its detail.
		m.setState(s, mcpreview.StateFailed, mcpreview.ReasonNotStarted, err.Error())
		return
	}
	m.setState(s, mcpreview.StateRunning, "", "")
}

// agentCommand is the command line of the agent's review run; prompt, when set, is its first prompt; untrusted: the folders
// whose agent configuration is the PR's (CodexReviewArgs).
func (m *Manager) agentCommand(agent string, moltenPath string, prompt string, untrusted []string) (string, error) {
	if m.env.Guide == nil || m.env.WriteFile == nil {
		return "", errors.New("the review guide is not available")
	}
	guide, err := m.env.Guide()
	if err != nil {
		return "", fmt.Errorf("the review guide could not be read: %w", err)
	}
	guidePath, err := m.env.WriteFile("review-guide", ".md", guide)
	if err != nil {
		return "", fmt.Errorf("the review guide could not be written: %w", err)
	}
	if agent == molten.AgentIdCodex {
		return CommandLine("codex", withPrompt(CodexReviewArgs(moltenPath, guidePath, untrusted), prompt)), nil
	}
	mcp, err := claudeReviewMcpJSON(moltenPath)
	if err != nil {
		return "", err
	}
	mcpPath, err := m.env.WriteFile("review-mcp", ".json", mcp)
	if err != nil {
		return "", fmt.Errorf("the review tools' configuration could not be written: %w", err)
	}
	return CommandLine("claude", withPrompt(ClaudeReviewArgs(mcpPath, guidePath), prompt)), nil
}

// withPrompt adds the first prompt after "--", so neither CLI reads it as an option or a value of the variadic
// --disallowedTools (agentcontinuity's FreshArgs do the same).
func withPrompt(args []string, prompt string) []string {
	if prompt == "" {
		return args
	}
	return append(args, "--", prompt)
}

func newToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// End ends a PR's session: its terminal is closed, and the agent with it.
func (m *Manager) End(ctx context.Context, key mcpreview.SessionKey) error {
	m.ensureLoaded(ctx)
	s := m.find(key)
	if s == nil {
		return nil
	}
	if m.env.CloseTerminal != nil {
		if err := m.env.CloseTerminal(ctx, s.tabId, s.blockId); err != nil {
			return fmt.Errorf("the review terminal could not be closed: %w", err)
		}
	}
	m.ended(s)
	return nil
}

func (m *Manager) ended(s *session) {
	if !m.remove(s) {
		return
	}
	log.Printf("%s %s#%d ended\n", logPrefix, s.rec.Repo, s.rec.Number)
	m.publish(s, true)
}

// BlockClosed ends the session of a terminal that was closed (its pane, or the Review tab).
func (m *Manager) BlockClosed(blockId string) {
	for _, s := range m.all() {
		if s.blockId == blockId {
			m.ended(s)
		}
	}
}

func (m *Manager) all() []*session {
	m.lock.Lock()
	defer m.lock.Unlock()
	rtn := make([]*session, 0, len(m.sessions))
	for _, s := range m.sessions {
		rtn = append(rtn, s)
	}
	return rtn
}

// Get returns a PR's session, nil when it has none.
func (m *Manager) Get(ctx context.Context, key mcpreview.SessionKey) *mcpreview.SessionInfo {
	m.ensureLoaded(ctx)
	s := m.find(key)
	if s == nil {
		return nil
	}
	info := m.infoOf(s)
	return &info
}

func (m *Manager) List(ctx context.Context) mcpreview.ListResult {
	m.ensureLoaded(ctx)
	rtn := mcpreview.ListResult{Sessions: []mcpreview.SessionInfo{}}
	for _, s := range m.all() {
		rtn.Sessions = append(rtn.Sessions, m.infoOf(s))
	}
	sort.Slice(rtn.Sessions, func(i, j int) bool { return rtn.Sessions[i].StartedAt < rtn.Sessions[j].StartedAt })
	return rtn
}

// SetSelection keeps the developer's selection for review_selection.
func (m *Manager) SetSelection(ctx context.Context, req mcpreview.SelectionRequest) error {
	m.ensureLoaded(ctx)
	s := m.find(req.SessionKey)
	if s == nil {
		return errors.New(mcpreview.ErrSessionEnded)
	}
	if req.Anchor != nil {
		if err := checkAnchor(req.Anchor); err != nil {
			return err
		}
	}
	m.lock.Lock()
	defer m.lock.Unlock()
	if req.Anchor == nil && req.Text == "" {
		s.selection = nil
		return nil
	}
	sel := req
	s.selection = &sel
	return nil
}

// Posts returns what the agent posted in the session.
func (m *Manager) Posts(ctx context.Context, key mcpreview.SessionKey) (mcpreview.PostsResult, error) {
	m.ensureLoaded(ctx)
	s := m.find(key)
	if s == nil {
		return mcpreview.PostsResult{}, errors.New(mcpreview.ErrSessionEnded)
	}
	m.lock.Lock()
	defer m.lock.Unlock()
	return mcpreview.PostsResult{Posts: append([]mcpreview.Post{}, s.posts...)}, nil
}

// Hello connects a molten-review server: its terminal (from the WAVETERM_JWT) must be the session's, on this computer,
// and the request must come from that local terminal's own link (source is "" otherwise).
func (m *Manager) Hello(ctx context.Context, source string, req mcpreview.HelloRequest) (mcpreview.HelloResult, error) {
	if source == "" || req.Token == "" || req.SessionToken == "" || m.env.VerifyToken == nil {
		return mcpreview.HelloResult{}, errors.New(mcpreview.ErrNotInMoltenTerm)
	}
	blockId, err := m.env.VerifyToken(req.Token)
	if err != nil || blockId == "" {
		return mcpreview.HelloResult{}, errors.New(mcpreview.ErrNotInMoltenTerm)
	}
	m.ensureLoaded(ctx)
	s := m.sessionOfToken(req.SessionToken)
	if s == nil || s.blockId != blockId {
		return mcpreview.HelloResult{}, errors.New(mcpreview.ErrNotInMoltenTerm)
	}
	if m.env.BlockIsLocal != nil && !m.env.BlockIsLocal(ctx, blockId) {
		return mcpreview.HelloResult{}, errors.New(mcpreview.ErrRemotePane)
	}
	c := &conn{id: uuid.NewString(), source: source, sessionId: s.rec.Id}
	m.addConn(c)
	m.markConnected(s)
	log.Printf("%s %s#%d tools connected (%s)\n", logPrefix, s.rec.Repo, s.rec.Number, req.ClientName)
	m.publish(s, false)
	return mcpreview.HelloResult{ConnId: c.id, Repo: s.rec.Repo, Number: s.rec.Number}, nil
}

func (m *Manager) sessionOfToken(token string) *session {
	m.lock.Lock()
	defer m.lock.Unlock()
	for _, s := range m.sessions {
		if subtle.ConstantTimeCompare([]byte(s.rec.Token), []byte(token)) == 1 {
			return s
		}
	}
	return nil
}

func (m *Manager) addConn(c *conn) {
	m.lock.Lock()
	defer m.lock.Unlock()
	m.conns[c.id] = c
}

// sessionOfConn returns the session of a connection, when the call comes from the connection's own source.
func (m *Manager) sessionOfConn(connId string, source string) *session {
	m.lock.Lock()
	defer m.lock.Unlock()
	c := m.conns[connId]
	if c == nil || source == "" || c.source != source {
		return nil
	}
	for _, s := range m.sessions {
		if s.rec.Id == c.sessionId {
			return s
		}
	}
	return nil
}

// Bye disconnects a server (its agent quit, or dropped it).
func (m *Manager) Bye(source string, connId string) {
	m.dropConns(func(c *conn) bool { return c.id == connId && c.source == source })
}

// RouteDown disconnects the servers of a route that went away without a bye.
func (m *Manager) RouteDown(route string) {
	m.dropConns(func(c *conn) bool { return c.source == route })
}

func (m *Manager) dropConns(match func(c *conn) bool) {
	var touched []string
	m.lock.Lock()
	for id, c := range m.conns {
		if match(c) {
			delete(m.conns, id)
			touched = append(touched, c.sessionId)
		}
	}
	m.lock.Unlock()
	for _, id := range touched {
		if s := m.find(mcpreview.SessionKey{Id: id}); s != nil {
			m.publish(s, false)
		}
	}
}

// IsReviewBlock tells whether a terminal block holds a review session (coffee mode never answers its prompts).
func IsReviewBlock(meta waveobj.MetaMapType) bool {
	_, ok := readRecord(meta)
	return ok
}
