// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brainstorm

import "errors"

// The developer's own changes to the graph (FR-BOSS-010 AC27, AC28, #2247): what a plate's menu does (edit, retype,
// remove, link, unlink), the Undo of the layer's bar and of Ctrl/⌘ + Z, and the mark that Brokk was told of them. Each is
// the developer's click in a window on the brainstorm it shows, applied with a block's rules and kept in the history.
//
// Each request names the brainstorm it was made on: the state's swap the window showed, and the folder's id. The swap
// alone does not say it: a new idea of Brokk's (a `centre` of another id) starts another folder in the same swap, and
// each folder's history counts from 1. A request made on another brainstorm than the open one is refused as stale.

// ReasonConflict: a later change touched what an undo would put back.
const ReasonConflict = "conflict"

type EditRequest struct {
	Ops  []Op   `json:"ops"`
	Swap *int64 `json:"swap,omitempty"`
	Id   string `json:"id,omitempty"`
}

type UndoRequest struct {
	Seq  int64  `json:"seq"`
	Swap *int64 `json:"swap,omitempty"`
	Id   string `json:"id,omitempty"`
}

// ToldRequest: the developer's changes up to Seq, in the brainstorm Id of that swap, went to Brokk with a message.
type ToldRequest struct {
	Seq  int64  `json:"seq"`
	Swap *int64 `json:"swap,omitempty"`
	Id   string `json:"id,omitempty"`
}

// EditResult is the state after the change, the history lines it made (Seqs), and why nothing changed (Error).
type EditResult struct {
	State State   `json:"state"`
	Seqs  []int64 `json:"seqs,omitempty"`
	Stale bool    `json:"stale,omitempty"`
	Error string  `json:"error,omitempty"`
}

// sameBrainstormLocked: the request names the brainstorm open now. An empty id is a window that did not know it yet.
func (s *Service) sameBrainstormLocked(swap *int64, id string) bool {
	if swap != nil && *swap != s.swap {
		return false
	}
	return id == "" || (s.session != nil && s.session.Info.Id == id)
}

// editableLocked: false, with the answer to give, when the developer cannot change the graph now (another brainstorm
// since, or none open).
func (s *Service) editableLocked(swap *int64, id string) (EditResult, bool) {
	if !s.sameBrainstormLocked(swap, id) {
		return EditResult{State: s.stateLocked(), Stale: true}, false
	}
	if !s.open || s.session == nil {
		return EditResult{State: s.stateLocked(), Error: ReasonNoIdea}, false
	}
	return EditResult{}, true
}

// committedLocked saves the brainstorm after a change and moves the version on, for the caller to tell every view once
// the lock is released. The centre's text names the brainstorm until the developer gives it a title (Rename), as with
// Brokk's own `centre`.
func (s *Service) committedLocked(at int64) int64 {
	if centre, ok := s.session.Graph.node(s.session.Graph.Centre); ok && !s.session.Info.Named {
		s.session.Info.Title = centre.Text
	}
	s.saveLocked(at)
	return s.changedLocked()
}

// tellChanged tells every view of a change; 0 is none.
func (s *Service) tellChanged(version int64) {
	if version != 0 {
		s.tell(version)
	}
}

// Edit applies the developer's changes from a plate's menu, all or nothing.
func (s *Service) Edit(req EditRequest) EditResult {
	rtn, version := s.edit(req)
	s.tellChanged(version)
	return rtn
}

func (s *Service) edit(req EditRequest) (EditResult, int64) {
	s.lock.Lock()
	defer s.lock.Unlock()
	if refused, ok := s.editableLocked(req.Swap, req.Id); !ok {
		return refused, 0
	}
	at := s.now().UnixMilli()
	applied, err := ApplyDeveloper(s.session.Graph, req.Ops, lastTurn(s.session.Turns), at)
	if err != nil {
		// Never the content: the reason alone.
		s.logf("[brainstorm] a change of the developer's was refused: %v\n", err)
		return EditResult{State: s.stateLocked(), Error: ReasonInvalid}, 0
	}
	if len(applied.Changes) == 0 {
		return EditResult{State: s.stateLocked()}, 0
	}
	entries := entriesOf(s.session.History, applied.Changes, ByYou, at)
	s.session.Graph = applied.Graph
	s.session.History = appendHistory(s.session.History, entries...)
	seqs := make([]int64, 0, len(entries))
	for _, e := range entries {
		seqs = append(seqs, e.Seq)
	}
	version := s.committedLocked(at)
	return EditResult{State: s.stateLocked(), Seqs: seqs}, version
}

// Undo puts back one change of the history, the developer's or Brokk's, unless a later change touched the same nodes.
func (s *Service) Undo(req UndoRequest) EditResult {
	rtn, version := s.undo(req)
	s.tellChanged(version)
	return rtn
}

func (s *Service) undo(req UndoRequest) (EditResult, int64) {
	s.lock.Lock()
	defer s.lock.Unlock()
	if refused, ok := s.editableLocked(req.Swap, req.Id); !ok {
		return refused, 0
	}
	at := s.now().UnixMilli()
	graph, history, err := UndoEntry(s.session.Graph, s.session.History, req.Seq, ByYou, at)
	if errors.Is(err, ErrUnknownChange) {
		return EditResult{State: s.stateLocked(), Error: ReasonUnknown}, 0
	}
	if err != nil {
		s.logf("[brainstorm] an undo was refused: %v\n", err)
		return EditResult{State: s.stateLocked(), Error: ReasonConflict}, 0
	}
	s.session.Graph = graph
	s.session.History = history
	version := s.committedLocked(at)
	return EditResult{State: s.stateLocked(), Seqs: []int64{history[len(history)-1].Seq}}, version
}

// Told marks the developer's changes up to req.Seq as told: their note went to Brokk with a message. A note of another
// brainstorm than the open one marks nothing: its seqs are that folder's.
func (s *Service) Told(req ToldRequest) State {
	rtn, version := s.told(req)
	s.tellChanged(version)
	return rtn
}

func (s *Service) told(req ToldRequest) (State, int64) {
	s.lock.Lock()
	defer s.lock.Unlock()
	if s.session == nil || req.Id == "" || !s.sameBrainstormLocked(req.Swap, req.Id) {
		return s.stateLocked(), 0
	}
	changed := false
	for i := range s.session.History {
		e := &s.session.History[i]
		if e.By == ByYou && !e.Told && e.Seq <= req.Seq {
			e.Told = true
			changed = true
		}
	}
	if !changed {
		return s.stateLocked(), 0
	}
	version := s.committedLocked(s.now().UnixMilli())
	return s.stateLocked(), version
}
