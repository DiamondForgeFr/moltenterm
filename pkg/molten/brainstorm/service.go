// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brainstorm

import (
	"strings"
	"sync"
	"time"
)

// The brainstorm mode (FR-BOSS-010 AC2, DS-BOSS-011): one for the whole app, kept here so that every view of every window
// shows the same layer and a tab switch keeps it. The developer opens it ("you", from Brokk's menu) or his answer does
// ("brokk", a block with a central idea: he detected a brainstorm). Each turn of the conversation that follows comes
// here with his block: the block grows the graph of the brainstorm, and the folder is written at once.

const (
	ByYou   = "you"
	ByBrokk = "brokk"

	// A message or an answer kept in conversation.jsonl is cut past this many characters.
	maxTurnText = 20000
)

// Summary is what the views show of a brainstorm: the widget's title, folder, times and state.
type Summary struct {
	Id      string `json:"id,omitempty"`
	Slug    string `json:"slug"`
	Title   string `json:"title"`
	Dir     string `json:"dir"`
	Created int64  `json:"created"`
	Updated int64  `json:"updated"`
	State   string `json:"state,omitempty"`
	Turns   int    `json:"turns"`
	// PromotedTo: the project folder it became, and its workspace (#2250).
	PromotedTo *Promotion `json:"promotedto,omitempty"`
}

// State is what every view reads back after the event. Version counts from 0 in each wavesrv: Session names the one
// that counted it, so that a view does not drop a restarted wavesrv's states as older than the ones it had.
// Swap counts the brainstorms the developer moved to (load, new idea, a fork's Yes: the stage starts its camera over);
// ListRev counts the changes of the folders' list (a folder made, renamed, forgotten: the widget reads the list again).
type State struct {
	Allowed bool   `json:"allowed"`
	Open    bool   `json:"open"`
	By      string `json:"by,omitempty"`
	Session string `json:"session,omitempty"`
	Version int64  `json:"version"`
	Swap    int64  `json:"swap"`
	ListRev int64  `json:"listrev"`
	// CanTrash: a forgotten folder goes to the system trash; when false the confirmation says it is removed for good.
	CanTrash   bool     `json:"cantrash"`
	Brainstorm *Summary `json:"brainstorm,omitempty"`
	Graph      *Graph   `json:"graph,omitempty"`
	SavedAt    int64    `json:"savedat,omitempty"`
	SaveError  string   `json:"saveerror,omitempty"`
	// History: the brainstorm's last operations, who made each, and whether it can be put back (#2247).
	History []HistoryNote `json:"history,omitempty"`
	// Brief: the project brief of Brokk's conclusion, for the project card (#2250).
	Brief *ProjectBrief `json:"brief,omitempty"`
	// Geargrim: DiamondForge offers the hand-off of a brief to Geargrim (AC14). False in MoltenTerm 1.0.0.
	Geargrim bool `json:"geargrim,omitempty"`
}

type OpenRequest struct {
	By string `json:"by"`
}

// SlugRequest names a brainstorm by its slug, the one name of a folder a window may give (#2248).
type SlugRequest struct {
	Slug string `json:"slug"`
}

// DeleteRequest is the developer's confirmation of a forget: the brainstorm's slug and id as the question showed it,
// and Permanent when it said the folder is removed for good (a system with no trash).
type DeleteRequest struct {
	Slug      string `json:"slug"`
	Id        string `json:"id"`
	Permanent bool   `json:"permanent,omitempty"`
}

type RenameRequest struct {
	Slug  string `json:"slug"`
	Title string `json:"title"`
}

type FindRequest struct {
	Title string `json:"title"`
}

type ForkRequest struct {
	Title  string `json:"title"`
	Reason string `json:"reason,omitempty"`
}

type ListResult struct {
	Brainstorms []Summary `json:"brainstorms"`
}

type FindResult struct {
	Match *Summary `json:"match,omitempty"`
}

// LoadResult is the state once the brainstorm is open, and its conversation for his talk window.
type LoadResult struct {
	State State  `json:"state"`
	Turns []Turn `json:"turns"`
	// ResumeBrief: his folder holds this brainstorm's resume brief; without it, his session is not told to read one.
	ResumeBrief bool   `json:"resumebrief,omitempty"`
	Error       string `json:"error,omitempty"`
}

type ActionResult struct {
	State   State    `json:"state"`
	Summary *Summary `json:"summary,omitempty"`
	Trashed bool     `json:"trashed,omitempty"`
	Error   string   `json:"error,omitempty"`
}

// TurnRequest is one exchange: the developer's message, his answer without its blocks, his graph block if it had one.
// Key names the answer, so that a view reading it twice applies it once.
// Swap: the state's swap when the window saw the answer begin. An answer that began before the developer moved to
// another brainstorm (load, new idea, a fork's Yes, a forget of the open one) belongs to the one left: it is refused,
// never stored in the next one's conversation nor allowed to start a folder (review of #2248). Nil: the window did not
// know the state yet.
type TurnRequest struct {
	Key   string `json:"key"`
	You   string `json:"you"`
	Brokk string `json:"brokk"`
	Block *Block `json:"block,omitempty"`
	At    int64  `json:"at"`
	Swap  *int64 `json:"swap,omitempty"`
	// Late: the answer began while the mode was open, and the developer left before it ended (#2284). Leaving never
	// cuts his work: it is saved in the brainstorm left (same Swap), without opening the mode again.
	Late bool `json:"late,omitempty"`
}

type TurnResult struct {
	State     State    `json:"state"`
	Applied   bool     `json:"applied"`
	Dropped   bool     `json:"dropped"`
	Duplicate bool     `json:"duplicate"`
	Stale     bool     `json:"stale,omitempty"`
	Added     []string `json:"added,omitempty"`
}

type Service struct {
	lock    sync.Mutex
	store   *Store
	now     func() time.Time
	publish func(version int64)
	logf    func(format string, args ...any)
	// sessionId is State.Session.
	sessionId string

	// resumeDir is Brokk's own folder, where a loaded brainstorm's resume brief goes; "" writes none.
	resumeDir string

	open    bool
	by      string
	version int64
	swap    int64
	listRev int64
	// The brainstorm of the mode; nil until his first central idea, or the one the developer resumed.
	session *Saved
	// What was said before the first central idea: written with the folder that idea makes.
	pending []Turn
	keys    map[string]bool
	savedAt int64
	saveErr string

	// appLanguage is the interface's language, a brainstorm's when the developer's messages do not say theirs (#2250).
	appLanguage func() string
	// The project's create (#2250): git through run, the parent folder last chosen, and one create at a time.
	run         GitRunner
	projectsDir func() string
	projectLock sync.Mutex
}

func MakeService(store *Store, now func() time.Time, publish func(int64), logf func(string, ...any)) *Service {
	return &Service{
		store:       store,
		now:         now,
		publish:     publish,
		logf:        logf,
		sessionId:   newId(),
		keys:        map[string]bool{},
		appLanguage: func() string { return "" },
		run:         execGit,
		projectsDir: func() string { return "" },
	}
}

// UseLanguage names the interface's language, read at each new brainstorm.
func (s *Service) UseLanguage(appLanguage func() string) {
	s.lock.Lock()
	defer s.lock.Unlock()
	s.appLanguage = appLanguage
}

// UseResumeDir names Brokk's own folder, where a loaded brainstorm's resume brief goes.
func (s *Service) UseResumeDir(dir string) {
	s.lock.Lock()
	defer s.lock.Unlock()
	s.resumeDir = dir
}

func (s *Service) stateLocked() State {
	state := State{Allowed: true, Open: s.open, By: s.by, Session: s.sessionId, Version: s.version, Swap: s.swap, ListRev: s.listRev, CanTrash: s.store.CanTrash(), SavedAt: s.savedAt, SaveError: s.saveErr}
	if s.session != nil {
		graph := s.session.Graph
		state.Graph = &graph
		summary := summaryOf(s.session.Dir, s.session.Info, len(s.session.Turns))
		state.Brainstorm = &summary
		state.History = Notes(s.session.History, s.session.Graph)
		state.Brief = s.session.Brief
	}
	state.Geargrim = GeargrimOffered()
	return state
}

func (s *Service) State() State {
	s.lock.Lock()
	defer s.lock.Unlock()
	return s.stateLocked()
}

// changedLocked moves the version on; the caller publishes it once the lock is released.
func (s *Service) changedLocked() int64 {
	s.version++
	return s.version
}

func (s *Service) tell(version int64) {
	if s.publish != nil {
		s.publish(version)
	}
}

// openLocked opens the mode on no brainstorm: his answer's central idea makes a new one (he detected a brainstorm), and
// the developer's start offers the saved ones first (the picker of AC10a, #2248): nothing is resumed without their
// choice.
func (s *Service) openLocked(by string) {
	s.open = true
	s.by = by
	s.keys = map[string]bool{}
	s.pending = nil
	if s.session != nil {
		s.session = nil
		s.swap++
	}
}

// Open starts the mode on no brainstorm: the developer then picks one, or a new idea (#2248); an opening by his answer
// starts a new one at his central idea. Opening an open mode changes nothing.
func (s *Service) Open(req OpenRequest) State {
	s.lock.Lock()
	if s.open {
		defer s.lock.Unlock()
		return s.stateLocked()
	}
	by := ByYou
	if req.By == ByBrokk {
		by = ByBrokk
	}
	s.openLocked(by)
	version := s.changedLocked()
	state := s.stateLocked()
	s.lock.Unlock()
	s.tell(version)
	return state
}

// Close ends the mode. The brainstorm stays saved, and the developer's next start offers it first.
func (s *Service) Close() State {
	s.lock.Lock()
	if !s.open {
		defer s.lock.Unlock()
		return s.stateLocked()
	}
	s.open = false
	s.pending = nil
	version := s.changedLocked()
	state := s.stateLocked()
	s.lock.Unlock()
	s.tell(version)
	return state
}

func cleanTurnText(text string) string {
	var b strings.Builder
	for _, r := range text {
		if (r < 0x20 && r != '\n' && r != '\t') || r == 0x7f {
			continue
		}
		b.WriteRune(r)
	}
	clean := strings.TrimSpace(b.String())
	if runes := []rune(clean); len(runes) > maxTurnText {
		clean = string(runes[:maxTurnText])
	}
	return clean
}

func lastTurn(turns []Turn) int {
	if len(turns) == 0 {
		return 0
	}
	return turns[len(turns)-1].Turn
}

func opensMode(b *Block) bool {
	return b != nil && b.Talk == TalkProject && CentreOf(*b) != ""
}

// Turn records one exchange and grows the graph with his block. Outside the mode only an answer that puts a central idea
// counts: it opens the mode (he detected a brainstorm); anything else is a normal exchange and is not kept.
func (s *Service) Turn(req TurnRequest) TurnResult {
	s.lock.Lock()
	if req.Swap != nil && *req.Swap != s.swap {
		defer s.lock.Unlock()
		return TurnResult{State: s.stateLocked(), Stale: true}
	}
	late := !s.open && req.Late && req.Swap != nil && s.session != nil
	if !s.open && !late {
		if !opensMode(req.Block) || ValidateBlock(*req.Block) != nil {
			defer s.lock.Unlock()
			return TurnResult{State: s.stateLocked()}
		}
		s.openLocked(ByBrokk)
	}
	if req.Key != "" && s.keys[req.Key] {
		defer s.lock.Unlock()
		return TurnResult{State: s.stateLocked(), Duplicate: true}
	}
	if req.Key != "" {
		s.keys[req.Key] = true
	}
	at := req.At
	if at <= 0 {
		at = s.now().UnixMilli()
	}
	rtn := TurnResult{}
	recorded := false
	if req.Block != nil {
		var brief *BriefDraft
		var briefNode string
		rtn, brief, briefNode = s.applyLocked(*req.Block, at)
		if s.session != nil && rtn.Applied {
			// The developer's words of this turn count for the brainstorm's language, which its brief is written in.
			s.appendTurnLocked(req, at)
			recorded = true
			concluded := brief != nil && s.concludeLocked(*brief, briefNode, at)
			s.session.Info.State = stateAfter(s.session.Info.State, *req.Block, len(rtn.Added), concluded, s.session.Brief != nil)
		}
	}
	if recorded {
		s.saveLocked(at)
	} else {
		s.recordLocked(req, at)
	}
	version := s.changedLocked()
	rtn.State = s.stateLocked()
	s.lock.Unlock()
	s.tell(version)
	return rtn
}

// stateAfter (#2285, #2250): a promoted brainstorm stays one; a finish marks it finished; a conclusion makes it clear;
// an answer that grows a finished one puts it back in progress, clear when its brief stands, since the developer went on
// with it.
func stateAfter(state string, block Block, added int, concluded bool, hasBrief bool) string {
	switch {
	case state == StatePromoted:
		return state
	case Finishes(block):
		return StateDone
	case concluded:
		return StateClear
	case state == StateDone && added > 0 && hasBrief:
		return StateClear
	case state == StateDone && added > 0:
		return StateOpen
	}
	return state
}

// concludeLocked writes the brief of his conclusion in the open brainstorm's folder (AC14): brief.json, then brief.md,
// each whole, and keeps which plate carries it. false when it could not be written: the brainstorm is not clear, and the
// reason alone is logged.
func (s *Service) concludeLocked(draft BriefDraft, node string, at int64) bool {
	s.ensureLanguageLocked()
	brief, err := MakeBrief(draft, s.session.Info.Id, s.session.Info.Language, at)
	if err != nil {
		s.logf("[brainstorm] a project brief was dropped: %v\n", err)
		return false
	}
	if err := WriteBrief(s.session.Dir, brief); err != nil {
		s.logf("[brainstorm] the project brief could not be written: %s\n", reasonOf(err))
		s.saveErr = reasonOf(err)
		return false
	}
	s.session.Brief = &brief
	s.session.Info.Conclusion = node
	return true
}

// settleBriefLocked lets the brief go with its conclusion (#2250): once the plate that carries it is removed, merged
// away, made another kind or undone, brief.json and brief.md go, and a clear brainstorm is in progress again (a finished
// one stays finished). A promoted brainstorm keeps its brief: the project was made from it.
func (s *Service) settleBriefLocked() {
	if s.session == nil || s.session.Brief == nil || s.session.Info.Conclusion == "" || s.session.Info.State == StatePromoted {
		return
	}
	if n, ok := s.session.Graph.node(s.session.Info.Conclusion); ok && n.Kind == KindConclusion {
		return
	}
	if err := RemoveBrief(s.session.Dir); err != nil {
		s.logf("[brainstorm] the brief of a conclusion taken back could not be removed: %s\n", reasonOf(err))
		return
	}
	s.session.Brief = nil
	s.session.Info.Conclusion = ""
	if s.session.Info.State == StateClear {
		s.session.Info.State = StateOpen
	}
}

// ensureLanguageLocked gives the open brainstorm its language once: what the developer wrote, else the interface's.
func (s *Service) ensureLanguageLocked() {
	if s.session == nil || s.session.Info.Language != "" {
		return
	}
	s.session.Info.Language = languageOf(s.session.Turns, s.appLanguage())
}

// applyLocked grows the brainstorm with his block; it returns the brief of a `conclude` in it, and its plate.
func (s *Service) applyLocked(block Block, at int64) (TurnResult, *BriefDraft, string) {
	if s.session != nil && StartsNewIdea(s.session.Graph, block) {
		// Another idea: the one before stays saved as it is, and this one gets its folder.
		s.session = nil
		s.pending = nil
	}
	base := EmptyGraph()
	turns := s.pending
	if s.session != nil {
		base = s.session.Graph
		turns = s.session.Turns
	}
	applied, err := Apply(base, block, lastTurn(turns)+1, at)
	if err != nil {
		// Never the content: the model's text stays out of the log (FR-BOSS-010 security rationale).
		s.logf("[brainstorm] a graph block was dropped: %v\n", err)
		return TurnResult{Dropped: true}, nil, ""
	}
	if s.session == nil && applied.Graph.Centre == "" {
		// Nothing to file yet (a finish or a question before any central idea): no folder is made for it.
		return TurnResult{}, nil, ""
	}
	if s.session == nil {
		centre, _ := applied.Graph.node(applied.Graph.Centre)
		saved, err := s.store.Create(centre.Text, at)
		if err != nil {
			s.logf("[brainstorm] the folder of a new idea could not be made: %s\n", reasonOf(err))
			s.saveErr = reasonOf(err)
			return TurnResult{Dropped: true}, nil, ""
		}
		saved.Turns = append(saved.Turns, s.pending...)
		s.pending = nil
		s.session = &saved
		s.listRev++
	}
	s.session.Graph = applied.Graph
	s.session.History = appendHistory(s.session.History, entriesOf(s.session.History, applied.Changes, ByBrokk, at)...)
	if centre, ok := applied.Graph.node(applied.Graph.Centre); ok && !s.session.Info.Named {
		s.session.Info.Title = centre.Text
	}
	return TurnResult{Applied: true, Added: applied.Added}, applied.Brief, applied.BriefNode
}

func (s *Service) recordLocked(req TurnRequest, at int64) {
	s.appendTurnLocked(req, at)
	s.saveLocked(at)
}

// appendTurnLocked keeps the exchange in the brainstorm's conversation, or before its first central idea.
func (s *Service) appendTurnLocked(req TurnRequest, at int64) {
	you := cleanTurnText(req.You)
	brokk := cleanTurnText(req.Brokk)
	if you == "" && brokk == "" {
		return
	}
	target := &s.pending
	if s.session != nil {
		target = &s.session.Turns
	}
	turn := lastTurn(*target) + 1
	if you != "" {
		*target = append(*target, Turn{Turn: turn, At: at, Role: RoleYou, Text: you})
	}
	if brokk != "" {
		*target = append(*target, Turn{Turn: turn, At: at, Role: RoleBrokk, Text: brokk})
	}
}

// saveLocked writes the folder at each turn's end (AC9): a crash loses at most the turn in progress.
func (s *Service) saveLocked(at int64) {
	if s.session == nil {
		return
	}
	s.ensureLanguageLocked()
	s.settleBriefLocked()
	s.session.Info.Updated = at
	if err := s.store.Save(*s.session); err != nil {
		s.logf("[brainstorm] the brainstorm could not be saved: %s\n", reasonOf(err))
		s.saveErr = reasonOf(err)
		return
	}
	if err := s.store.Remember(s.session.Dir); err != nil {
		s.logf("[brainstorm] the open brainstorm could not be remembered: %s\n", reasonOf(err))
	}
	s.saveErr = ""
	s.savedAt = s.now().UnixMilli()
}
