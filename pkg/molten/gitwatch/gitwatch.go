// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package gitwatch tells when a repository's state may have changed without running git (FR-PERF-011, DS-PERF-010):
// one file-system watch per working tree on what git rewrites when the branch, the index or a ref moves (HEAD, index,
// packed-refs, config, refs/heads and refs/remotes). Each tree has a change sequence: a reader keeps the sequence its
// answer was computed at and runs git again only once it moved. Listeners hear about a change once per burst (a
// commit rewrites several files).
package gitwatch

import (
	"errors"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

const (
	// A commit writes the index, the branch ref and the reflog within a few milliseconds.
	DefaultDebounce = 100 * time.Millisecond
	// Watching costs file descriptors (kqueue opens every file of a watched folder on macOS): the trees asked about
	// most recently are kept.
	MaxTrees = 32
	// A tree nobody asked about for this long is no longer watched.
	IdleDrop = 10 * time.Minute
	// A repository with thousands of branch folders is watched up to this many folders; past it, its refs changes are
	// still seen through packed-refs and HEAD.
	maxRefDirs = 256
)

// The files of a git folder whose change can change a status: the checked-out branch, the index, the packed refs,
// the upstream configuration.
var watchedGitFiles = map[string]bool{"HEAD": true, "index": true, "packed-refs": true, "config": true}

// Dirs are a working tree's git folders: its own (HEAD, index) and the common one (refs) of the repository it belongs
// to, the same folder for a main checkout.
type Dirs struct {
	GitDir    string
	CommonDir string
}

// Linked tells a linked worktree (its git folder is not its repository's common folder).
func (d Dirs) Linked() bool {
	return d.GitDir != d.CommonDir
}

func readPointer(file string, base string) (string, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return "", err
	}
	value := strings.TrimSpace(string(data))
	value = strings.TrimSpace(strings.TrimPrefix(value, "gitdir:"))
	if value == "" {
		return "", errors.New("empty git pointer in " + file)
	}
	if !filepath.IsAbs(value) {
		value = filepath.Join(base, value)
	}
	return filepath.Clean(value), nil
}

// ReadDirs finds a working tree's git folders from its files, as git does, without running git: a .git folder, or a
// .git file pointing to the worktree's (or submodule's) git folder, whose commondir file points to the repository's.
func ReadDirs(root string) (Dirs, error) {
	dotGit := filepath.Join(root, ".git")
	info, err := os.Stat(dotGit)
	if err != nil {
		return Dirs{}, err
	}
	gitDir := dotGit
	if !info.IsDir() {
		gitDir, err = readPointer(dotGit, root)
		if err != nil {
			return Dirs{}, err
		}
		if info, err := os.Stat(gitDir); err != nil || !info.IsDir() {
			return Dirs{}, errors.New("the git folder of " + root + " is missing")
		}
	}
	common := gitDir
	if c, err := readPointer(filepath.Join(gitDir, "commondir"), gitDir); err == nil {
		common = c
	}
	return Dirs{GitDir: gitDir, CommonDir: common}, nil
}

// HeadBranch reads the branch HEAD points to (refs/heads/ stripped); empty when HEAD is detached or unreadable.
func HeadBranch(gitDir string) string {
	data, err := os.ReadFile(filepath.Join(gitDir, "HEAD"))
	if err != nil {
		return ""
	}
	ref, ok := strings.CutPrefix(strings.TrimSpace(string(data)), "ref:")
	if !ok {
		return ""
	}
	return strings.TrimPrefix(strings.TrimSpace(ref), "refs/heads/")
}

type tree struct {
	root   string
	dirs   Dirs
	seq    uint64
	usedAt time.Time
	// The folders watched for this tree.
	watched []string
}

type Watcher struct {
	lock     sync.Mutex
	fsw      *fsnotify.Watcher
	failed   bool
	closed   bool
	debounce time.Duration
	now      func() time.Time
	trees    map[string]*tree
	// Which trees each watched folder serves, and whether it is a refs folder (any file counts) or a git folder (only
	// watchedGitFiles count).
	dirTrees  map[string]map[string]bool
	refDirs   map[string]bool
	listeners []func(root string)
	pending   map[string]bool
	timer     *time.Timer
}

func MakeWatcher(debounce time.Duration) *Watcher {
	return &Watcher{
		debounce: debounce,
		now:      time.Now,
		trees:    map[string]*tree{},
		dirTrees: map[string]map[string]bool{},
		refDirs:  map[string]bool{},
		pending:  map[string]bool{},
	}
}

var defaultOnce sync.Once
var defaultWatcher *Watcher

// Default is wavesrv's watcher, shared by the status bar and Mission Control.
func Default() *Watcher {
	defaultOnce.Do(func() {
		defaultWatcher = MakeWatcher(DefaultDebounce)
	})
	return defaultWatcher
}

// OnChange adds a listener, called (outside any lock) with the root of each tree that changed, once per burst.
func (w *Watcher) OnChange(fn func(root string)) {
	w.lock.Lock()
	defer w.lock.Unlock()
	w.listeners = append(w.listeners, fn)
}

func (w *Watcher) startLocked() bool {
	if w.fsw != nil {
		return true
	}
	if w.failed || w.closed {
		return false
	}
	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		log.Printf("molten: git state is polled, no file watch: %v\n", err)
		w.failed = true
		return false
	}
	w.fsw = fsw
	go w.loop(fsw)
	return true
}

// Track starts watching the working tree at root when it is not yet, and returns its change sequence. ok is false
// when the tree cannot be watched (not a repository, no watch available): the caller then reads git as it did before.
func (w *Watcher) Track(root string) (uint64, bool) {
	root = filepath.Clean(root)
	w.lock.Lock()
	defer w.lock.Unlock()
	now := w.now()
	if t := w.trees[root]; t != nil {
		t.usedAt = now
		return t.seq, true
	}
	if !w.startLocked() {
		return 0, false
	}
	dirs, err := ReadDirs(root)
	if err != nil {
		return 0, false
	}
	w.dropIdleLocked(now)
	for len(w.trees) >= MaxTrees {
		w.dropOldestLocked()
	}
	t := &tree{root: root, dirs: dirs, usedAt: now}
	if !w.watchLocked(t, dirs.GitDir, false) {
		w.unwatchLocked(t)
		return 0, false
	}
	if dirs.Linked() {
		w.watchLocked(t, dirs.CommonDir, false)
	}
	refDirs := 0
	for _, sub := range []string{"heads", "remotes"} {
		w.watchRefsLocked(t, filepath.Join(dirs.CommonDir, "refs", sub), &refDirs)
	}
	w.trees[root] = t
	return t.seq, true
}

// Seq is the tree's change sequence without touching it; ok is false when it is not watched.
func (w *Watcher) Seq(root string) (uint64, bool) {
	w.lock.Lock()
	defer w.lock.Unlock()
	t := w.trees[filepath.Clean(root)]
	if t == nil {
		return 0, false
	}
	return t.seq, true
}

// Trees is the number of trees watched (tests, diagnostics).
func (w *Watcher) Trees() int {
	w.lock.Lock()
	defer w.lock.Unlock()
	return len(w.trees)
}

func (w *Watcher) watchRefsLocked(t *tree, dir string, count *int) {
	filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || !d.IsDir() {
			return nil
		}
		if *count >= maxRefDirs {
			return filepath.SkipAll
		}
		*count++
		w.watchLocked(t, path, true)
		return nil
	})
}

func (w *Watcher) watchLocked(t *tree, dir string, refs bool) bool {
	roots := w.dirTrees[dir]
	if roots == nil {
		if err := w.fsw.Add(dir); err != nil {
			return false
		}
		roots = map[string]bool{}
		w.dirTrees[dir] = roots
		if refs {
			w.refDirs[dir] = true
		}
	}
	if !roots[t.root] {
		roots[t.root] = true
		t.watched = append(t.watched, dir)
	}
	return true
}

func (w *Watcher) unwatchLocked(t *tree) {
	for _, dir := range t.watched {
		roots := w.dirTrees[dir]
		delete(roots, t.root)
		if len(roots) == 0 {
			delete(w.dirTrees, dir)
			delete(w.refDirs, dir)
			if w.fsw != nil {
				w.fsw.Remove(dir)
			}
		}
	}
	t.watched = nil
	delete(w.trees, t.root)
}

func (w *Watcher) dropIdleLocked(now time.Time) {
	for _, t := range w.trees {
		if now.Sub(t.usedAt) >= IdleDrop {
			w.unwatchLocked(t)
		}
	}
}

func (w *Watcher) dropOldestLocked() {
	var oldest *tree
	for _, t := range w.trees {
		if oldest == nil || t.usedAt.Before(oldest.usedAt) {
			oldest = t
		}
	}
	if oldest != nil {
		w.unwatchLocked(oldest)
	}
}

func (w *Watcher) loop(fsw *fsnotify.Watcher) {
	defer func() {
		panichandler.PanicHandler("molten:gitwatch", recover())
	}()
	for {
		select {
		case event, ok := <-fsw.Events:
			if !ok {
				return
			}
			w.handle(event)
		case _, ok := <-fsw.Errors:
			if !ok {
				return
			}
			// An overflow lost events: every tree may have changed.
			w.changedAll()
		}
	}
}

func (w *Watcher) handle(event fsnotify.Event) {
	// Reading the index (a `git status` that takes no lock) reports a chmod on macOS: nothing changed.
	if event.Op == fsnotify.Chmod {
		return
	}
	path := filepath.Clean(event.Name)
	dir, name := filepath.Dir(path), filepath.Base(path)
	w.lock.Lock()
	defer w.lock.Unlock()
	roots := w.dirTrees[dir]
	if len(roots) == 0 {
		return
	}
	if strings.HasSuffix(name, ".lock") {
		return
	}
	isRefs := w.refDirs[dir]
	if !isRefs && !watchedGitFiles[name] {
		return
	}
	if isRefs && event.Has(fsnotify.Create) {
		// A branch with a slash (feature/x) makes a folder: its refs are watched too.
		if info, err := os.Stat(path); err == nil && info.IsDir() {
			for root := range roots {
				if t := w.trees[root]; t != nil && len(t.watched) < maxRefDirs {
					count := len(t.watched)
					w.watchRefsLocked(t, path, &count)
				}
			}
		}
	}
	for root := range roots {
		w.changedLocked(root)
	}
}

func (w *Watcher) changedAll() {
	w.lock.Lock()
	defer w.lock.Unlock()
	for root := range w.trees {
		w.changedLocked(root)
	}
}

func (w *Watcher) changedLocked(root string) {
	t := w.trees[root]
	if t == nil {
		return
	}
	t.seq++
	w.pending[root] = true
	if w.timer != nil {
		w.timer.Stop()
	}
	w.timer = time.AfterFunc(w.debounce, w.flush)
}

func (w *Watcher) takePending() ([]string, []func(root string)) {
	w.lock.Lock()
	defer w.lock.Unlock()
	w.timer = nil
	roots := make([]string, 0, len(w.pending))
	for root := range w.pending {
		roots = append(roots, root)
	}
	w.pending = map[string]bool{}
	return roots, append([]func(root string){}, w.listeners...)
}

func (w *Watcher) flush() {
	defer func() {
		panichandler.PanicHandler("molten:gitwatch:flush", recover())
	}()
	roots, listeners := w.takePending()
	for _, root := range roots {
		for _, fn := range listeners {
			fn(root)
		}
	}
}

// Close stops watching (tests).
func (w *Watcher) Close() {
	w.lock.Lock()
	defer w.lock.Unlock()
	w.closed = true
	if w.timer != nil {
		w.timer.Stop()
		w.timer = nil
	}
	if w.fsw != nil {
		w.fsw.Close()
		w.fsw = nil
	}
	w.trees = map[string]*tree{}
	w.dirTrees = map[string]map[string]bool{}
	w.refDirs = map[string]bool{}
}
