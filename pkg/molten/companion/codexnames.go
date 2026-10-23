// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Codex names its threads in <home>/session_index.jsonl, next to the sessions folder: one {id, thread_name,
// updated_at} line per naming, appended (a generated title, then each /rename), so a thread's latest line is its name
// (#991). The file is only read, and only its end.

const (
	codexSessionIndex = "session_index.jsonl"
	// The end of the index read: thousands of namings; a thread named only before it keeps its first prompt as title.
	codexIndexTail = 1024 * 1024
)

var codexThreadNameMarker = []byte(`"thread_name"`)

// codexNameIndex is what one index file said, kept while its size and modification time stay the same.
type codexNameIndex struct {
	size  int64
	mod   time.Time
	names map[string]string
}

// SessionName gives the name Codex keeps for a session's thread in the index of the home its rollout lives in.
func (a *CodexAdapter) SessionName(sessionPath string, id string) (string, bool) {
	if !codexThreadIdRegex.MatchString(id) {
		return "", false
	}
	index := a.indexOf(sessionPath)
	if index == "" {
		return "", false
	}
	names := a.indexNames(index)
	name, ok := names[strings.ToLower(id)]
	return name, ok && name != ""
}

// indexOf finds the index next to the sessions root that holds the rollout; a configured root not named sessions
// has none. The rollout's path is a resolved one (ValidateSessionPath): the root is tried resolved too.
func (a *CodexAdapter) indexOf(sessionPath string) string {
	for _, root := range a.roots {
		if filepath.Base(root) != "sessions" {
			continue
		}
		candidates := []string{root}
		if resolved, err := filepath.EvalSymlinks(root); err == nil && resolved != root {
			candidates = append(candidates, resolved)
		}
		for _, dir := range candidates {
			rel, err := filepath.Rel(dir, sessionPath)
			if err != nil || rel == "." || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
				continue
			}
			return filepath.Join(filepath.Dir(dir), codexSessionIndex)
		}
	}
	return ""
}

func (a *CodexAdapter) indexNames(index string) map[string]string {
	info, err := os.Stat(index)
	if err != nil || !info.Mode().IsRegular() {
		return nil
	}
	a.lock.Lock()
	cached := a.nameIndexes[index]
	a.lock.Unlock()
	if cached != nil && cached.size == info.Size() && cached.mod.Equal(info.ModTime()) {
		return cached.names
	}
	tail, err := readFileTail(index, codexIndexTail)
	if err != nil {
		return nil
	}
	read := &codexNameIndex{size: info.Size(), mod: info.ModTime(), names: parseCodexIndex(tail, info.Size() > codexIndexTail)}
	a.lock.Lock()
	defer a.lock.Unlock()
	if a.nameIndexes == nil {
		a.nameIndexes = map[string]*codexNameIndex{}
	}
	a.nameIndexes[index] = read
	return read.names
}

// parseCodexIndex maps each thread id (lower case) to its latest name; cut: the tail starts inside a line, skipped.
func parseCodexIndex(tail []byte, cut bool) map[string]string {
	names := map[string]string{}
	lines := bytes.Split(tail, []byte("\n"))
	if cut && len(lines) > 0 {
		lines = lines[1:]
	}
	for _, line := range lines {
		if !bytes.Contains(line, codexThreadNameMarker) {
			continue
		}
		var entry struct {
			Id         string `json:"id"`
			ThreadName string `json:"thread_name"`
		}
		if json.Unmarshal(line, &entry) != nil || !codexThreadIdRegex.MatchString(entry.Id) {
			continue
		}
		name := strings.TrimSpace(oneLine(entry.ThreadName))
		if name == "" {
			continue
		}
		names[strings.ToLower(entry.Id)] = cutRunes(name, maxSessionNameRunes)
	}
	return names
}
