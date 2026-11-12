// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brainstorm

import "errors"

// The developer's own changes to the graph (FR-BOSS-010 AC27, AC28, #2247): what a plate's menu does (edit, retype,
// remove, link, unlink), the Undo of the layer's bar and of Ctrl/⌘ + Z, and the mark that Brokk was told of them. Each is
// the developer's click in a window on the brainstorm it shows, applied with a block's rules and kept in the history.

// ReasonConflict: a later change touched what an undo would put back.
const ReasonConflict = "conflict"

// EditRequest is the developer's changes. Swap: the state's swap the window showed; a change made on a brainstorm the
// developer has since moved away from is refused.
type EditRequest struct {
	Ops  []Op   `json:"ops"`
	Swap *int64 `json:"swap,omitempty"`
}

type UndoRequest struct {
	Seq  int64  `json:"seq"`
	Swap *int64 `json:"swap,omitempty"`
}

// ToldRequest: the developer's changes up to Seq went to Brokk with a message.
type ToldRequest struct {
	Seq int64 `json:"seq"`
}

// EditResult is the state after the change, the history lines it made (Seqs), and why nothing changed (Error).
type EditResult struct {
	State State   `json:"state"`
	Seqs  []int64 `json:"seqs,omitempty"`
	Stale bool    `json:"stale,omitempty"`
	Error string  `json:"error,omitempty"`
}

func (s *Service) editFailed(reason string) EditResult {
	defer s.lock.Unlock()
	return EditResult{State: s.stateLocked(), Error: reason}
}

// editableLocked: false, with the answer to give, when the developer cannot change the graph now (another brainstorm
// since, or none open).
func (s *Service) editableLocked(swap *int64) (EditResult, bool) {
	if swap != nil && *swap != s.swap {
		return EditResult{State: s.stateLocked(), Stale: true}, false
	}
	if !s.open || s.session == nil {
		return EditResult{State: s.stateLocked(), Error: ReasonNoIdea}, false
	}
	return EditResult{}, true
}

// commitLocked saves the brainstorm after a change and tells every view; it releases the lock.
func (s *Service) commitLocked(at int64, seqs []int64) EditResult {
	s.saveLocked(at)
	version := s.changedLocked()
	rtn := EditResult{State: s.stateLocked(), Seqs: seqs}
	s.lock.Unlock()
	s.tell(version)
	return rtn
}

// Edit applies the developer's changes from a plate's menu, all or nothing.
func (s *Service) Edit(req EditRequest) EditResult {
	s.lock.Lock()
	if refused, ok := s.editableLocked(req.Swap); !ok {
		defer s.lock.Unlock()
		return refused
	}
	at := s.now().UnixMilli()
	applied, err := ApplyDeveloper(s.session.Graph, req.Ops, lastTurn(s.session.Turns), at)
	if err != nil {
		// Never the content: the reason alone.
		s.logf("[brainstorm] a change of the developer's was refused: %v\n", err)
		return s.editFailed(ReasonInvalid)
	}
	if len(applied.Changes) == 0 {
		defer s.lock.Unlock()
		return EditResult{State: s.stateLocked()}
	}
	entries := entriesOf(s.session.History, applied.Changes, ByYou, at)
	s.session.Graph = applied.Graph
	s.session.History = appendHistory(s.session.History, entries...)
	seqs := make([]int64, 0, len(entries))
	for _, e := range entries {
		seqs = append(seqs, e.Seq)
	}
	return s.commitLocked(at, seqs)
}

// Undo puts back one change of the history, the developer's or Brokk's, unless a later change touched the same nodes.
func (s *Service) Undo(req UndoRequest) EditResult {
	s.lock.Lock()
	if refused, ok := s.editableLocked(req.Swap); !ok {
		defer s.lock.Unlock()
		return refused
	}
	at := s.now().UnixMilli()
	graph, history, err := UndoEntry(s.session.Graph, s.session.History, req.Seq, ByYou, at)
	if errors.Is(err, ErrUnknownChange) {
		return s.editFailed(ReasonUnknown)
	}
	if err != nil {
		s.logf("[brainstorm] an undo was refused: %v\n", err)
		return s.editFailed(ReasonConflict)
	}
	s.session.Graph = graph
	s.session.History = history
	return s.commitLocked(at, []int64{history[len(history)-1].Seq})
}

// Told marks the developer's changes up to req.Seq as told: their note went to Brokk with a message.
func (s *Service) Told(req ToldRequest) State {
	s.lock.Lock()
	if s.session == nil {
		defer s.lock.Unlock()
		return s.stateLocked()
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
		defer s.lock.Unlock()
		return s.stateLocked()
	}
	return s.commitLocked(s.now().UnixMilli(), nil).State
}
