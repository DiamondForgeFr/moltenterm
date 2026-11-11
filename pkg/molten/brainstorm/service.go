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

// Summary is what the views show of the brainstorm: the Saved widget's title, folder and time.
type Summary struct {
	Slug    string `json:"slug"`
	Title   string `json:"title"`
	Dir     string `json:"dir"`
	Created int64  `json:"created"`
	Updated int64  `json:"updated"`
	Turns   int    `json:"turns"`
}

// State is what every view reads back after the event.
type State struct {
	Allowed    bool     `json:"allowed"`
	Open       bool     `json:"open"`
	By         string   `json:"by,omitempty"`
	Version    int64    `json:"version"`
	Brainstorm *Summary `json:"brainstorm,omitempty"`
	Graph      *Graph   `json:"graph,omitempty"`
	SavedAt    int64    `json:"savedat,omitempty"`
	SaveError  string   `json:"saveerror,omitempty"`
}

type OpenRequest struct {
	By string `json:"by"`
}

// TurnRequest is one exchange: the developer's message, his answer without its blocks, his graph block if it had one.
// Key names the answer, so that a view reading it twice applies it once.
type TurnRequest struct {
	Key   string `json:"key"`
	You   string `json:"you"`
	Brokk string `json:"brokk"`
	Block *Block `json:"block,omitempty"`
	At    int64  `json:"at"`
}

type TurnResult struct {
	State     State    `json:"state"`
	Applied   bool     `json:"applied"`
	Dropped   bool     `json:"dropped"`
	Duplicate bool     `json:"duplicate"`
	Added     []string `json:"added,omitempty"`
}

type Service struct {
	lock    sync.Mutex
	store   *Store
	now     func() time.Time
	publish func(version int64)
	logf    func(format string, args ...any)

	open    bool
	by      string
	version int64
	// The brainstorm of the mode; nil until his first central idea, or the one the developer resumed.
	session *Saved
	// What was said before the first central idea: written with the folder that idea makes.
	pending []Turn
	keys    map[string]bool
	savedAt int64
	saveErr string
}

func MakeService(store *Store, now func() time.Time, publish func(int64), logf func(string, ...any)) *Service {
	return &Service{store: store, now: now, publish: publish, logf: logf, keys: map[string]bool{}}
}

func (s *Service) stateLocked() State {
	state := State{Allowed: true, Open: s.open, By: s.by, Version: s.version, SavedAt: s.savedAt, SaveError: s.saveErr}
	if s.session != nil {
		graph := s.session.Graph
		state.Graph = &graph
		state.Brainstorm = &Summary{
			Slug:    s.session.Info.Slug,
			Title:   s.session.Info.Title,
			Dir:     s.session.Dir,
			Created: s.session.Info.Created,
			Updated: s.session.Info.Updated,
			Turns:   len(s.session.Turns),
		}
	}
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

func (s *Service) openLocked(by string) {
	s.open = true
	s.by = by
	s.keys = map[string]bool{}
	s.pending = nil
	if by == ByBrokk {
		// He detected a new brainstorm: it gets its own folder at his central idea, whatever was open before.
		s.session = nil
		return
	}
	if s.session == nil {
		if saved, ok := s.store.Current(); ok {
			s.session = &saved
		}
	}
}

// Open starts the mode. The developer's start resumes the brainstorm open last (a restart included); an opening by his
// answer starts a new one. Opening an open mode changes nothing.
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

// Close ends the mode. The brainstorm stays saved, and the developer's next start resumes it.
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
	if !s.open {
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
	if req.Block != nil {
		rtn = s.applyLocked(*req.Block, at)
	}
	s.recordLocked(req, at)
	version := s.changedLocked()
	rtn.State = s.stateLocked()
	s.lock.Unlock()
	s.tell(version)
	return rtn
}

func (s *Service) applyLocked(block Block, at int64) TurnResult {
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
		return TurnResult{Dropped: true}
	}
	if s.session == nil {
		centre, _ := applied.Graph.node(applied.Graph.Centre)
		saved, err := s.store.Create(centre.Text, at)
		if err != nil {
			s.logf("[brainstorm] the folder of a new idea could not be made: %v\n", err)
			s.saveErr = err.Error()
			return TurnResult{Dropped: true}
		}
		saved.Turns = append(saved.Turns, s.pending...)
		s.pending = nil
		s.session = &saved
	}
	s.session.Graph = applied.Graph
	if centre, ok := applied.Graph.node(applied.Graph.Centre); ok {
		s.session.Info.Title = centre.Text
	}
	return TurnResult{Applied: true, Added: applied.Added}
}

func (s *Service) recordLocked(req TurnRequest, at int64) {
	you := cleanTurnText(req.You)
	brokk := cleanTurnText(req.Brokk)
	if you == "" && brokk == "" {
		s.saveLocked(at)
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
	s.saveLocked(at)
}

// saveLocked writes the folder at each turn's end (AC9): a crash loses at most the turn in progress.
func (s *Service) saveLocked(at int64) {
	if s.session == nil {
		return
	}
	s.session.Info.Updated = at
	if err := s.store.Save(*s.session); err != nil {
		s.logf("[brainstorm] the brainstorm could not be saved: %v\n", err)
		s.saveErr = err.Error()
		return
	}
	if err := s.store.Remember(s.session.Dir); err != nil {
		s.logf("[brainstorm] the open brainstorm could not be remembered: %v\n", err)
	}
	s.saveErr = ""
	s.savedAt = s.now().UnixMilli()
}
