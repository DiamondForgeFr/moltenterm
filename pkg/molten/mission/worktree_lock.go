// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/proctree"
)

// A worktree lock whose holder ended (#1121, FR-REV-022 AC15). A tool that locks a linked worktree for an agent run
// writes who holds it in git's lock reason; Claude Code writes "claude agent agent-<id> (pid N start <ctime>)" and
// never unlocks it when its sub-agent ends without removing the worktree. The reason is read generically: any "pid N",
// with "start <ctime>" when given, so a pid the system gave to another process since does not read as the holder. A
// lock naming no pid is the developer's or an unknown tool's: it is never read as ended.

// lockStartLayout is the ctime form Claude Code writes ("Sun Oct 25 16:46:51 2026"), in local time.
const lockStartLayout = "Mon Jan _2 15:04:05 2006"

var lockPidRe = regexp.MustCompile(`\bpid (\d{1,10})(?: start ([A-Z][a-z]{2} [A-Z][a-z]{2} [ 0-9]\d \d\d:\d\d:\d\d \d{4}))?`)

// LockHolder is the process a lock reason names; StartMs 0 when the reason gives no start time.
type LockHolder struct {
	Pid     int32
	StartMs int64
}

// ParseLockReason reads the holder of a lock reason; false when it names no pid.
func ParseLockReason(reason string) (LockHolder, bool) {
	m := lockPidRe.FindStringSubmatch(reason)
	if m == nil {
		return LockHolder{}, false
	}
	pid, err := strconv.ParseInt(m[1], 10, 32)
	if err != nil || pid <= 0 {
		return LockHolder{}, false
	}
	holder := LockHolder{Pid: int32(pid)}
	if m[2] != "" {
		if at, err := time.ParseInLocation(lockStartLayout, m[2], time.Local); err == nil {
			holder.StartMs = at.UnixMilli()
		}
	}
	return holder, true
}

var lockCheck = struct {
	lock sync.Mutex
	runs func(pid int32, startMs int64) bool
}{runs: liveProcessRuns}

// liveProcessRuns reads the process table; a table that cannot be read says the holder runs.
func liveProcessRuns(pid int32, startMs int64) bool {
	table, err := proctree.Read()
	if err != nil {
		return true
	}
	return table.Same(pid, startMs)
}

// SetLockHolderCheck replaces how a lock's holder is found running (tests); the returned func restores it.
func SetLockHolderCheck(runs func(pid int32, startMs int64) bool) func() {
	lockCheck.lock.Lock()
	defer lockCheck.lock.Unlock()
	prev := lockCheck.runs
	lockCheck.runs = runs
	return func() {
		lockCheck.lock.Lock()
		defer lockCheck.lock.Unlock()
		lockCheck.runs = prev
	}
}

func holderRuns(holder LockHolder) bool {
	lockCheck.lock.Lock()
	runs := lockCheck.runs
	lockCheck.lock.Unlock()
	return runs(holder.Pid, holder.StartMs)
}

// LockEnded tells whether a lock reason names a process that no longer runs; the pid it names, 0 when none.
func LockEnded(reason string) (bool, int32) {
	holder, ok := ParseLockReason(reason)
	if !ok {
		return false, 0
	}
	return !holderRuns(holder), holder.Pid
}

// lockReasonOf is the lock reason `git worktree list --porcelain` gives for the worktree at path ("" when unlocked or
// locked without one).
func lockReasonOf(out string, path string) string {
	want := realPath(path)
	current := false
	for _, line := range strings.Split(out, "\n") {
		if entry, ok := strings.CutPrefix(line, "worktree "); ok {
			current = realPath(entry) == want
			continue
		}
		if reason, ok := strings.CutPrefix(line, "locked "); ok && current {
			return reason
		}
	}
	return ""
}
