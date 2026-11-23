// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"bytes"
	"os"
	"regexp"
	"sync"
)

// A Claude Code sub-agent waiting on its own background work (#2498). Claude Code marks its meta file finished as any
// of its turns ends, also one that ends while a command it ran in the background or a monitor it armed still runs: the
// parent is told the agent "is waiting on its own background work", and the agent resumes when that work reports. The
// parent's transcript is not at hand for every reader (Integration, the activity gauge), the agent's own is: each
// background task it started gives its id in the tool's result, and its end comes back as a notification naming it.
// A task started and not yet ended is work pending. Only the end of the transcript is read, and only for an agent
// whose meta says finished.

const (
	// The end of a finished sub-agent's transcript read for its pending background work: its last turn's launches.
	subagentBackgroundTail = 512 * 1024
	maxBackgroundCache     = 256
)

var (
	// A Bash command run in the background, and a Monitor: their results name the task.
	backgroundLaunchRegex = regexp.MustCompile(`"backgroundTaskId":"([A-Za-z0-9_-]{1,64})"|"toolUseResult":\{"taskId":"([A-Za-z0-9_-]{1,64})"`)
	backgroundEndRegex    = regexp.MustCompile(`(?s)<task-id>([A-Za-z0-9_-]{1,64})</task-id>.*?<status>([a-z_]{1,40})</status>`)
	// A TaskStop of the agent's own task: {"message":"Successfully stopped task: …","task_id":"…"}.
	backgroundStopRegex = regexp.MustCompile(`"message":"Successfully stopped task[^"]*","task_id":"([A-Za-z0-9_-]{1,64})"`)
)

// claudeBackgroundPending tells whether the end of a sub-agent's transcript started background work that has not
// reported its end.
func claudeBackgroundPending(tail []byte) bool {
	pending := map[string]bool{}
	for _, line := range splitLines(tail) {
		if bytes.Contains(line, []byte("<task-notification>")) {
			for _, m := range backgroundEndRegex.FindAllSubmatch(line, -1) {
				if string(m[2]) != "running" {
					delete(pending, string(m[1]))
				}
			}
			continue
		}
		for _, m := range backgroundStopRegex.FindAllSubmatch(line, -1) {
			delete(pending, string(m[1]))
		}
		for _, m := range backgroundLaunchRegex.FindAllSubmatch(line, -1) {
			id := m[1]
			if len(id) == 0 {
				id = m[2]
			}
			pending[string(id)] = true
		}
	}
	return len(pending) > 0
}

type backgroundCacheEntry struct {
	size    int64
	mod     int64
	pending bool
}

var backgroundTails = struct {
	lock    sync.Mutex
	entries map[string]backgroundCacheEntry
}{entries: map[string]backgroundCacheEntry{}}

// claudeWaitsOnBackground reads, at most once per version of the file, whether a sub-agent's transcript has background
// work pending.
func claudeWaitsOnBackground(path string, info os.FileInfo) bool {
	backgroundTails.lock.Lock()
	entry, ok := backgroundTails.entries[path]
	backgroundTails.lock.Unlock()
	if ok && entry.size == info.Size() && entry.mod == info.ModTime().UnixNano() {
		return entry.pending
	}
	tail, err := readFileTail(path, subagentBackgroundTail)
	if err != nil {
		return false
	}
	pending := claudeBackgroundPending(tail)
	backgroundTails.lock.Lock()
	defer backgroundTails.lock.Unlock()
	if len(backgroundTails.entries) >= maxBackgroundCache {
		backgroundTails.entries = map[string]backgroundCacheEntry{}
	}
	backgroundTails.entries[path] = backgroundCacheEntry{size: info.Size(), mod: info.ModTime().UnixNano(), pending: pending}
	return pending
}
