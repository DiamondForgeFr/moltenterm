// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
	"github.com/wavetermdev/waveterm/pkg/molten/reviewsession"
)

// Kept explanations (FR-REV-008, DS-REV-007): the answers the developer keeps, one notes file per project under
// <data>/molten/reviews/<repo-key>/notes.json, never in the project (NFR-REV-006). A note is a copy of the answer, so it
// outlives the PR's review store, its worktree and the agent's session; only the developer's Delete removes one (AC3).
// Its path:line links are read from the project's git at a commit that outlives the PR (NoteFile), never from the PR's
// worktree, which the cleanup after the merge removes.

const (
	NotesEvent = "molten:review:notes"

	NotesCommand      = "moltenreviewnotes"
	NoteKeepCommand   = "moltenreviewnotekeep"
	NoteRenameCommand = "moltenreviewnoterename"
	NoteDeleteCommand = "moltenreviewnotedelete"
	NoteFileCommand   = "moltenreviewnotefile"

	notesFileName = "notes.json"
	// The snapshots of the files a note's links open, by commit.
	noteFilesDir = "notes-files"
	maxNoteTitle = 200
	// A snapshot is a file to read at a line, not an archive.
	maxNoteFileBytes = 5 << 20

	// Where a note's file was read from.
	NoteFromMerged = "merged"
	NoteFromHead   = "head"
	NoteFromBase   = "base"
)

// NotePr is the PR a note was kept from.
type NotePr struct {
	Number int    `json:"number"`
	Title  string `json:"title,omitempty"`
	Url    string `json:"url,omitempty"`
	// BaseRef: the branch the PR targets, where its links are read once the PR is gone.
	BaseRef string `json:"baseref,omitempty"`
}

// Note is a kept explanation (AC1). Title starts as the technique and is the developer's to rename.
type Note struct {
	Id            string            `json:"id"`
	Title         string            `json:"title"`
	ExplanationId string            `json:"explanationid"`
	Technique     string            `json:"technique,omitempty"`
	Question      string            `json:"question,omitempty"`
	Markdown      string            `json:"markdown"`
	Depth         string            `json:"depth,omitempty"`
	Principles    []string          `json:"principles,omitempty"`
	Sources       []string          `json:"sources,omitempty"`
	Related       []string          `json:"related,omitempty"`
	Anchor        *mcpreview.Anchor `json:"anchor,omitempty"`
	Pr            NotePr            `json:"pr"`
	// HeadOid: the head the answer was made on.
	HeadOid   string `json:"headoid,omitempty"`
	Agent     string `json:"agent,omitempty"`
	KeptAt    int64  `json:"keptat"`
	UpdatedAt int64  `json:"updatedat,omitempty"`
}

// Notes is a project's notes file, in the order they were kept (the views show the newest first).
type Notes struct {
	Repo      string `json:"repo"`
	Notes     []Note `json:"notes"`
	UpdatedAt int64  `json:"updatedat,omitempty"`
}

type NotesRequest struct {
	Repo string `json:"repo"`
}

type NoteKeepRequest struct {
	PrKey
	ExplanationId string `json:"explanationid"`
	Title         string `json:"title,omitempty"`
	PrTitle       string `json:"prtitle,omitempty"`
	PrUrl         string `json:"prurl,omitempty"`
	BaseRef       string `json:"baseref,omitempty"`
}

type NoteRenameRequest struct {
	Repo  string `json:"repo"`
	Id    string `json:"id"`
	Title string `json:"title"`
}

type NoteDeleteRequest struct {
	Repo string `json:"repo"`
	Id   string `json:"id"`
}

type NoteFileRequest struct {
	Repo string `json:"repo"`
	Id   string `json:"id"`
	// Dir: the project's folder, whose git holds the commits.
	Dir  string `json:"dir"`
	Path string `json:"path"`
}

type NoteFileResult struct {
	// File: the read-only snapshot to open.
	File   string `json:"file"`
	Commit string `json:"commit"`
	From   string `json:"from"`
}

// NotesScope is the event scope of a project's notes. Must match notesScope in
// frontend/moltenterm-shell/review/review-notes.ts.
func NotesScope(repo string) string {
	return "reviewnotes:" + RepoKey(repo)
}

func (s *Service) notesChanged(notes Notes, changed bool, err error) (Notes, error) {
	if err == nil && changed && s.publishNotes != nil {
		s.publishNotes(notes)
	}
	return notes, err
}

func checkRepo(repo string) error {
	return PrKey{Repo: repo, Number: 1}.check()
}

func (s *Store) notesFile(repo string) string {
	return filepath.Join(s.dir, RepoKey(repo), notesFileName)
}

func (s *Store) readNotes(repo string) (Notes, error) {
	rtn := Notes{Repo: repo, Notes: []Note{}}
	data, err := os.ReadFile(s.notesFile(repo))
	if errors.Is(err, os.ErrNotExist) {
		return rtn, nil
	}
	if err != nil {
		return rtn, err
	}
	// Unlike a PR's state, a notes file that does not read is never replaced: the developer's notes stay on disk.
	if err := json.Unmarshal(data, &rtn); err != nil {
		return Notes{Repo: repo, Notes: []Note{}}, fmt.Errorf("the notes file could not be read: %v", err)
	}
	rtn.Repo = repo
	if rtn.Notes == nil {
		rtn.Notes = []Note{}
	}
	return rtn, nil
}

func (s *Store) writeNotes(repo string, notes Notes) error {
	file := s.notesFile(repo)
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(notes, "", "  ")
	if err != nil {
		return err
	}
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, file)
}

// notesLock: a project's notes file has one lock, separate from its PRs'.
func (s *Store) notesLock(repo string) func() {
	lock := s.fileLock(s.notesFile(repo))
	lock.Lock()
	return lock.Unlock
}

func (s *Store) fileLock(file string) *sync.Mutex {
	s.lock.Lock()
	defer s.lock.Unlock()
	if s.locks[file] == nil {
		s.locks[file] = &sync.Mutex{}
	}
	return s.locks[file]
}

func (s *Store) GetNotes(repo string) (Notes, error) {
	if err := checkRepo(repo); err != nil {
		return Notes{}, err
	}
	unlock := s.notesLock(repo)
	defer unlock()
	return s.readNotes(repo)
}

func (s *Store) updateNotes(repo string, change func(notes *Notes) (bool, error)) (Notes, bool, error) {
	if err := checkRepo(repo); err != nil {
		return Notes{}, false, err
	}
	unlock := s.notesLock(repo)
	defer unlock()
	notes, err := s.readNotes(repo)
	if err != nil {
		return notes, false, err
	}
	changed, err := change(&notes)
	if err != nil || !changed {
		return notes, false, err
	}
	notes.UpdatedAt = s.now().UnixMilli()
	return notes, true, s.writeNotes(repo, notes)
}

func cleanTitle(title string) string {
	title = strings.Join(strings.Fields(title), " ")
	if utf8.RuneCountInString(title) > maxNoteTitle {
		title = string([]rune(title)[:maxNoteTitle])
	}
	return title
}

// defaultTitle: the technique, else the question, else the answer's first line.
func defaultTitle(e Explanation) string {
	for _, text := range []string{e.Technique, e.Question} {
		if t := cleanTitle(text); t != "" {
			return t
		}
	}
	for _, line := range strings.Split(e.Markdown, "\n") {
		if t := cleanTitle(strings.TrimLeft(line, "#>*- ")); t != "" {
			return t
		}
	}
	return "Note"
}

// KeepNote keeps one of the PR's answers as a note (AC1). The note is copied from the review store, so it is what the
// agent posted; keeping an answer already kept returns the notes unchanged.
func (s *Store) KeepNote(req NoteKeepRequest) (Notes, bool, error) {
	if req.ExplanationId == "" {
		return Notes{}, false, fmt.Errorf("explanationid is required")
	}
	if req.BaseRef != "" && !reviewsession.ValidRef(req.BaseRef) {
		return Notes{}, false, fmt.Errorf("baseref must be the PR's base branch")
	}
	state, err := s.Get(req.PrKey)
	if err != nil {
		return Notes{}, false, err
	}
	i := slices.IndexFunc(state.Explanations, func(e Explanation) bool { return e.Id == req.ExplanationId })
	if i < 0 {
		return Notes{}, false, fmt.Errorf("the answer is no longer in the PR's review")
	}
	e := state.Explanations[i]
	return s.updateNotes(req.Repo, func(notes *Notes) (bool, error) {
		if slices.ContainsFunc(notes.Notes, func(n Note) bool {
			return n.ExplanationId == e.Id && n.Pr.Number == req.Number
		}) {
			return false, nil
		}
		title := cleanTitle(req.Title)
		if title == "" {
			title = defaultTitle(e)
		}
		head := e.HeadOid
		if head == "" && e.Anchor != nil {
			head = e.Anchor.HeadOid
		}
		notes.Notes = append(notes.Notes, Note{
			Id: uuid.NewString(), Title: title, ExplanationId: e.Id, Technique: e.Technique, Question: e.Question,
			Markdown: e.Markdown, Depth: e.Depth, Principles: e.Principles, Sources: e.Sources, Related: e.Related,
			Anchor: e.Anchor, Pr: NotePr{Number: req.Number, Title: req.PrTitle, Url: req.PrUrl, BaseRef: req.BaseRef},
			HeadOid: head, Agent: e.Agent, KeptAt: s.now().UnixMilli(),
		})
		return true, nil
	})
}

func noteIndex(notes *Notes, id string) (int, error) {
	i := slices.IndexFunc(notes.Notes, func(n Note) bool { return n.Id == id })
	if id == "" || i < 0 {
		return -1, fmt.Errorf("the note was not found")
	}
	return i, nil
}

// RenameNote sets a note's title (AC3).
func (s *Store) RenameNote(req NoteRenameRequest) (Notes, bool, error) {
	title := cleanTitle(req.Title)
	if title == "" {
		return Notes{}, false, fmt.Errorf("a note needs a title")
	}
	return s.updateNotes(req.Repo, func(notes *Notes) (bool, error) {
		i, err := noteIndex(notes, req.Id)
		if err != nil || notes.Notes[i].Title == title {
			return false, err
		}
		notes.Notes[i].Title = title
		notes.Notes[i].UpdatedAt = s.now().UnixMilli()
		return true, nil
	})
}

// DeleteNote removes a note: the only way one goes (AC3).
func (s *Store) DeleteNote(req NoteDeleteRequest) (Notes, bool, error) {
	return s.updateNotes(req.Repo, func(notes *Notes) (bool, error) {
		i, err := noteIndex(notes, req.Id)
		if err != nil {
			return false, err
		}
		notes.Notes = slices.Delete(notes.Notes, i, i+1)
		return true, nil
	})
}

// cleanNotePath is a repository-relative path a note cites, or "" when it would leave the repository.
func cleanNotePath(p string) string {
	p = strings.TrimPrefix(strings.TrimSpace(p), "./")
	if p == "" || strings.ContainsAny(p, "\\\x00") || strings.HasPrefix(p, "/") || strings.HasPrefix(p, "-") {
		return ""
	}
	if slices.Contains(strings.Split(p, "/"), "..") {
		return ""
	}
	clean := path.Clean(p)
	if clean == "." || strings.HasPrefix(clean, "../") {
		return ""
	}
	return clean
}

type noteCommit struct {
	ref  string
	from string
}

// NoteFile reads a file a note cites from the project's git (AC2): at the PR's merged commit when the review store
// recorded the merge, else at the head the answer was made on, else at the base branch's tip, origin's then local.
// The first of them that has the file is written as a read-only snapshot in MoltenTerm's data folder, for a preview to
// open at the line. The PR's worktree is never read: the cleanup after the merge removes it.
func (s *Service) NoteFile(ctx context.Context, req NoteFileRequest) (NoteFileResult, error) {
	if err := checkDir(req.Dir); err != nil {
		return NoteFileResult{}, err
	}
	rel := cleanNotePath(req.Path)
	if rel == "" {
		return NoteFileResult{}, fmt.Errorf("the path must stay in the project")
	}
	notes, err := s.store.GetNotes(req.Repo)
	if err != nil {
		return NoteFileResult{}, err
	}
	i, err := noteIndex(&notes, req.Id)
	if err != nil {
		return NoteFileResult{}, err
	}
	note := notes.Notes[i]
	candidates := []noteCommit{}
	if state, err := s.store.Get(PrKey{Repo: req.Repo, Number: note.Pr.Number}); err == nil && state.Merge != nil &&
		state.Merge.State == MergeMerged && isOid(state.Merge.MergedOid) {
		candidates = append(candidates, noteCommit{state.Merge.MergedOid, NoteFromMerged})
	}
	if isOid(note.HeadOid) {
		candidates = append(candidates, noteCommit{note.HeadOid, NoteFromHead})
	}
	if reviewsession.ValidRef(note.Pr.BaseRef) {
		candidates = append(candidates,
			noteCommit{"refs/remotes/origin/" + note.Pr.BaseRef, NoteFromBase},
			noteCommit{"refs/heads/" + note.Pr.BaseRef, NoteFromBase})
	}
	for _, c := range candidates {
		out, err := s.git(ctx, req.Dir, "rev-parse", "--verify", "--quiet", c.ref+"^{commit}")
		oid := strings.TrimSpace(string(out))
		if err != nil || !isOid(oid) {
			continue
		}
		size, err := s.git(ctx, req.Dir, "cat-file", "-s", oid+":"+rel)
		if err != nil {
			continue
		}
		bytes, err := strconv.ParseInt(strings.TrimSpace(string(size)), 10, 64)
		if err != nil {
			continue
		}
		if bytes > maxNoteFileBytes {
			return NoteFileResult{}, fmt.Errorf("%s is too large to open from a note", rel)
		}
		file, err := s.noteSnapshot(ctx, req.Dir, req.Repo, oid, rel)
		if err != nil {
			return NoteFileResult{}, err
		}
		return NoteFileResult{File: file, Commit: oid, From: c.from}, nil
	}
	return NoteFileResult{}, fmt.Errorf("%s is neither in the PR's merged commit, its head nor the base branch", rel)
}

func (s *Service) noteSnapshot(ctx context.Context, dir string, repo string, oid string, rel string) (string, error) {
	root := filepath.Join(s.store.dir, RepoKey(repo), noteFilesDir, oid)
	file := filepath.Join(root, filepath.FromSlash(rel))
	if !strings.HasPrefix(file, root+string(filepath.Separator)) {
		return "", fmt.Errorf("the path must stay in the project")
	}
	// A commit's file never changes: a snapshot already written is the same.
	if _, err := os.Stat(file); err == nil {
		return file, nil
	}
	content, err := s.git(ctx, dir, "cat-file", "blob", oid+":"+rel)
	if err != nil {
		return "", fmt.Errorf("%s could not be read at %s: %v", rel, oid[:7], err)
	}
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		return "", err
	}
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, content, 0400); err != nil {
		return "", err
	}
	return file, os.Rename(tmp, file)
}
