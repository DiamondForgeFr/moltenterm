// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brainstorm

import (
	"errors"
	"os"
	"slices"
)

// What the Brainstorms widget, the picker and the developer's answers to Brokk's questions do (FR-BOSS-010 AC10, AC10a
// to AC10d, AC11, #2248). Each one is the developer's click in a window: Brokk's fork, resume and forget operations
// only ask them, and wavesrv acts on what they answer. A move to another brainstorm saves the current one first.

// The reasons a window words; never a model's text or a path.
const (
	ReasonUnknown  = "unknown"
	ReasonNotSaved = "notsaved"
	ReasonNoIdea   = "noidea"
	ReasonInvalid  = "invalid"
	ReasonTrash    = "trash"
	// The system has no trash and the confirmation did not say the folder goes for good.
	ReasonNoTrash = "notrash"
	ReasonFailed  = "failed"
)

func (s *Service) List() ListResult {
	list, err := s.store.List()
	if err != nil {
		s.logf("[brainstorm] the brainstorms could not be listed: %v\n", err)
		return ListResult{Brainstorms: []Summary{}}
	}
	return ListResult{Brainstorms: list}
}

func (s *Service) Find(req FindRequest) FindResult {
	match, ok, err := s.store.Find(req.Title)
	if err != nil {
		s.logf("[brainstorm] the brainstorms could not be listed: %v\n", err)
	}
	if !ok {
		return FindResult{}
	}
	return FindResult{Match: &match}
}

// saveCurrentLocked writes the open brainstorm as it stands, before the developer moves to another.
func (s *Service) saveCurrentLocked() error {
	if s.session == nil {
		return nil
	}
	if err := s.store.Save(*s.session); err != nil {
		s.logf("[brainstorm] the brainstorm could not be saved: %v\n", err)
		s.saveErr = err.Error()
		return err
	}
	return nil
}

// writeResumeLocked writes the open brainstorm's resume brief; false when none was written, and the window then does
// not tell his session to read one.
func (s *Service) writeResumeLocked() bool {
	if s.resumeDir == "" || s.session == nil {
		return false
	}
	if err := WriteResume(s.resumeDir, *s.session); err != nil {
		s.logf("[brainstorm] the resume brief could not be written: %v\n", err)
		// The brief of the brainstorm left must not stand for this one.
		s.removeResumeLocked()
		return false
	}
	return true
}

func (s *Service) removeResumeLocked() {
	if err := RemoveResume(s.resumeDir); err != nil {
		s.logf("[brainstorm] the resume brief could not be removed: %v\n", err)
	}
}

// switchLocked makes saved the open brainstorm: the mode opens if it was not (the developer's Resume outside it), and
// the stage starts its camera over: an answer to the one before is refused from now on (Turn's Swap). It returns
// whether his folder got the resume brief; a new idea (nil) leaves none in it.
func (s *Service) switchLocked(saved *Saved) bool {
	if !s.open {
		s.open = true
		s.by = ByYou
	}
	s.keys = map[string]bool{}
	s.pending = nil
	s.session = saved
	s.swap++
	s.saveErr = ""
	if saved == nil {
		s.removeResumeLocked()
		return false
	}
	if err := s.store.Remember(saved.Dir); err != nil {
		s.logf("[brainstorm] the open brainstorm could not be remembered: %v\n", err)
	}
	return s.writeResumeLocked()
}

func (s *Service) loadFailed(reason string) LoadResult {
	defer s.lock.Unlock()
	return LoadResult{State: s.stateLocked(), Turns: []Turn{}, Error: reason}
}

// Load opens the brainstorm of that slug (AC10, AC10c): the current one is saved first, then the graph and the
// conversation swap, and his folder gets its resume brief.
func (s *Service) Load(req SlugRequest) LoadResult {
	s.lock.Lock()
	if s.open && s.session != nil && s.session.Info.Slug == req.Slug {
		defer s.lock.Unlock()
		return LoadResult{State: s.stateLocked(), Turns: append([]Turn{}, s.session.Turns...), ResumeBrief: s.writeResumeLocked()}
	}
	// The way back to the brainstorm just left (AC10e, #2284): it is still the one held, so it opens again as it was,
	// with no swap: an answer of his begun in it and still coming in stays its own.
	if !s.open && s.session != nil && s.session.Info.Slug == req.Slug {
		s.open = true
		s.by = ByYou
		version := s.changedLocked()
		rtn := LoadResult{State: s.stateLocked(), Turns: append([]Turn{}, s.session.Turns...), ResumeBrief: s.writeResumeLocked()}
		s.lock.Unlock()
		s.tell(version)
		return rtn
	}
	saved, err := s.store.LoadSlug(req.Slug)
	if errors.Is(err, ErrUnknownBrainstorm) {
		return s.loadFailed(ReasonUnknown)
	}
	if err != nil {
		s.logf("[brainstorm] a brainstorm does not load: %v\n", err)
		return s.loadFailed(ReasonFailed)
	}
	if s.saveCurrentLocked() != nil {
		return s.loadFailed(ReasonNotSaved)
	}
	resume := s.switchLocked(&saved)
	s.savedAt = 0
	version := s.changedLocked()
	rtn := LoadResult{State: s.stateLocked(), Turns: append([]Turn{}, saved.Turns...), ResumeBrief: resume}
	s.lock.Unlock()
	s.tell(version)
	return rtn
}

// New leaves the current brainstorm saved and starts a new idea; its folder is made at his first central idea.
func (s *Service) New() ActionResult {
	s.lock.Lock()
	if s.saveCurrentLocked() != nil {
		defer s.lock.Unlock()
		return ActionResult{State: s.stateLocked(), Error: ReasonNotSaved}
	}
	s.switchLocked(nil)
	version := s.changedLocked()
	rtn := ActionResult{State: s.stateLocked()}
	s.lock.Unlock()
	s.tell(version)
	return rtn
}

func (s *Service) actionFailed(reason string) ActionResult {
	defer s.lock.Unlock()
	return ActionResult{State: s.stateLocked(), Error: reason}
}

// Rename gives the brainstorm the developer's title; its folder follows (DS-BOSS-010).
func (s *Service) Rename(req RenameRequest) ActionResult {
	s.lock.Lock()
	current := s.session != nil && s.session.Info.Slug == req.Slug
	if current && s.saveCurrentLocked() != nil {
		return s.actionFailed(ReasonNotSaved)
	}
	if _, err := checkText(req.Title, "title"); err != nil {
		return s.actionFailed(ReasonInvalid)
	}
	renamed, err := s.store.Rename(req.Slug, req.Title, s.now().UnixMilli())
	if errors.Is(err, ErrUnknownBrainstorm) {
		return s.actionFailed(ReasonUnknown)
	}
	if err != nil {
		s.logf("[brainstorm] a brainstorm could not be renamed: %v\n", err)
		// The folder is where the store left it (moved back, or moved when that failed too): the open brainstorm
		// follows it, so the next turn is written there and not into a folder that is gone.
		if current && renamed.Dir != "" && renamed.Dir != s.session.Dir {
			s.session.Dir = renamed.Dir
			s.session.Info.Slug = renamed.Info.Slug
			s.listRev++
		}
		return s.actionFailed(ReasonFailed)
	}
	if current {
		s.session.Dir = renamed.Dir
		s.session.Info = renamed.Info
	}
	s.listRev++
	version := s.changedLocked()
	summary := summaryOf(renamed.Dir, renamed.Info, len(renamed.Turns))
	rtn := ActionResult{State: s.stateLocked(), Summary: &summary}
	s.lock.Unlock()
	s.tell(version)
	return rtn
}

// Delete forgets a brainstorm, on the developer's confirmation alone (AC10d): its folder goes to the trash, his resume
// brief of it goes, and its title leaves his brief's list with the folder. The window sends it only from the confirm
// button of a question that showed its title and last change.
func (s *Service) Delete(req DeleteRequest) ActionResult {
	s.lock.Lock()
	deleted, err := s.store.Delete(req.Slug, req.Id, req.Permanent)
	if errors.Is(err, ErrUnknownBrainstorm) {
		return s.actionFailed(ReasonUnknown)
	}
	if errors.Is(err, ErrNeedsRemoveConfirmation) {
		return s.actionFailed(ReasonNoTrash)
	}
	if err != nil {
		s.logf("[brainstorm] a brainstorm could not be forgotten: %v\n", err)
		return s.actionFailed(ReasonTrash)
	}
	if s.session != nil && s.session.Info.Slug == deleted.Summary.Slug {
		s.session = nil
		s.pending = nil
		s.swap++
	}
	if err := ClearResume(s.resumeDir, deleted.Summary.Id); err != nil {
		s.logf("[brainstorm] the resume brief of a forgotten brainstorm could not be removed: %v\n", err)
	}
	s.listRev++
	version := s.changedLocked()
	summary := deleted.Summary
	rtn := ActionResult{State: s.stateLocked(), Summary: &summary, Trashed: deleted.Trashed}
	s.lock.Unlock()
	s.tell(version)
	return rtn
}

func withSibling(siblings []string, id string) []string {
	if id == "" || slices.Contains(siblings, id) {
		return siblings
	}
	return append(append([]string{}, siblings...), id)
}

// Fork answers Yes to his fork (AC11): a new folder with that topic at its centre, the current one saved, and each
// graph keeping a reference node to the other. The mode moves to the new folder, and his folder gets its resume brief.
func (s *Service) Fork(req ForkRequest) LoadResult {
	s.lock.Lock()
	if !s.open || s.session == nil {
		return s.loadFailed(ReasonNoIdea)
	}
	at := s.now().UnixMilli()
	graph, err := CentredGraph(req.Title, at)
	if err != nil {
		return s.loadFailed(ReasonInvalid)
	}
	created, err := s.store.Create(graph.Nodes[0].Text, at)
	if err != nil {
		s.logf("[brainstorm] the folder of a fork could not be made: %v\n", err)
		return s.loadFailed(ReasonFailed)
	}
	old := s.session
	created.Graph = WithReference(graph, old.Info.Title, old.Info.Id, at)
	created.Info.Siblings = withSibling(created.Info.Siblings, old.Info.Id)
	old.Graph = WithReference(old.Graph, created.Info.Title, created.Info.Id, at)
	old.Info.Siblings = withSibling(old.Info.Siblings, created.Info.Id)
	old.Info.Updated = at
	if s.saveCurrentLocked() != nil {
		// The new folder holds nothing yet: it goes, rather than stay as an empty idea.
		_ = os.Remove(created.Dir)
		return s.loadFailed(ReasonNotSaved)
	}
	if err := s.store.Save(created); err != nil {
		s.logf("[brainstorm] the folder of a fork could not be saved: %v\n", err)
		return s.loadFailed(ReasonFailed)
	}
	resume := s.switchLocked(&created)
	s.listRev++
	s.savedAt = s.now().UnixMilli()
	version := s.changedLocked()
	rtn := LoadResult{State: s.stateLocked(), Turns: []Turn{}, ResumeBrief: resume}
	s.lock.Unlock()
	s.tell(version)
	return rtn
}
