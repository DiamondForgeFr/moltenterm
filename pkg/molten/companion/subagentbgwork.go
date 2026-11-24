// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"bytes"
	"encoding/json"
	"os"
	"regexp"
	"sort"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// A Claude Code sub-agent waiting on its own background work (#2498). Claude Code marks its meta file finished as any
// of its turns ends, also one that ends while a command it ran in the background or a monitor it armed still runs: the
// parent is told the agent "is waiting on its own background work", and the agent resumes when that work reports. The
// parent's transcript is not at hand for every reader (Integration, the activity gauge), the agent's own is: each
// background task it started gives its id in the tool's result, and its end comes back as a notification naming it.
// A task started and not yet ended is work pending. Only the end of the transcript is read, and only for an agent
// whose meta says finished.
//
// #2502: the pending tasks are also the sub-agent's jobs, named in plain words (bgjobs.go) with when they started, for
// the popover, the sidebar and the companion. The command that started a task is read from the call that launched it
// (its tool_use block, which carries the command and says it runs in the background) and kept only as the job's kind.

const (
	// The end of a finished sub-agent's transcript read for its pending background work: its last turn's launches.
	subagentBackgroundTail = 512 * 1024
	maxBackgroundCache     = 256
	// The tasks of one sub-agent that are named: a sub-agent that launched more waits on them all, and shows these.
	maxBackgroundJobs = 8
	maxPendingCommand = 64
)

var (
	// A Bash command run in the background, and a Monitor: their results name the task.
	backgroundLaunchRegex = regexp.MustCompile(`"backgroundTaskId":"([A-Za-z0-9_-]{1,64})"|"toolUseResult":\{"taskId":"([A-Za-z0-9_-]{1,64})"`)
	backgroundEndRegex    = regexp.MustCompile(`(?s)<task-id>([A-Za-z0-9_-]{1,64})</task-id>.*?<status>([a-z_]{1,40})</status>`)
	// A TaskStop of the agent's own task: {"message":"Successfully stopped task: …","task_id":"…"}.
	backgroundStopRegex = regexp.MustCompile(`"message":"Successfully stopped task[^"]*","task_id":"([A-Za-z0-9_-]{1,64})"`)
	toolUseIdRegex      = regexp.MustCompile(`"tool_use_id":"([^"]{1,200})"`)
	recordStampRegex    = regexp.MustCompile(`"timestamp":"([0-9T:.\-Z+]{10,40})"`)

	notificationMarker   = []byte("<task-notification>")
	launchMarkers        = [][]byte{[]byte(`"backgroundTaskId"`), []byte(`"toolUseResult":{"taskId"`)}
	stopMarker           = []byte("Successfully stopped task")
	backgroundCallMarker = []byte(`"run_in_background":true`)
	monitorCallMarker    = []byte(`"name":"Monitor"`)
)

// backgroundTask is a task a sub-agent started that has not reported its end: where its command came from, the kind
// it was named, and when its launch was recorded.
type backgroundTask struct {
	id  string
	job molten.BackgroundJob
}

// backgroundCallLine is the part of a record that holds a tool call: its blocks, with the command and the flag.
type backgroundCallLine struct {
	Message struct {
		Content []struct {
			Type  string `json:"type"`
			Id    string `json:"id"`
			Name  string `json:"name"`
			Input struct {
				Command    string `json:"command"`
				Background bool   `json:"run_in_background"`
			} `json:"input"`
		} `json:"content"`
	} `json:"message"`
}

// backgroundCommands reads the commands of the background calls of a record: tool call id → job kind and argument.
func backgroundCommands(line []byte, commands map[string]molten.BackgroundJob) {
	var rec backgroundCallLine
	if json.Unmarshal(line, &rec) != nil {
		return
	}
	for _, block := range rec.Message.Content {
		if block.Type != "tool_use" || block.Id == "" || (block.Name != "Monitor" && !block.Input.Background) {
			continue
		}
		kind, arg := classifyBackgroundCommand(block.Input.Command)
		if len(commands) >= maxPendingCommand {
			return
		}
		commands[block.Id] = molten.BackgroundJob{Kind: kind, Arg: arg}
	}
}

func recordStampMs(line []byte) int64 {
	m := recordStampRegex.FindSubmatch(line)
	if m == nil {
		return 0
	}
	at, err := time.Parse(time.RFC3339Nano, string(m[1]))
	if err != nil {
		return 0
	}
	return at.UnixMilli()
}

// claudeBackgroundTasks reads the end of a sub-agent's transcript for the background tasks it started and has not
// seen end, the oldest launch first.
func claudeBackgroundTasks(tail []byte) []backgroundTask {
	pending := map[string]backgroundTask{}
	order := []string{}
	commands := map[string]molten.BackgroundJob{}
	for _, line := range splitLines(tail) {
		if bytes.Contains(line, notificationMarker) {
			for _, m := range backgroundEndRegex.FindAllSubmatch(line, -1) {
				if string(m[2]) != "running" {
					delete(pending, string(m[1]))
				}
			}
			continue
		}
		if bytes.Contains(line, backgroundCallMarker) || bytes.Contains(line, monitorCallMarker) {
			backgroundCommands(line, commands)
		}
		if bytes.Contains(line, stopMarker) {
			for _, m := range backgroundStopRegex.FindAllSubmatch(line, -1) {
				delete(pending, string(m[1]))
			}
		}
		if !bytes.Contains(line, launchMarkers[0]) && !bytes.Contains(line, launchMarkers[1]) {
			continue
		}
		for _, m := range backgroundLaunchRegex.FindAllSubmatch(line, -1) {
			id := m[1]
			if len(id) == 0 {
				id = m[2]
			}
			job := molten.BackgroundJob{Kind: molten.JobCommand}
			if call := toolUseIdRegex.FindSubmatch(line); call != nil {
				if known, ok := commands[string(call[1])]; ok {
					job = known
				}
			}
			job.Since = recordStampMs(line)
			if _, seen := pending[string(id)]; !seen {
				order = append(order, string(id))
			}
			pending[string(id)] = backgroundTask{id: string(id), job: job}
		}
	}
	rtn := make([]backgroundTask, 0, len(pending))
	for _, id := range order {
		if task, ok := pending[id]; ok {
			rtn = append(rtn, task)
			delete(pending, id)
		}
	}
	sort.SliceStable(rtn, func(i, j int) bool {
		a, b := rtn[i].job.Since, rtn[j].job.Since
		return a != 0 && (b == 0 || a < b)
	})
	return rtn
}

// claudeBackgroundPending tells whether the end of a sub-agent's transcript started background work that has not
// reported its end.
func claudeBackgroundPending(tail []byte) bool {
	return len(claudeBackgroundTasks(tail)) > 0
}

type backgroundCacheEntry struct {
	size int64
	mod  int64
	jobs []molten.BackgroundJob
}

var backgroundTails = struct {
	lock    sync.Mutex
	entries map[string]backgroundCacheEntry
}{entries: map[string]backgroundCacheEntry{}}

// claudeBackgroundJobs reads, at most once per version of the file, the background jobs a sub-agent's transcript has
// pending, the oldest first. The slice is shared: callers copy what they keep.
func claudeBackgroundJobs(path string, info os.FileInfo) []molten.BackgroundJob {
	backgroundTails.lock.Lock()
	entry, ok := backgroundTails.entries[path]
	backgroundTails.lock.Unlock()
	if ok && entry.size == info.Size() && entry.mod == info.ModTime().UnixNano() {
		return entry.jobs
	}
	tail, err := readFileTail(path, subagentBackgroundTail)
	if err != nil {
		return nil
	}
	var jobs []molten.BackgroundJob
	for _, task := range claudeBackgroundTasks(tail) {
		if len(jobs) >= maxBackgroundJobs {
			break
		}
		jobs = append(jobs, task.job)
	}
	backgroundTails.lock.Lock()
	defer backgroundTails.lock.Unlock()
	if len(backgroundTails.entries) >= maxBackgroundCache {
		backgroundTails.entries = map[string]backgroundCacheEntry{}
	}
	backgroundTails.entries[path] = backgroundCacheEntry{size: info.Size(), mod: info.ModTime().UnixNano(), jobs: jobs}
	return jobs
}

// claudeWaitsOnBackground reads, at most once per version of the file, whether a sub-agent's transcript has background
// work pending.
func claudeWaitsOnBackground(path string, info os.FileInfo) bool {
	return len(claudeBackgroundJobs(path, info)) > 0
}
