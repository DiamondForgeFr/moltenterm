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

	"github.com/wavetermdev/waveterm/pkg/molten/agentparts"
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
	if err := historyManagedDirectory(h.Dir); err != nil {
		return nil, err
	}
	dirEntries, err := os.ReadDir(h.Dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	entries := []HistoryEntry{}
	for _, dirEntry := range dirEntries {
		seq, err := strconv.Atoi(dirEntry.Name())
		if err != nil {
			continue
		}
		if seq <= 0 || strconv.Itoa(seq) != dirEntry.Name() || !dirEntry.IsDir() {
			return nil, fmt.Errorf("invalid history snapshot directory %q", dirEntry.Name())
		}
		data, err := historyReadFile(filepath.Join(h.Dir, dirEntry.Name(), historyEntryFile))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		var entry HistoryEntry
		if err := json.Unmarshal(data, &entry); err != nil {
			return nil, err
		}
		if entry.Seq != seq {
			return nil, fmt.Errorf("history metadata sequence does not match snapshot directory")
		}
		entries = append(entries, entry)
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
	info, err := os.Lstat(filepath.Join(h.Dir, historyRestoringMarker))
	return err == nil && info.Mode().IsRegular() && time.Since(info.ModTime()) < historyMarkerMaxAge
}

// Record keeps a snapshot of the mods as they are now. A change that leaves them as the last snapshot has them is
// not recorded, nor is anything while an undo is restoring files.
func (h *History) Record(kind string, ids []string, target int, now time.Time) (bool, error) {
	h.lock.Lock()
	defer h.lock.Unlock()
	if err := historyManagedDirectory(h.Dir); err != nil {
		return false, err
	}
	if err := historyOptionalRegular(filepath.Join(h.Dir, historyRestoringMarker)); err != nil {
		return false, err
	}
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
	if data, readErr := historyReadFile(h.StateFile); readErr == nil {
		err = os.WriteFile(filepath.Join(tmpDir, StateFileName), data, 0644)
		if err != nil {
			return false, err
		}
	} else if !errors.Is(readErr, os.ErrNotExist) {
		return false, readErr
	}
	// Source files may change while recording. The entry describes the staged bytes actually published.
	entry.Hash, err = treeHash(filepath.Join(tmpDir, historyModsDir), filepath.Join(tmpDir, StateFileName))
	if err != nil {
		return false, err
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
	changed, err := h.restore(target.Seq)
	if err != nil {
		return HistoryEntry{}, HistoryEntry{}, err
	}
	defer os.Remove(filepath.Join(h.Dir, historyRestoringMarker))
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
	if seq <= 0 {
		return nil, fmt.Errorf("invalid history snapshot sequence")
	}
	if err := historyManagedDirectory(h.Dir); err != nil {
		return nil, err
	}
	snapDir := filepath.Join(h.Dir, strconv.Itoa(seq))
	snapMods := filepath.Join(snapDir, historyModsDir)
	// A missing selected snapshot must never mean an empty state that removes all current mods.
	for _, dir := range []string{snapDir, snapMods} {
		if err := historyDirectory(dir, false); err != nil {
			return nil, err
		}
	}
	if _, err := treeHash(snapMods); err != nil {
		return nil, err
	}
	if _, err := treeHash(h.ModsDir); err != nil {
		return nil, err
	}
	stateData, err := historyReadFile(filepath.Join(snapDir, StateFileName))
	if errors.Is(err, os.ErrNotExist) {
		stateData = []byte("{\"enabled\": []}\n")
	} else if err != nil {
		return nil, err
	}
	oldState, err := historyReadFile(h.StateFile)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	markerPath := filepath.Join(h.Dir, historyRestoringMarker)
	if err := historyOptionalRegular(markerPath); err != nil {
		return nil, err
	}
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
	// Stage every replacement before the first deletion, including the enabled state. Random names are owned;
	// predictable .restore-<id> and mods.json.tmp paths may belong to somebody else.
	staged := make(map[string]string)
	for id := range wanted {
		same, err := treesEqual(filepath.Join(snapMods, id), filepath.Join(h.ModsDir, id))
		if err != nil {
			return nil, err
		}
		if same {
			continue
		}
		tmp, err := os.MkdirTemp(h.ModsDir, ".restore-")
		if err != nil {
			return nil, err
		}
		defer os.RemoveAll(tmp)
		err = copyModsTree(filepath.Join(snapMods, id), tmp)
		if err != nil {
			return nil, err
		}
		staged[id] = tmp
	}
	err = os.MkdirAll(filepath.Dir(h.StateFile), 0755)
	if err != nil {
		return nil, err
	}
	tmpState, err := historyStageFile(filepath.Dir(h.StateFile), ".mods-state-", stateData)
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmpState)
	tmpMarker, err := historyStageFile(h.Dir, ".restoring-", []byte(strconv.Itoa(seq)))
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmpMarker)
	if err = os.Rename(tmpMarker, markerPath); err != nil {
		return nil, err
	}
	restored := false
	defer func() {
		if !restored {
			os.Remove(markerPath)
		}
	}()
	changed := []string{}
	for id := range current {
		if wanted[id] {
			continue
		}
		if err := os.RemoveAll(filepath.Join(h.ModsDir, id)); err != nil {
			return nil, err
		}
		changed = append(changed, id)
	}
	for id, tmp := range staged {
		dest := filepath.Join(h.ModsDir, id)
		if err := os.RemoveAll(dest); err != nil {
			return nil, err
		}
		if err := os.Rename(tmp, dest); err != nil {
			return nil, err
		}
		changed = append(changed, id)
	}
	changed = append(changed, stateDiff(oldState, stateData)...)
	err = os.Rename(tmpState, h.StateFile)
	if err != nil {
		return nil, err
	}
	restored = true // Undo keeps the marker until its own history record has completed.
	return uniqueSorted(changed), nil
}

// The mods whose enabled or disabled state differs between two contents of mods.json.
func stateDiff(oldData []byte, newData []byte) []string {
	marks := func(data []byte) map[string]string {
		var state stateFileContent
		json.Unmarshal(data, &state)
		rtn := make(map[string]string)
		for _, id := range state.Enabled {
			rtn[id] += "e"
		}
		for _, id := range state.Disabled {
			rtn[id] += "d"
		}
		return rtn
	}
	return diffSnapshots(marks(oldData), marks(newData))
}

func uniqueSorted(ids []string) []string {
	seen := make(map[string]bool)
	rtn := []string{}
	for _, id := range ids {
		if !seen[id] {
			seen[id] = true
			rtn = append(rtn, id)
		}
	}
	sort.Strings(rtn)
	return rtn
}

func modFolders(dir string) (map[string]bool, error) {
	if err := historyManagedDirectory(dir); err != nil {
		return nil, err
	}
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

// The files of a mods tree that count, as for the watcher: hidden entries and editor droppings are skipped, except a
// Claude Code part's `.claude-plugin/` (FR-MORPH-010), whose typings are skipped in turn.
func walkModsTree(root string, fn func(rel string, path string) error) error {
	if err := historyManagedDirectory(root); err != nil {
		return err
	}
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
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if agentparts.IgnoredModRelPath(rel) {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("history only supports regular files and directories: %s", path)
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
	in, err := historyOpenRegular(src)
	if err != nil {
		return err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	// Apply the exact ordinary permissions after copying: creation permissions alone are masked by umask.
	out, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, in)
	if err == nil {
		err = out.Chmod(info.Mode().Perm())
	}
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
		if err := historyOptionalRegular(extra); err != nil {
			return "", err
		}
		if _, err := os.Lstat(extra); err == nil {
			files["\x00"+filepath.Base(extra)] = extra
		} else if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
	}
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		// mods.json is restored as state data, not as a permission-preserving mod file.
		if !strings.HasPrefix(name, "\x00") {
			info, err := os.Lstat(files[name])
			if err != nil {
				return "", err
			}
			fmt.Fprintf(hasher, "%03o\x00", info.Mode().Perm())
		}
		data, err := historyReadFile(files[name])
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
	if _, err := os.Lstat(b); errors.Is(err, os.ErrNotExist) {
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

// Check managed roots and their immediate parents, while allowing platform aliases above them (/var, /tmp).
// These static checks and descriptor identity checks do not lock out concurrent ancestor-directory replacement.
func historyDirectory(path string, optional bool) error {
	info, err := os.Lstat(path)
	if optional && errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("history requires a real directory: %s", path)
	}
	return nil
}

func historyManagedDirectory(path string) error {
	if err := historyDirectory(filepath.Dir(path), true); err != nil {
		return err
	}
	return historyDirectory(path, true)
}

func historyOptionalRegular(path string) error {
	if err := historyManagedDirectory(filepath.Dir(path)); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("history requires a regular file: %s", path)
	}
	return nil
}

func historyOpenRegular(path string) (*os.File, error) {
	if err := historyOptionalRegular(path); err != nil {
		return nil, err
	}
	before, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	file, err := historyOpenNoBlock(path)
	if err != nil {
		return nil, err
	}
	after, err := file.Stat()
	if err != nil || !after.Mode().IsRegular() || !os.SameFile(before, after) {
		file.Close()
		if err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("history file changed type or identity while opening: %s", path)
	}
	return file, nil
}

func historyReadFile(path string) ([]byte, error) {
	file, err := historyOpenRegular(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return io.ReadAll(file)
}

func historyStageFile(dir string, prefix string, data []byte) (string, error) {
	file, err := os.CreateTemp(dir, prefix)
	if err != nil {
		return "", err
	}
	name := file.Name()
	_, err = file.Write(data)
	if err == nil {
		err = file.Chmod(0644)
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		os.Remove(name)
		return "", err
	}
	return name, nil
}
