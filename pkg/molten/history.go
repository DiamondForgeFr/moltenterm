// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// History of the mods (FR-MORPH-003, DS-MORPH-003): one snapshot of `<config>/mods/` and `mods.json` per recorded
// change, under `<data>/molten/history/<seq>/`. Snapshots hold the state after the change, so undoing a change means
// restoring the snapshot before it. The trust file is left out on purpose: undoing never grants trust.

const HistoryKeep = 50

const (
	HistoryKindStart  = "start"
	HistoryKindChange = "change"
	HistoryKindUndo   = "undo"
)

const historyEntryFile = "change.json"
const historyModsDir = "mods"

// While `molten undo` restores files, the watcher must not record them as an edit: undo records itself.
const historyRestoringMarker = ".restoring"
const historyMarkerMaxAge = 30 * time.Second

type HistoryEntry struct {
	Seq    int      `json:"seq"`
	Time   string   `json:"time"`
	Kind   string   `json:"kind"`
	Ids    []string `json:"ids"`
	Target int      `json:"target,omitempty"`
	Hash   string   `json:"hash"`
}

type History struct {
	lock      sync.Mutex
	Dir       string
	ModsDir   string
	StateFile string
}

func MakeHistory(dir string, modsDir string, stateFile string) *History {
	return &History{Dir: dir, ModsDir: modsDir, StateFile: stateFile}
}

func HistoryDir(dataDir string) string {
	return filepath.Join(dataDir, "molten", "history")
}

func (h *History) Entries() ([]HistoryEntry, error) {
	dirEntries, err := os.ReadDir(h.Dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	entries := []HistoryEntry{}
	for _, dirEntry := range dirEntries {
		if !dirEntry.IsDir() {
			continue
		}
		if _, err := strconv.Atoi(dirEntry.Name()); err != nil {
			continue
		}
		data, err := os.ReadFile(filepath.Join(h.Dir, dirEntry.Name(), historyEntryFile))
		if err != nil {
			continue
		}
		var entry HistoryEntry
		if json.Unmarshal(data, &entry) == nil {
			entries = append(entries, entry)
		}
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Seq < entries[j].Seq })
	return entries, nil
}

// Position is the entry whose state the mods are in: the last entry, or for an undo the entry it went back to,
// followed through chains of undos.
func HistoryPosition(entries []HistoryEntry) (int, bool) {
	if len(entries) == 0 {
		return 0, false
	}
	bySeq := make(map[int]HistoryEntry, len(entries))
	for _, entry := range entries {
		bySeq[entry.Seq] = entry
	}
	current := entries[len(entries)-1]
	for steps := 0; current.Kind == HistoryKindUndo && steps < len(entries); steps++ {
		target, ok := bySeq[current.Target]
		if !ok {
			return current.Target, false
		}
		current = target
	}
	return current.Seq, true
}

// UndoTarget is the entry `molten undo` restores: the one just before the current position.
func HistoryUndoTarget(entries []HistoryEntry) (HistoryEntry, error) {
	position, ok := HistoryPosition(entries)
	if !ok {
		return HistoryEntry{}, fmt.Errorf("nothing to undo")
	}
	for i := len(entries) - 1; i >= 0; i-- {
		if entries[i].Seq < position {
			return entries[i], nil
		}
	}
	return HistoryEntry{}, fmt.Errorf("nothing to undo: the oldest kept change (%d) is reached", position)
}

func (h *History) RestoringMarkerActive() bool {
	info, err := os.Stat(filepath.Join(h.Dir, historyRestoringMarker))
	return err == nil && time.Since(info.ModTime()) < historyMarkerMaxAge
}

// Record keeps a snapshot of the mods as they are now. A change that leaves them as the last snapshot has them is
// not recorded, nor is anything while an undo is restoring files.
func (h *History) Record(kind string, ids []string, target int, now time.Time) (bool, error) {
	h.lock.Lock()
	defer h.lock.Unlock()
	if kind != HistoryKindUndo && h.RestoringMarkerActive() {
		return false, nil
	}
	hash, err := h.currentHash()
	if err != nil {
		return false, err
	}
	entries, err := h.Entries()
	if err != nil {
		return false, err
	}
	if kind != HistoryKindUndo && len(entries) > 0 && entries[len(entries)-1].Hash == hash {
		return false, nil
	}
	seq := 1
	if len(entries) > 0 {
		seq = entries[len(entries)-1].Seq + 1
	}
	if ids == nil {
		ids = []string{}
	}
	entry := HistoryEntry{Seq: seq, Time: now.UTC().Format(time.RFC3339), Kind: kind, Ids: ids, Target: target, Hash: hash}
	err = os.MkdirAll(h.Dir, 0755)
	if err != nil {
		return false, err
	}
	tmpDir, err := os.MkdirTemp(h.Dir, ".record-")
	if err != nil {
		return false, err
	}
	defer os.RemoveAll(tmpDir)
	err = copyModsTree(h.ModsDir, filepath.Join(tmpDir, historyModsDir))
	if err != nil {
		return false, err
	}
	if data, readErr := os.ReadFile(h.StateFile); readErr == nil {
		err = os.WriteFile(filepath.Join(tmpDir, StateFileName), data, 0644)
		if err != nil {
			return false, err
		}
	}
	entryData, err := json.MarshalIndent(entry, "", "  ")
	if err != nil {
		return false, err
	}
	err = os.WriteFile(filepath.Join(tmpDir, historyEntryFile), append(entryData, '\n'), 0644)
	if err != nil {
		return false, err
	}
	err = os.Rename(tmpDir, filepath.Join(h.Dir, strconv.Itoa(seq)))
	if err != nil {
		return false, err
	}
	h.prune(append(entries, entry))
	return true, nil
}

func (h *History) prune(entries []HistoryEntry) {
	for len(entries) > HistoryKeep {
		os.RemoveAll(filepath.Join(h.Dir, strconv.Itoa(entries[0].Seq)))
		entries = entries[1:]
	}
}

// Undo restores the mods as they were before the current position and records the restore.
func (h *History) Undo(now time.Time) (HistoryEntry, HistoryEntry, error) {
	entries, err := h.Entries()
	if err != nil {
		return HistoryEntry{}, HistoryEntry{}, err
	}
	target, err := HistoryUndoTarget(entries)
	if err != nil {
		return HistoryEntry{}, HistoryEntry{}, err
	}
	markerPath := filepath.Join(h.Dir, historyRestoringMarker)
	err = os.WriteFile(markerPath, []byte(strconv.Itoa(target.Seq)), 0644)
	if err != nil {
		return HistoryEntry{}, HistoryEntry{}, err
	}
	defer os.Remove(markerPath)
	changed, err := h.restore(target.Seq)
	if err != nil {
		return HistoryEntry{}, HistoryEntry{}, err
	}
	_, err = h.Record(HistoryKindUndo, changed, target.Seq, now)
	if err != nil {
		return HistoryEntry{}, HistoryEntry{}, err
	}
	entries, err = h.Entries()
	if err != nil || len(entries) == 0 {
		return target, HistoryEntry{}, err
	}
	return target, entries[len(entries)-1], nil
}

// restore puts back the mods and mods.json of a snapshot. Each mod folder is swapped whole, through a hidden
// temporary folder that the watcher and the host ignore, so no tab ever loads half a mod.
func (h *History) restore(seq int) ([]string, error) {
	snapDir := filepath.Join(h.Dir, strconv.Itoa(seq))
	snapMods := filepath.Join(snapDir, historyModsDir)
	wanted, err := modFolders(snapMods)
	if err != nil {
		return nil, err
	}
	current, err := modFolders(h.ModsDir)
	if err != nil {
		return nil, err
	}
	err = os.MkdirAll(h.ModsDir, 0755)
	if err != nil {
		return nil, err
	}
	changed := []string{}
	for id := range current {
		if wanted[id] {
			continue
		}
		err = os.RemoveAll(filepath.Join(h.ModsDir, id))
		if err != nil {
			return nil, err
		}
		changed = append(changed, id)
	}
	for id := range wanted {
		same, err := treesEqual(filepath.Join(snapMods, id), filepath.Join(h.ModsDir, id))
		if err != nil {
			return nil, err
		}
		if same {
			continue
		}
		tmp := filepath.Join(h.ModsDir, ".restore-"+id)
		os.RemoveAll(tmp)
		err = copyModsTree(filepath.Join(snapMods, id), tmp)
		if err != nil {
			return nil, err
		}
		dest := filepath.Join(h.ModsDir, id)
		err = os.RemoveAll(dest)
		if err != nil {
			return nil, err
		}
		err = os.Rename(tmp, dest)
		if err != nil {
			return nil, err
		}
		changed = append(changed, id)
	}
	stateData, err := os.ReadFile(filepath.Join(snapDir, StateFileName))
	if errors.Is(err, os.ErrNotExist) {
		stateData = []byte("{\"enabled\": []}\n")
	} else if err != nil {
		return nil, err
	}
	err = os.MkdirAll(filepath.Dir(h.StateFile), 0755)
	if err != nil {
		return nil, err
	}
	tmpState := h.StateFile + ".tmp"
	err = os.WriteFile(tmpState, stateData, 0644)
	if err != nil {
		return nil, err
	}
	err = os.Rename(tmpState, h.StateFile)
	if err != nil {
		return nil, err
	}
	sort.Strings(changed)
	return changed, nil
}

func modFolders(dir string) (map[string]bool, error) {
	folders := make(map[string]bool)
	dirEntries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return folders, nil
	}
	if err != nil {
		return nil, err
	}
	for _, entry := range dirEntries {
		if entry.IsDir() && !strings.HasPrefix(entry.Name(), ".") {
			folders[entry.Name()] = true
		}
	}
	return folders, nil
}

// The files of a mods tree that count: hidden entries and editor droppings are skipped, as by the watcher.
func walkModsTree(root string, fn func(rel string, path string) error) error {
	return filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, os.ErrNotExist) && path == root {
				return filepath.SkipAll
			}
			return err
		}
		if path == root {
			return nil
		}
		if IgnoredModFileName(entry.Name()) {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		return fn(rel, path)
	})
}

func copyModsTree(src string, dest string) error {
	err := os.MkdirAll(dest, 0755)
	if err != nil {
		return err
	}
	return walkModsTree(src, func(rel string, path string) error {
		target := filepath.Join(dest, rel)
		if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			return err
		}
		return copyFile(path, target)
	})
}

func copyFile(src string, dest string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, in)
	closeErr := out.Close()
	if err != nil {
		return err
	}
	return closeErr
}

func treeHash(root string, extraFiles ...string) (string, error) {
	hasher := sha256.New()
	files := map[string]string{}
	err := walkModsTree(root, func(rel string, path string) error {
		files[filepath.ToSlash(rel)] = path
		return nil
	})
	if err != nil {
		return "", err
	}
	for _, extra := range extraFiles {
		if _, err := os.Stat(extra); err == nil {
			files["\x00"+filepath.Base(extra)] = extra
		}
	}
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		data, err := os.ReadFile(files[name])
		if err != nil {
			return "", err
		}
		fmt.Fprintf(hasher, "%s\x00%d\x00", name, len(data))
		hasher.Write(data)
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

func (h *History) currentHash() (string, error) {
	return treeHash(h.ModsDir, h.StateFile)
}

func treesEqual(a string, b string) (bool, error) {
	if _, err := os.Stat(b); errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	hashA, err := treeHash(a)
	if err != nil {
		return false, err
	}
	hashB, err := treeHash(b)
	if err != nil {
		return false, err
	}
	return hashA == hashB, nil
}
