// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Package brokksession is Brokk's own terminal session (FR-BOSS-009, AC15, #2003): the agent the field at the foot of his
// panel talks to. It is the coding agent the developer chose for MoltenTerm, in a terminal of a hidden tab (#758) named
// after him, working in his own folder in MoltenTerm's data folder, never a project's. The first message starts it; the
// next ones go to the same terminal, which a restart finds again by the marker in its metadata. The ring around his
// avatar turns while that terminal's agent works. The workshop of FR-BOSS-004 (setup view, brief, journal, sandbox) is
// a later story: this session is a plain agent terminal.
package brokksession

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const (
	// BlockMetaKey marks the terminal of Brokk's session; must match frontend/moltenterm-shell/boss/brokk-session.ts.
	BlockMetaKey = molten.OwnSessionMetaKey
	// FolderName is his own folder, under MoltenTerm's data folder.
	FolderName = "brokk"
	// DefaultTabName names the hidden tab when the window sent none.
	DefaultTabName = "Brokk"

	// Status…: what a call answered; must match frontend/moltenterm-shell/boss/brokk-session.ts.
	// StatusNone: no session exists; StatusReady: one does; StatusSent: the text reached the agent; StatusBusy: the
	// agent could not take it now (the field keeps the text); StatusNoAgent and StatusMissing: no agent to start, or
	// the chosen one is not installed; StatusFailed: the session could not be made or reached.
	StatusNone    = "none"
	StatusReady   = "ready"
	StatusSent    = "sent"
	StatusBusy    = "busy"
	StatusNoAgent = "noagent"
	StatusMissing = "agentmissing"
	StatusFailed  = "failed"

	// Reason…: why a call failed or was busy, for the window to say in the interface language.
	ReasonNoText     = "notext"
	ReasonNoSpace    = "nospace"
	ReasonTerminal   = "terminal"
	ReasonGone       = "gone"
	ReasonNotReady   = "notready"
	ReasonInProgress = "inprogress"
	ReasonRefused    = "refused"
	ReasonNoAgent    = "noagent"
	// ReasonNotSubmitted: the message was typed in his agent's prompt without Enter (#2028).
	ReasonNotSubmitted = "notsubmitted"
	// ReasonLookup: looking for his session failed (#2220), which is not "no session" (#2236).
	ReasonLookup = "lookup"

	// Reply…: what Reply answered; must match frontend/moltenterm-shell/boss/brokk-talk-model.ts. ReplyAnswer: his answer
	// to the message; ReplyWaiting: none newer than the message yet; ReplyUnread: his transcript is not known, so the
	// answer is only in his terminal (StatusNone: no session).
	ReplyAnswer  = "answer"
	ReplyWaiting = "waiting"
	ReplyUnread  = "unread"

	// A message is one prompt the agent reads (its line breaks kept, #2237), of at most this many characters: the window's field
	// (brokk-talk-model.ts MaxMessageLength) and the typing path (termupdate.MaxTypedMessage) take as many.
	MaxTextLength = 4000

	// An agent just started shows its prompt after a while; the text waits for it this long, checking this often.
	startWait = 90 * time.Second
	startPoll = time.Second
)

// Request is a window's call: WorkspaceId is where the hidden tab goes when the session has to be started, Name the tab's
// name (his name), Text the message.
type Request struct {
	WorkspaceId string `json:"workspaceid,omitempty"`
	Name        string `json:"name,omitempty"`
	Text        string `json:"text,omitempty"`
}

type Result struct {
	Status      string `json:"status"`
	Reason      string `json:"reason,omitempty"`
	BlockId     string `json:"blockid,omitempty"`
	TabId       string `json:"tabid,omitempty"`
	WorkspaceId string `json:"workspaceid,omitempty"`
	Agent     string `json:"agent,omitempty"`
	AgentName string `json:"agentname,omitempty"`
	// Started: this call started the session.
	Started bool `json:"started,omitempty"`
	// Message stays English: the detail of a refusal or an error, for the log and the tooltip.
	Message string `json:"message,omitempty"`
}

// Found is a session that exists.
type Found struct {
	BlockId     string
	TabId       string
	WorkspaceId string
}

// ReplyRequest asks for his answer to a message sent at After (Unix milliseconds). With an Index it asks for the answer
// of that turn instead, whatever came after it (#2033): the window reads a first answer to its end once a second message
// has started a newer turn.
type ReplyRequest struct {
	After int64 `json:"after,omitempty"`
	Index int   `json:"index,omitempty"`
}

// Reply is his latest answer, and where his terminal is: the way out when the answer cannot be read.
type Reply struct {
	Status      string `json:"status"`
	BlockId     string `json:"blockid,omitempty"`
	TabId       string `json:"tabid,omitempty"`
	WorkspaceId string `json:"workspaceid,omitempty"`
	Index       int    `json:"index,omitempty"`
	Rev         int64  `json:"rev,omitempty"`
	At          int64  `json:"at,omitempty"`
	Markdown    string `json:"markdown,omitempty"`
}

// Answer is the last answer his transcript holds; Markdown is empty before the first one.
type Answer struct {
	Index    int
	Rev      int64
	At       int64
	Markdown string
}

// TypeOutcome is what typing the message into the session did; Retry: the agent cannot take it now; Gone: its terminal
// is closed or its shell ended.
type TypeOutcome struct {
	Sent bool
	// Unsubmitted: typed in the prompt without Enter, since a draft may be there.
	Unsubmitted bool
	Retry bool
	Gone  bool
	// NoAgent: no coding agent runs in the terminal: the one just started is not up yet, or the one that ran has ended.
	NoAgent bool
	Message string
}

// Env is what the service reaches outside itself; the tests give fakes.
type Env struct {
	// Find looks for the terminal that carries BlockMetaKey. An error is a lookup that failed, never "not found": a
	// slow or failing database must not start a second session (#2220).
	Find func(ctx context.Context) (Found, bool, error)
	// Folder is his own folder, made when it does not exist.
	Folder func() (string, error)
	// PickAgent resolves the developer's coding agent for the folder: its id and display name, or "" when none can
	// start; missing: the chosen one is not installed.
	PickAgent func(dir string) (agent string, name string, missing bool)
	// CommandLine is the line typed in the shell to start the agent.
	CommandLine func(agent string) string
	// AgentTab makes the hidden tab; CloseTab takes it away when its terminal could not be made.
	AgentTab func(ctx context.Context, workspaceId string, name string, meta waveobj.MetaMapType) (string, error)
	CloseTab func(ctx context.Context, tabId string) error
	// OpenTerminal creates the terminal in the tab and types line at its first prompt.
	OpenTerminal func(ctx context.Context, tabId string, meta waveobj.MetaMapType, line string) (string, error)
	Type         func(ctx context.Context, blockId string, line string) TypeOutcome
	// Ready tells whether the agent in the block takes a typed line with Enter now (its hooks report, no draft).
	Ready func(blockId string) bool
	// Sleep waits d, false when ctx ended first.
	Sleep func(ctx context.Context, d time.Duration) bool
	// ReadAnswer reads an answer of the agent in the block from its transcript: the last one for index 0, else the
	// answer of that turn (empty when it is not there); false: its transcript is not known, the answer is only in the
	// terminal.
	ReadAnswer func(blockId string, index int) (Answer, bool)
	// ChosenAgent is the agent the developer explicitly chose for the folder and that is installed: never the order's
	// fallback, which would use a subscription nobody pointed at (#2203).
	ChosenAgent func(dir string) (agent string, ok bool)
	// RunPrint runs the agent's cheap, read-only, non-interactive form in dir with the prompt on its standard input and
	// returns what it printed (#2203).
	RunPrint func(ctx context.Context, dir string, agent string, prompt string) ([]byte, error)
	// Now is the clock of the limits on phrasings; time.Now when nil.
	Now func() time.Time
	// PhrasesPerDay is how many phrasings a local day allows; MaxPhrasesPerDay when zero.
	PhrasesPerDay int
	// LoadBudget reads the count of phrasings kept by SaveBudget, so that a restart does not give the day's budget
	// back; nil keeps the count in memory only.
	LoadBudget func() PhraseBudget
	SaveBudget func(budget PhraseBudget)
}

type Service struct {
	env Env

	lock     sync.Mutex
	working  bool
	phrasing bool
	// When each phrasing of the last hour started.
	phrased []time.Time
	// The phrasings started on the local day budget.Day; read from the Env at the first one.
	budget       PhraseBudget
	budgetLoaded bool
}

func MakeService(env Env) *Service {
	return &Service{env: env}
}

// claim lets one call start or talk at a time: a second one is told it is busy rather than queued behind a wait of
// up to startWait.
func (s *Service) claim() bool {
	s.lock.Lock()
	defer s.lock.Unlock()
	if s.working {
		return false
	}
	s.working = true
	return true
}

func (s *Service) release() {
	s.lock.Lock()
	defer s.lock.Unlock()
	s.working = false
}

func findFailed(err error) Result {
	return Result{Status: StatusFailed, Reason: ReasonLookup, Message: fmt.Sprintf("His session could not be looked for: %v", err)}
}

// Session says whether his session exists, and where. It starts nothing.
func (s *Service) Session(ctx context.Context) Result {
	if s.env.Find == nil {
		return Result{Status: StatusNone}
	}
	found, ok, err := s.env.Find(ctx)
	if err != nil {
		return findFailed(err)
	}
	if !ok {
		return Result{Status: StatusNone}
	}
	return Result{Status: StatusReady, BlockId: found.BlockId, TabId: found.TabId, WorkspaceId: found.WorkspaceId}
}

// Reply is his answer to the message sent at req.After, or the answer of the turn req.Index (#2028, #2033): his session
// answers in a hidden tab, and the window shows that answer. It starts nothing and never waits.
func (s *Service) Reply(ctx context.Context, req ReplyRequest) Reply {
	if s.env.Find == nil {
		return Reply{Status: StatusNone}
	}
	found, ok, err := s.env.Find(ctx)
	if err != nil {
		return Reply{Status: StatusFailed}
	}
	if !ok {
		return Reply{Status: StatusNone}
	}
	rtn := Reply{Status: ReplyUnread, BlockId: found.BlockId, TabId: found.TabId, WorkspaceId: found.WorkspaceId}
	if s.env.ReadAnswer == nil {
		return rtn
	}
	answer, linked := s.env.ReadAnswer(found.BlockId, req.Index)
	if !linked {
		return rtn
	}
	// An answer older than the message is the one to the message before; a turn asked for by its index is the answer
	// to its own message, whenever it was written.
	if answer.Markdown == "" || (req.Index <= 0 && answer.At < req.After) {
		rtn.Status = ReplyWaiting
		return rtn
	}
	rtn.Status = ReplyAnswer
	rtn.Index, rtn.Rev, rtn.At, rtn.Markdown = answer.Index, answer.Rev, answer.At, answer.Markdown
	return rtn
}

// Say gives the message to his session, starting it first when it does not exist.
func (s *Service) Say(ctx context.Context, req Request) Result {
	text := strings.TrimSpace(req.Text)
	if text == "" || utf8.RuneCountInString(text) > MaxTextLength {
		return Result{Status: StatusFailed, Reason: ReasonNoText, Message: "There is no message to give, or it is too long."}
	}
	if !s.claim() {
		return Result{Status: StatusBusy, Reason: ReasonInProgress, Message: "The previous message is still on its way."}
	}
	defer s.release()
	found, ok, err := s.env.Find(ctx)
	if err != nil {
		return findFailed(err)
	}
	result := Result{}
	fresh := false
	if !ok {
		var failed bool
		found, result, failed = s.start(ctx, req)
		if failed {
			return result
		}
		fresh = true
	}
	out := s.deliver(ctx, found.BlockId, text, fresh)
	result.BlockId, result.TabId, result.WorkspaceId = found.BlockId, found.TabId, found.WorkspaceId
	result.Started = fresh
	result.Status, result.Reason, result.Message = out.Status, out.Reason, out.Message
	return result
}

// start makes the hidden tab and the terminal, and starts the agent in it. failed: the answer is final.
func (s *Service) start(ctx context.Context, req Request) (Found, Result, bool) {
	if req.WorkspaceId == "" {
		return Found{}, Result{Status: StatusFailed, Reason: ReasonNoSpace, Message: "No workspace to put his tab in."}, true
	}
	dir, err := s.env.Folder()
	if err != nil {
		return Found{}, Result{Status: StatusFailed, Reason: ReasonTerminal, Message: fmt.Sprintf("His folder could not be made: %v", err)}, true
	}
	agent, name, missing := s.env.PickAgent(dir)
	if agent == "" {
		status := StatusNoAgent
		if missing {
			status = StatusMissing
		}
		return Found{}, Result{Status: status, AgentName: name, Message: "No coding agent can start."}, true
	}
	tabName := req.Name
	if tabName == "" {
		tabName = DefaultTabName
	}
	tabId, err := s.env.AgentTab(ctx, req.WorkspaceId, tabName, waveobj.MetaMapType{BlockMetaKey: true})
	if err != nil {
		return Found{}, Result{Status: StatusFailed, Reason: ReasonTerminal, Message: fmt.Sprintf("His tab could not be made: %v", err)}, true
	}
	meta := waveobj.MetaMapType{
		waveobj.MetaKey_View:       "term",
		waveobj.MetaKey_Controller: "shell",
		waveobj.MetaKey_CmdCwd:     dir,
		BlockMetaKey:               true,
	}
	blockId, err := s.env.OpenTerminal(ctx, tabId, meta, s.env.CommandLine(agent))
	if blockId == "" {
		if s.env.CloseTab != nil {
			_ = s.env.CloseTab(ctx, tabId)
		}
		return Found{}, Result{Status: StatusFailed, Reason: ReasonTerminal, Message: fmt.Sprintf("His terminal could not be made: %v", err)}, true
	}
	// A terminal whose agent did not start still exists: the text waits for a prompt that may never come, and the
	// developer sees the answer in the hidden tab.
	return Found{BlockId: blockId, TabId: tabId, WorkspaceId: req.WorkspaceId}, Result{Agent: agent, AgentName: name}, false
}

type delivery struct {
	Status  string
	Reason  string
	Message string
}

// deliver types the message. A session just started is given until startWait to show its prompt; one that runs is asked
// once, and a busy agent is told to the developer, whose text stays in the field.
func (s *Service) deliver(ctx context.Context, blockId string, text string, fresh bool) delivery {
	for attempt := 0; ; attempt++ {
		// A line typed while the agent just started still draws its prompt is lost, or left there without Enter
		// (#2028): the first message waits until the agent takes it, then is typed anyway once startWait is over.
		if fresh && s.env.Ready != nil && attempt < int(startWait/startPoll) && !s.env.Ready(blockId) {
			if !s.env.Sleep(ctx, startPoll) {
				return delivery{Status: StatusBusy, Reason: ReasonNotReady}
			}
			continue
		}
		out := s.env.Type(ctx, blockId, text)
		if out.Sent && out.Unsubmitted {
			return delivery{Status: StatusFailed, Reason: ReasonNotSubmitted, Message: out.Message}
		}
		if out.Sent {
			return delivery{Status: StatusSent}
		}
		if out.Gone {
			return delivery{Status: StatusFailed, Reason: ReasonGone, Message: out.Message}
		}
		// The agent just started shows in the terminal a moment after its command; one that was there and ended does not come back.
		if out.NoAgent && !fresh {
			return delivery{Status: StatusFailed, Reason: ReasonNoAgent, Message: out.Message}
		}
		if !out.Retry && !out.NoAgent {
			return delivery{Status: StatusFailed, Reason: ReasonRefused, Message: out.Message}
		}
		if !fresh || attempt >= int(startWait/startPoll) {
			return delivery{Status: StatusBusy, Reason: ReasonNotReady, Message: out.Message}
		}
		if !s.env.Sleep(ctx, startPoll) {
			return delivery{Status: StatusBusy, Reason: ReasonNotReady, Message: out.Message}
		}
	}
}
