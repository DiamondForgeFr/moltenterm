// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The review store (DS-REV-007): one JSON file per PR under <data>/molten/reviews/<repo-key>/<N>.json, written under a
// per-PR lock, never in the project. This story keeps the viewed files and the heads the Review tab showed; the rounds
// are FR-REV-010's (publish), read here for the "since last round" view, the comments are comments.go's (FR-REV-003), and
// the briefing and explanations come with their stories.

var repoPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)

// Round is one review round (DS-REV-007); PublishedAt is set once its GitHub review is posted.
type Round struct {
	Id             string `json:"id"`
	StartedAt      int64  `json:"startedat"`
	HeadOid        string `json:"headoid"`
	PublishedAt    int64  `json:"publishedat,omitempty"`
	GithubReviewId int64  `json:"githubreviewid,omitempty"`
	GithubUrl      string `json:"githuburl,omitempty"`
	RestartedAt    int64  `json:"restartedat,omitempty"`
}

// Since is the "since last round" diff the tab offers after the head moved (AC5).
type Since struct {
	From string `json:"from"`
	To   string `json:"to"`
	// Published: From is the head of the last published round; otherwise the head shown before the refresh.
	Published bool `json:"published,omitempty"`
}

// Briefing is the review session's latest briefing of the PR (FR-REV-005), kept so a reopened PR shows it again.
type Briefing struct {
	Markdown string `json:"markdown"`
	// HeadOid: the head the agent briefed; the Review tab says when the PR moved since.
	HeadOid string `json:"headoid,omitempty"`
	Agent   string `json:"agent,omitempty"`
	At      int64  `json:"at"`
}

type State struct {
	Repo   string `json:"repo"`
	Number int    `json:"number"`
	// Briefing: nil until a session posted one.
	Briefing *Briefing `json:"briefing,omitempty"`
	// Viewed: path → the head's blob id when it was marked viewed. A push that changes the file unviews it, as on
	// GitHub.
	Viewed map[string]string `json:"viewed"`
	// LastHead: the head the Review tab showed last.
	LastHead string  `json:"lasthead,omitempty"`
	Since    *Since  `json:"since,omitempty"`
	Rounds   []Round `json:"rounds"`
	// Comments: the developer's review comments (FR-REV-003, comments.go).
	Comments  []Comment `json:"comments"`
	UpdatedAt int64     `json:"updatedat,omitempty"`
	// Merge: the last Validate's merge and its outcome (FR-REV-012, merge.go).
	Merge *MergeRecord `json:"merge,omitempty"`
	// Cleanup: what the last cleanup after the merge did (FR-REV-013).
	Cleanup *CleanupResult `json:"cleanup,omitempty"`
}

type PrKey struct {
	Repo   string `json:"repo"`
	Number int    `json:"number"`
}

func (k PrKey) check() error {
	if !repoPattern.MatchString(k.Repo) || strings.HasPrefix(k.Repo, ".") || strings.Contains(k.Repo, "/.") {
		return fmt.Errorf("repo must be owner/name")
	}
	if k.Number <= 0 {
		return fmt.Errorf("number must be the PR's number")
	}
	return nil
}

type ViewedRequest struct {
	PrKey
	Path string `json:"path"`
	// Blob: the head's blob id of the file ("" for a deleted file).
	Blob   string `json:"blob,omitempty"`
	Viewed bool   `json:"viewed"`
}

// ShownRequest records the head the tab shows now.
type ShownRequest struct {
	PrKey
	HeadOid string `json:"headoid"`
}

type Store struct {
	dir string
	now func() time.Time

	lock  sync.Mutex
	locks map[string]*sync.Mutex
}

func MakeStore(dataDir string) *Store {
	return &Store{dir: filepath.Join(dataDir, "molten", "reviews"), now: time.Now, locks: map[string]*sync.Mutex{}}
}

// RepoKey is the store's folder of a repository: owner__name, lower case.
func RepoKey(repo string) string {
	return strings.ToLower(strings.ReplaceAll(repo, "/", "__"))
}

func (s *Store) fileOf(k PrKey) string {
	return filepath.Join(s.dir, RepoKey(k.Repo), strconv.Itoa(k.Number)+".json")
}

func (s *Store) prLock(k PrKey) *sync.Mutex {
	s.lock.Lock()
	defer s.lock.Unlock()
	key := s.fileOf(k)
	if s.locks[key] == nil {
		s.locks[key] = &sync.Mutex{}
	}
	return s.locks[key]
}

func (s *Store) read(k PrKey) (State, error) {
	rtn := State{Repo: k.Repo, Number: k.Number, Viewed: map[string]string{}, Rounds: []Round{}, Comments: []Comment{}}
	data, err := os.ReadFile(s.fileOf(k))
	if errors.Is(err, os.ErrNotExist) {
		return rtn, nil
	}
	if err != nil {
		return rtn, err
	}
	if err := json.Unmarshal(data, &rtn); err != nil {
		return State{Repo: k.Repo, Number: k.Number, Viewed: map[string]string{}, Rounds: []Round{}, Comments: []Comment{}}, nil
	}
	if rtn.Viewed == nil {
		rtn.Viewed = map[string]string{}
	}
	if rtn.Rounds == nil {
		rtn.Rounds = []Round{}
	}
	if rtn.Comments == nil {
		rtn.Comments = []Comment{}
	}
	return rtn, nil
}

func (s *Store) write(k PrKey, state State) error {
	file := s.fileOf(k)
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, file)
}

func (s *Store) Get(k PrKey) (State, error) {
	if err := k.check(); err != nil {
		return State{}, err
	}
	lock := s.prLock(k)
	lock.Lock()
	defer lock.Unlock()
	return s.read(k)
}

// update changes a PR's state under its lock; change returns false when nothing changed.
func (s *Store) update(k PrKey, change func(state *State) bool) (State, bool, error) {
	if err := k.check(); err != nil {
		return State{}, false, err
	}
	lock := s.prLock(k)
	lock.Lock()
	defer lock.Unlock()
	state, err := s.read(k)
	if err != nil {
		return state, false, err
	}
	if !change(&state) {
		return state, false, nil
	}
	state.UpdatedAt = s.now().UnixMilli()
	return state, true, s.write(k, state)
}

// SetMerge records the merge's progress or outcome (FR-REV-012-AC5).
func (s *Store) SetMerge(k PrKey, record MergeRecord) (State, bool, error) {
	return s.update(k, func(state *State) bool {
		state.Merge = &record
		return true
	})
}

// SetCleanup records a cleanup's outcome. A run of some steps only (a retry, a confirmed worktree) replaces those steps
// and keeps the others the developer already saw.
func (s *Store) SetCleanup(result CleanupResult) (State, bool, error) {
	return s.update(PrKey{Repo: result.Repo, Number: result.Number}, func(state *State) bool {
		if state.Cleanup == nil {
			state.Cleanup = &result
			return true
		}
		merged := result
		merged.Steps = []CleanupStepResult{}
		for _, id := range CleanupSteps {
			if step := result.Step(id); step != nil {
				merged.Steps = append(merged.Steps, *step)
			} else if old := state.Cleanup.Step(id); old != nil {
				merged.Steps = append(merged.Steps, *old)
			}
		}
		state.Cleanup = &merged
		return true
	})
}

// Unpublished counts the PR's comments not published yet (drafted, staged, translated, outdated), the agent's
// proposals aside. It reads the
// stored file's comments by their state only, so it does not depend on the rest of the comment's shape (FR-REV-003).
func (s *Store) Unpublished(k PrKey) (int, error) {
	if err := k.check(); err != nil {
		return 0, err
	}
	lock := s.prLock(k)
	lock.Lock()
	defer lock.Unlock()
	data, err := os.ReadFile(s.fileOf(k))
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	var stored struct {
		Comments []struct {
			State string `json:"state"`
		} `json:"comments"`
	}
	if err := json.Unmarshal(data, &stored); err != nil {
		return 0, nil
	}
	count := 0
	for _, c := range stored.Comments {
		switch c.State {
		// A proposal is the agent's until the developer accepts it (FR-REV-009 AC3).
		case "published", "dropped", "proposed":
			continue
		}
		count++
	}
	return count, nil
}

// SetViewed marks or unmarks a file viewed (AC1).
func (s *Store) SetViewed(req ViewedRequest) (State, bool, error) {
	if req.Path == "" {
		return State{}, false, fmt.Errorf("path is required")
	}
	if err := checkOid(req.Blob, "blob"); err != nil {
		return State{}, false, err
	}
	return s.update(req.PrKey, func(state *State) bool {
		old, had := state.Viewed[req.Path]
		if !req.Viewed {
			delete(state.Viewed, req.Path)
			return had
		}
		state.Viewed[req.Path] = req.Blob
		return !had || old != req.Blob
	})
}

// SetBriefing keeps the session's new briefing in place of the previous one (AC4).
func (s *Store) SetBriefing(k PrKey, b Briefing) (State, bool, error) {
	if strings.TrimSpace(b.Markdown) == "" {
		return State{}, false, fmt.Errorf("the briefing is empty")
	}
	if err := checkOid(b.HeadOid, "headoid"); err != nil {
		return State{}, false, err
	}
	return s.update(k, func(state *State) bool {
		if state.Briefing != nil && *state.Briefing == b {
			return false
		}
		state.Briefing = &b
		return true
	})
}

func lastPublished(rounds []Round) *Round {
	for i := len(rounds) - 1; i >= 0; i-- {
		if rounds[i].PublishedAt > 0 && rounds[i].HeadOid != "" {
			return &rounds[i]
		}
	}
	return nil
}

// Shown records the head the tab shows (AC5). When it differs from the one shown before, the "since last round" diff
// goes from the last published round's head, else from the head shown before, to this one.
func (s *Store) Shown(req ShownRequest) (State, bool, error) {
	if !isOid(req.HeadOid) {
		return State{}, false, fmt.Errorf("headoid must be a commit id")
	}
	return s.update(req.PrKey, func(state *State) bool {
		if state.LastHead == req.HeadOid {
			return false
		}
		previous := state.LastHead
		state.LastHead = req.HeadOid
		if round := lastPublished(state.Rounds); round != nil && round.HeadOid != req.HeadOid {
			state.Since = &Since{From: round.HeadOid, To: req.HeadOid, Published: true}
		} else if previous != "" {
			state.Since = &Since{From: previous, To: req.HeadOid}
		}
		return true
	})
}
