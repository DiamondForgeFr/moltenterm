// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package checkpoint

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// Storage (DS-CONT-008): <data dir>/molten/tasks/<workspace id>/checkpoint.md, 0600 in 0700 folders, and its history in
// history/<unix ms>.md. Writes go to a temporary file renamed over the checkpoint, so a failed write leaves the
// previous file; they are serialised per workspace. The workspace folder is never written (NFR-CONT-002).

const (
	CheckpointFile = "checkpoint.md"
	HistoryDir     = "history"
	DeletedDir     = ".deleted"
	// The checkpoint's size cap (FR-CONT-007 validation rule); a file larger than MaxFileBytes is not read.
	MaxCheckpointBytes = 64 * 1024
	MaxFileBytes       = 1024 * 1024
	MaxVersions        = 20
	MaxVersionAge      = 30 * 24 * time.Hour
	DeletedKeep        = 30 * 24 * time.Hour
	// Auto writes over an auto version make one history version per this long: the history keeps the user's and the
	// agents' versions, not every turn.
	AutoVersionEvery = 10 * time.Minute

	dirMode  = 0o700
	fileMode = 0o600
)

var workspaceIdRegex = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
var historyNameRegex = regexp.MustCompile(`^([0-9]{1,16})\.md$`)
var deletedNameRegex = regexp.MustCompile(`^([A-Za-z0-9][A-Za-z0-9_-]{0,63})-([0-9]{1,16})$`)

var ErrTooLarge = fmt.Errorf("the task checkpoint is larger than %d KB", MaxCheckpointBytes/1024)

// Store holds the checkpoints of every workspace.
type Store struct {
	root string
	lock sync.Mutex
	// One lock per workspace: two panes of a workspace write the same file, one after the other.
	wsLocks  map[string]*sync.Mutex
	now      func() time.Time
	onChange func(molten.TaskChanged)
}

func MakeStore(root string) *Store {
	return &Store{root: root, wsLocks: map[string]*sync.Mutex{}, now: time.Now}
}

func (s *Store) Root() string {
	return s.root
}

// SetOnChange is called after each write, outside the workspace's lock.
func (s *Store) SetOnChange(fn func(molten.TaskChanged)) {
	s.lock.Lock()
	defer s.lock.Unlock()
	s.onChange = fn
}

func (s *Store) changed(ev molten.TaskChanged) {
	s.lock.Lock()
	fn := s.onChange
	s.lock.Unlock()
	if fn != nil {
		fn(ev)
	}
}

func (s *Store) workspaceLock(wsId string) *sync.Mutex {
	s.lock.Lock()
	defer s.lock.Unlock()
	l := s.wsLocks[wsId]
	if l == nil {
		l = &sync.Mutex{}
		s.wsLocks[wsId] = l
	}
	return l
}

func (s *Store) withWorkspace(wsId string, fn func() error) error {
	if err := ValidWorkspaceId(wsId); err != nil {
		return err
	}
	l := s.workspaceLock(wsId)
	l.Lock()
	defer l.Unlock()
	return fn()
}

func ValidWorkspaceId(wsId string) error {
	if !workspaceIdRegex.MatchString(wsId) {
		return fmt.Errorf("invalid workspace id")
	}
	return nil
}

func (s *Store) dir(wsId string) string {
	return filepath.Join(s.root, wsId)
}

// Path is the checkpoint file of a workspace (it may not exist yet).
func (s *Store) Path(wsId string) (string, error) {
	if err := ValidWorkspaceId(wsId); err != nil {
		return "", err
	}
	return filepath.Join(s.dir(wsId), CheckpointFile), nil
}

// readFile reads a regular file of at most MaxFileBytes; a missing file is (nil, nil).
func readFile(path string) ([]byte, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file", filepath.Base(path))
	}
	if info.Size() > MaxFileBytes {
		return nil, fmt.Errorf("%s is larger than %d KB", filepath.Base(path), MaxFileBytes/1024)
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(io.LimitReader(f, MaxFileBytes))
}

func (s *Store) readLocked(wsId string) (*Checkpoint, []byte, error) {
	path := filepath.Join(s.dir(wsId), CheckpointFile)
	data, err := readFile(path)
	if err != nil {
		return nil, nil, err
	}
	if data == nil {
		return MakeCheckpoint(wsId), nil, nil
	}
	c := Parse(data)
	c.Workspace = wsId
	return c, data, nil
}

// Read returns a workspace's checkpoint, empty when none was written; exists tells whether the file exists.
func (s *Store) Read(wsId string) (*Checkpoint, bool, error) {
	var c *Checkpoint
	exists := false
	err := s.withWorkspace(wsId, func() error {
		var data []byte
		var err error
		c, data, err = s.readLocked(wsId)
		exists = data != nil
		return err
	})
	return c, exists, err
}

// View is what the read API returns: the checkpoint with its secrets redacted (a hand edit is redacted when read
// too, before the next write redacts the file).
func (s *Store) View(wsId string, section string) (molten.TaskView, error) {
	var view molten.TaskView
	err := s.withWorkspace(wsId, func() error {
		c, data, err := s.readLocked(wsId)
		if err != nil {
			return err
		}
		c.redactAll()
		path := filepath.Join(s.dir(wsId), CheckpointFile)
		view = molten.TaskView{WorkspaceId: wsId, Path: path, Exists: data != nil, Started: c.Started, Updated: c.Updated, UpdatedBy: c.UpdatedBy}
		if c.Transcript != (molten.TaskTranscript{}) {
			t := c.Transcript
			view.Transcript = &t
		}
		rendered := string(c.Render())
		view.Redactions = CountRedacted(rendered)
		view.Versions = len(s.versionsLocked(wsId))
		if section == "" {
			view.Sections = c.View()
			if data != nil {
				view.Markdown = rendered
			}
			return nil
		}
		sec := c.Section(section)
		if sec == nil {
			return fmt.Errorf("no section %q (sections: %s)", section, strings.Join(SectionNames, ", "))
		}
		view.Sections = []molten.TaskSection{{Name: sec.Name, Owner: sec.Owner, At: sec.At, Text: sec.Body, Extra: sec.Extra}}
		return nil
	})
	return view, err
}

// Update reads the checkpoint, lets fn change it and writes it when fn says it changed. author: auto, user or
// <agent>:<session>.
func (s *Store) Update(wsId string, author string, fn func(c *Checkpoint) bool) (bool, error) {
	var ev molten.TaskChanged
	wrote := false
	err := s.withWorkspace(wsId, func() error {
		c, data, err := s.readLocked(wsId)
		if err != nil {
			return err
		}
		previousBy := c.UpdatedBy
		if c.HandEdited {
			previousBy = OwnerUser
		}
		if !fn(c) {
			return nil
		}
		if err := s.writeLocked(wsId, c, author, data, previousBy, false); err != nil {
			return err
		}
		wrote = true
		ev = molten.TaskChanged{WorkspaceId: wsId, Updated: c.Updated, UpdatedBy: c.UpdatedBy}
		return nil
	})
	if wrote {
		s.changed(ev)
	}
	return wrote, err
}

// Ensure writes an empty checkpoint when the workspace has none, so it can be opened in an editor.
func (s *Store) Ensure(wsId string) error {
	created := false
	var ev molten.TaskChanged
	err := s.withWorkspace(wsId, func() error {
		_, data, err := s.readLocked(wsId)
		if err != nil || data != nil {
			return err
		}
		c := MakeCheckpoint(wsId)
		if err := s.writeLocked(wsId, c, OwnerAuto, nil, "", false); err != nil {
			return err
		}
		created = true
		ev = molten.TaskChanged{WorkspaceId: wsId, Updated: c.Updated, UpdatedBy: c.UpdatedBy}
		return nil
	})
	if created {
		s.changed(ev)
	}
	return err
}

// Clear starts a new task: the current checkpoint goes to the history, an empty one takes its place.
func (s *Store) Clear(wsId string) error {
	var ev molten.TaskChanged
	err := s.withWorkspace(wsId, func() error {
		_, data, err := s.readLocked(wsId)
		if err != nil {
			return err
		}
		c := MakeCheckpoint(wsId)
		c.Started = s.now().UnixMilli()
		if err := s.writeLocked(wsId, c, OwnerUser, data, "", true); err != nil {
			return err
		}
		ev = molten.TaskChanged{WorkspaceId: wsId, Updated: c.Updated, UpdatedBy: c.UpdatedBy}
		return nil
	})
	if err == nil {
		s.changed(ev)
	}
	return err
}

// Restore makes version n of the history (1 the newest) the checkpoint again; the current one goes to the history.
func (s *Store) Restore(wsId string, n int) error {
	var ev molten.TaskChanged
	err := s.withWorkspace(wsId, func() error {
		versions := s.versionsLocked(wsId)
		if n < 1 || n > len(versions) {
			return fmt.Errorf("no version %d in the history (%d versions)", n, len(versions))
		}
		old, err := readFile(versions[n-1].path)
		if err != nil {
			return err
		}
		if old == nil {
			return fmt.Errorf("version %d is no longer in the history", n)
		}
		_, data, err := s.readLocked(wsId)
		if err != nil {
			return err
		}
		c := Parse(old)
		c.Workspace = wsId
		if err := s.writeLocked(wsId, c, OwnerUser, data, "", true); err != nil {
			return err
		}
		ev = molten.TaskChanged{WorkspaceId: wsId, Updated: c.Updated, UpdatedBy: c.UpdatedBy}
		return nil
	})
	if err == nil {
		s.changed(ev)
	}
	return err
}

// writeLocked archives the previous file when the history should keep it, then writes the checkpoint atomically.
// Every write redacts the whole document first, the user's own text included (DS-CONT-010).
func (s *Store) writeLocked(wsId string, c *Checkpoint, author string, previous []byte, previousBy string, alwaysArchive bool) error {
	now := s.now()
	c.Workspace = wsId
	c.Updated = now.UnixMilli()
	c.UpdatedBy = author
	c.redactAll()
	out := c.Render()
	if len(out) > MaxCheckpointBytes {
		if author != OwnerAuto {
			return ErrTooLarge
		}
		out = shrinkAuto(c)
	}
	dir := s.dir(wsId)
	if err := ensureDir(s.root); err != nil {
		return err
	}
	if err := ensureDir(dir); err != nil {
		return err
	}
	if previous != nil && (alwaysArchive || !s.coalesceLocked(wsId, author, previousBy, now)) {
		if err := s.archiveLocked(wsId, previous, now); err != nil {
			return err
		}
	}
	if err := writeAtomic(filepath.Join(dir, CheckpointFile), out); err != nil {
		return err
	}
	s.pruneLocked(wsId, now)
	return nil
}

// shrinkAuto cuts the sections auto owns until the file fits; the user's and the agents' sections are kept whole.
func shrinkAuto(c *Checkpoint) []byte {
	for _, name := range []string{SectionPlan, SectionFiles, SectionTranscript, SectionTicket, SectionGoal} {
		sec := c.Section(name)
		if sec == nil || sec.Owner != OwnerAuto {
			continue
		}
		for len(c.Render()) > MaxCheckpointBytes && sec.Body != "" {
			lines := strings.Split(sec.Body, "\n")
			if len(lines) <= 1 {
				sec.Body, sec.Owner, sec.At = "", "", 0
				break
			}
			sec.Body = strings.Join(lines[:len(lines)/2], "\n")
		}
		if len(c.Render()) <= MaxCheckpointBytes {
			break
		}
	}
	return c.Render()
}

// coalesceLocked: an auto write over an auto version does not archive it when the newest archived version is recent.
func (s *Store) coalesceLocked(wsId string, author string, previousBy string, now time.Time) bool {
	if author != OwnerAuto || previousBy != OwnerAuto {
		return false
	}
	versions := s.versionsLocked(wsId)
	if len(versions) == 0 {
		return false
	}
	return now.Sub(time.UnixMilli(versions[0].at)) < AutoVersionEvery
}

func (s *Store) archiveLocked(wsId string, data []byte, now time.Time) error {
	hist := filepath.Join(s.dir(wsId), HistoryDir)
	if err := ensureDir(hist); err != nil {
		return err
	}
	at := now.UnixMilli()
	// Two writes in the same millisecond keep both versions.
	for {
		if _, err := os.Lstat(filepath.Join(hist, strconv.FormatInt(at, 10)+".md")); errors.Is(err, os.ErrNotExist) {
			break
		}
		at++
	}
	return writeAtomic(filepath.Join(hist, strconv.FormatInt(at, 10)+".md"), data)
}

type version struct {
	path string
	at   int64
	size int64
}

// versionsLocked lists the history, newest first.
func (s *Store) versionsLocked(wsId string) []version {
	hist := filepath.Join(s.dir(wsId), HistoryDir)
	entries, err := os.ReadDir(hist)
	if err != nil {
		return nil
	}
	var rtn []version
	for _, e := range entries {
		m := historyNameRegex.FindStringSubmatch(e.Name())
		if m == nil || !e.Type().IsRegular() {
			continue
		}
		at, err := strconv.ParseInt(m[1], 10, 64)
		if err != nil {
			continue
		}
		v := version{path: filepath.Join(hist, e.Name()), at: at}
		if info, err := e.Info(); err == nil {
			v.size = info.Size()
		}
		rtn = append(rtn, v)
	}
	sort.Slice(rtn, func(i, j int) bool { return rtn[i].at > rtn[j].at })
	return rtn
}

func (s *Store) pruneLocked(wsId string, now time.Time) {
	for i, v := range s.versionsLocked(wsId) {
		if i >= MaxVersions || now.Sub(time.UnixMilli(v.at)) > MaxVersionAge {
			os.Remove(v.path)
		}
	}
}

// History lists the versions, newest first, numbered from 1.
func (s *Store) History(wsId string) ([]molten.TaskVersion, error) {
	var rtn []molten.TaskVersion
	err := s.withWorkspace(wsId, func() error {
		for i, v := range s.versionsLocked(wsId) {
			tv := molten.TaskVersion{N: i + 1, At: v.at, Size: v.size}
			if data, err := readFile(v.path); err == nil && data != nil {
				c := Parse(data)
				tv.UpdatedBy = c.UpdatedBy
				if goal := c.Section(SectionGoal); goal != nil {
					redacted, _ := Redact(goal.Body)
					tv.Goal = cutText(markdownLine(redacted), 120)
				}
			}
			rtn = append(rtn, tv)
		}
		return nil
	})
	return rtn, err
}

func ensureDir(dir string) error {
	if err := os.MkdirAll(dir, dirMode); err != nil {
		return err
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("%s is not a folder", dir)
	}
	if info.Mode().Perm() != dirMode {
		return os.Chmod(dir, dirMode)
	}
	return nil
}

// writeAtomic writes a temporary file next to the target, flushed, then renames it over the target.
func writeAtomic(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	ok := false
	defer func() {
		if !ok {
			tmp.Close()
			os.Remove(name)
		}
	}()
	if err := tmp.Chmod(fileMode); err != nil {
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(name, path); err != nil {
		return err
	}
	ok = true
	return nil
}

// Sweep moves the checkpoints of deleted workspaces to .deleted/ and removes those kept there longer than DeletedKeep.
// exists answers for a workspace id; on an error the folder stays.
func (s *Store) Sweep(exists func(wsId string) (bool, error)) {
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return
	}
	now := s.now()
	for _, e := range entries {
		name := e.Name()
		if !e.IsDir() || strings.HasPrefix(name, ".") || ValidWorkspaceId(name) != nil {
			continue
		}
		ok, err := exists(name)
		if err != nil || ok {
			continue
		}
		s.moveDeleted(name, now)
	}
	deleted := filepath.Join(s.root, DeletedDir)
	entries, err = os.ReadDir(deleted)
	if err != nil {
		return
	}
	for _, e := range entries {
		m := deletedNameRegex.FindStringSubmatch(e.Name())
		if m == nil {
			continue
		}
		at, err := strconv.ParseInt(m[2], 10, 64)
		if err != nil || now.Sub(time.UnixMilli(at)) <= DeletedKeep {
			continue
		}
		os.RemoveAll(filepath.Join(deleted, e.Name()))
	}
}

func (s *Store) moveDeleted(wsId string, now time.Time) {
	s.withWorkspace(wsId, func() error {
		deleted := filepath.Join(s.root, DeletedDir)
		if err := ensureDir(deleted); err != nil {
			return err
		}
		return os.Rename(s.dir(wsId), filepath.Join(deleted, fmt.Sprintf("%s-%d", wsId, now.UnixMilli())))
	})
}
