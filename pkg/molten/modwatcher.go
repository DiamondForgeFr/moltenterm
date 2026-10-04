// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package molten holds Moltenterm's own server-side code for mods (Automorph).
//
// The mod watcher (FR-MORPH-002, DS-MORPH-003) reloads mods on save. It watches `<config>/mods/` and every folder
// below it, plus the enabled state (`<config>/molten/mods.json`) and the trust file (`<data>/molten/trust.json`),
// and publishes `molten:modschanged` with the ids concerned; each tab's mod host reloads only those. Wave's own
// config watcher (pkg/wconfig/filewatcher.go) ignores `mods/`, so the two never overlap.
package molten

import (
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/wavetermdev/waveterm/pkg/molten/agentparts"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

// must match MoltenModsChangedEvent in frontend/molten/molten-start.ts and cmd/wsh/cmd/wshcmd-molten.go
const ModsChangedEvent = "molten:modschanged"

// An editor's save is a burst of write, rename and chmod events; one reload per burst.
const ModWatcherDebounce = 200 * time.Millisecond

const StateFileName = "mods.json"
const TrustFileName = "trust.json"

type ModWatcher struct {
	lock      sync.Mutex
	watcher   *fsnotify.Watcher
	modsDir   string
	stateFile string
	trustFile string
	debounce  time.Duration
	publish   func(ids []string)
	// Records each change before it is announced (FR-MORPH-003); nil in tests that only check events.
	history *History
	// Points the Claude Code slots after each change (FR-MORPH-010); nil in tests that only check events.
	syncParts func()
	pending   map[string]bool
	timer     *time.Timer
	// Last seen content of mods.json and trust.json, so that a change to them reloads only the mods it concerns.
	lastState map[string]string
}

func MakeModWatcher(modsDir string, stateFile string, trustFile string, debounce time.Duration, publish func(ids []string)) (*ModWatcher, error) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	mw := &ModWatcher{
		watcher:   watcher,
		modsDir:   filepath.Clean(modsDir),
		stateFile: filepath.Clean(stateFile),
		trustFile: filepath.Clean(trustFile),
		debounce:  debounce,
		publish:   publish,
		pending:   make(map[string]bool),
	}
	mw.lastState = mw.readStateSnapshot()
	for _, dir := range []string{mw.modsDir, filepath.Dir(mw.stateFile), filepath.Dir(mw.trustFile)} {
		err = os.MkdirAll(dir, 0755)
		if err != nil {
			watcher.Close()
			return nil, err
		}
	}
	// The state files are replaced by rename when written, which drops a watch on the file itself: their folders
	// are watched instead.
	for _, dir := range []string{filepath.Dir(mw.stateFile), filepath.Dir(mw.trustFile)} {
		err = watcher.Add(dir)
		if err != nil {
			watcher.Close()
			return nil, err
		}
	}
	mw.addTree(mw.modsDir)
	return mw, nil
}

// StartModWatcher runs the mod watcher for the app's config and data directories; wavesrv calls it at start.
func StartModWatcher() {
	configDir := wavebase.GetWaveConfigDir()
	dataDir := wavebase.GetWaveDataDir()
	modsDir := filepath.Join(configDir, "mods")
	stateFile := filepath.Join(configDir, "molten", StateFileName)
	safeMode := os.Getenv(agentparts.SafeModeVarName) == "1"
	syncParts := func(prune bool) {
		if err := agentparts.SyncClaudeCodeSlots(configDir, dataDir, safeMode, prune, runtime.GOOS); err != nil {
			log.Printf("molten: Claude Code parts: %v\n", err)
		}
	}
	// Before any terminal starts, and even when the watcher cannot: a durable terminal reattached in safe mode must
	// find every slot pointing at its placeholder.
	syncParts(true)
	mw, err := MakeModWatcher(modsDir, stateFile, filepath.Join(dataDir, "molten", TrustFileName), ModWatcherDebounce, publishModsChanged)
	if err != nil {
		log.Printf("molten: mod watcher not started: %v\n", err)
		return
	}
	mw.syncParts = func() { syncParts(false) }
	mw.history = MakeHistory(HistoryDir(dataDir), modsDir, stateFile)
	if _, err := mw.history.Record(HistoryKindStart, nil, 0, time.Now()); err != nil {
		log.Printf("molten: recording the mods at start: %v\n", err)
	}
	go mw.Run()
}

func publishModsChanged(ids []string) {
	wps.Broker.Publish(wps.WaveEvent{
		Event: ModsChangedEvent,
		Data:  map[string]any{"ids": ids},
	})
}

func (mw *ModWatcher) Run() {
	defer func() {
		panichandler.PanicHandler("molten:ModWatcher", recover())
	}()
	for {
		select {
		case event, ok := <-mw.watcher.Events:
			if !ok {
				return
			}
			mw.handleEvent(event)
		case err, ok := <-mw.watcher.Errors:
			if !ok {
				return
			}
			log.Printf("molten: mod watcher error: %v\n", err)
		}
	}
}

func (mw *ModWatcher) Close() error {
	mw.lock.Lock()
	defer mw.lock.Unlock()
	if mw.timer != nil {
		mw.timer.Stop()
	}
	return mw.watcher.Close()
}

func (mw *ModWatcher) addTree(root string) {
	filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || !entry.IsDir() {
			return nil
		}
		if path != root && mw.ignoredPath(path) {
			return filepath.SkipDir
		}
		if addErr := mw.watcher.Add(path); addErr != nil {
			log.Printf("molten: cannot watch %s: %v\n", path, addErr)
		}
		return nil
	})
}

// A path under the mods folder that is not part of any mod: a hidden folder at the top (an undo's temporary copy)
// or a path IgnoredModRelPath leaves out.
func (mw *ModWatcher) ignoredPath(path string) bool {
	rel, err := filepath.Rel(mw.modsDir, path)
	if err != nil || rel == "." {
		return false
	}
	return strings.HasPrefix(rel, ".") || agentparts.IgnoredModRelPath(rel)
}

// IgnoredModFileName tells the files editors leave behind while saving, which must not reload a mod.
func IgnoredModFileName(name string) bool {
	return agentparts.IgnoredFileName(name)
}

// ModIdForPath gives the mod a path under the mods folder belongs to: its first folder below modsDir.
func ModIdForPath(modsDir string, path string) (string, bool) {
	rel, err := filepath.Rel(modsDir, path)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
		return "", false
	}
	parts := strings.Split(rel, string(filepath.Separator))
	if strings.HasPrefix(parts[0], ".") || agentparts.IgnoredModRelPath(rel) {
		return "", false
	}
	return parts[0], true
}

func (mw *ModWatcher) handleEvent(event fsnotify.Event) {
	if event.Op == fsnotify.Chmod {
		return
	}
	path := filepath.Clean(event.Name)
	if path == mw.stateFile || path == mw.trustFile {
		mw.queue(mw.stateChanges()...)
		return
	}
	id, ok := ModIdForPath(mw.modsDir, path)
	if !ok {
		return
	}
	if event.Op.Has(fsnotify.Create) {
		if info, err := os.Stat(path); err == nil && info.IsDir() {
			mw.addTree(path)
		}
	}
	mw.queue(id)
}

func (mw *ModWatcher) queue(ids ...string) {
	if len(ids) == 0 {
		return
	}
	mw.lock.Lock()
	defer mw.lock.Unlock()
	for _, id := range ids {
		mw.pending[id] = true
	}
	if mw.timer != nil {
		mw.timer.Stop()
	}
	mw.timer = time.AfterFunc(mw.debounce, mw.flush)
}

func (mw *ModWatcher) takePending() []string {
	mw.lock.Lock()
	defer mw.lock.Unlock()
	ids := make([]string, 0, len(mw.pending))
	for id := range mw.pending {
		ids = append(ids, id)
	}
	mw.pending = make(map[string]bool)
	sort.Strings(ids)
	return ids
}

func (mw *ModWatcher) flush() {
	ids := mw.takePending()
	if len(ids) == 0 {
		return
	}
	if mw.history != nil {
		if _, err := mw.history.Record(HistoryKindChange, ids, 0, time.Now()); err != nil {
			log.Printf("molten: recording the change of %v: %v\n", ids, err)
		}
	}
	if mw.syncParts != nil {
		mw.syncParts()
	}
	mw.publish(ids)
}

type stateFileContent struct {
	Enabled  []string `json:"enabled"`
	Disabled []string `json:"disabled"`
}

type trustFileContent struct {
	Trusted map[string]json.RawMessage `json:"trusted"`
}

type trustEntryAgents struct {
	Agents []string `json:"agents"`
}

// One entry per mod mentioned by mods.json or trust.json: "enabled", "disabled", "trusted" joined. A file that cannot
// be read or parsed counts as empty; the host reports the parse error itself.
func (mw *ModWatcher) readStateSnapshot() map[string]string {
	marks := make(map[string][]string)
	var state stateFileContent
	if data, err := os.ReadFile(mw.stateFile); err == nil {
		json.Unmarshal(data, &state)
	}
	for _, id := range state.Enabled {
		marks[id] = append(marks[id], "enabled")
	}
	for _, id := range state.Disabled {
		marks[id] = append(marks[id], "disabled")
	}
	var trust trustFileContent
	if data, err := os.ReadFile(mw.trustFile); err == nil {
		json.Unmarshal(data, &trust)
	} else if !errors.Is(err, os.ErrNotExist) {
		log.Printf("molten: reading %s: %v\n", mw.trustFile, err)
	}
	for id, raw := range trust.Trusted {
		marks[id] = append(marks[id], "trusted")
		// A trust that starts covering the mod's Claude Code part changes its slot: announce it like any change.
		var entry trustEntryAgents
		json.Unmarshal(raw, &entry)
		for _, agent := range entry.Agents {
			marks[id] = append(marks[id], "trusted:"+agent)
		}
	}
	snapshot := make(map[string]string, len(marks))
	for id, list := range marks {
		sort.Strings(list)
		snapshot[id] = strings.Join(list, ",")
	}
	return snapshot
}

func (mw *ModWatcher) stateChanges() []string {
	next := mw.readStateSnapshot()
	mw.lock.Lock()
	prev := mw.lastState
	mw.lastState = next
	mw.lock.Unlock()
	return diffSnapshots(prev, next)
}

func diffSnapshots(prev map[string]string, next map[string]string) []string {
	changed := []string{}
	for id, marks := range next {
		if prev[id] != marks {
			changed = append(changed, id)
		}
	}
	for id := range prev {
		if _, ok := next[id]; !ok {
			changed = append(changed, id)
		}
	}
	sort.Strings(changed)
	return changed
}
