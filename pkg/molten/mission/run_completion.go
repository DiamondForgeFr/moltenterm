// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

const completionFileName = "completion"

// The supervisor owns the control file; the command runs in a separate shell so its exit, exec, traps and
// stdout cannot replace the supervisor or supply its result. Atomic publication survives a wavesrv restart.
// Cancellation can arrive before the child exists: remember it, then signal the whole isolated group once the
// child has been assigned. Ignoring the forwarded signal in the supervisor prevents a recursive trap.
// The child resets its inherited traps and checks cancellation before exec, closing the fork/exec signal window.
const runSupervisor = `trap '' HUP
interrupted=0
cancelled=0
child=
cancel_run() {
    interrupted=1
    cancelled=1
    if [ -n "$child" ]; then
        trap '' TERM INT
        kill -TERM 0
    fi
}
trap cancel_run TERM INT
(
    trap - TERM INT
    [ "$cancelled" = 0 ] || exit 143
    exec /bin/sh -c "$1"
) &
child=$!
[ "$cancelled" = 0 ] || cancel_run
while :; do
    interrupted=0
    wait "$child"
    code=$?
    [ "$interrupted" = 0 ] && break
done
umask 077
printf '1 %s\n' "$code" > "$2.tmp" && /bin/mv -f "$2.tmp" "$2"
`

func (r *Runs) completionFile(rec RunRecord) string {
	return filepath.Join(r.projectDir(rec.Dir), rec.Id, completionFileName)
}

func (r *Runs) supervisedCommand(rec RunRecord) *exec.Cmd {
	return exec.Command("/bin/sh", "-c", runSupervisor, "molten-run", rec.Command, r.completionFile(rec))
}

func (r *Runs) completion(rec RunRecord) (int, bool) {
	data, err := os.ReadFile(r.completionFile(rec))
	if err != nil || len(data) > 16 {
		return 0, false
	}
	fields := strings.Fields(string(data))
	if len(fields) != 2 || fields[0] != "1" {
		return 0, false
	}
	code, err := strconv.Atoi(fields[1])
	return code, err == nil && code >= 0 && code <= 255
}

func (r *Runs) complete(rec *RunRecord, code int) {
	rec.Exit = &code
	rec.FinishedAt = r.now().UnixMilli()
	switch {
	case rec.Cancelled:
		rec.State = RunStateCancelled
	case code == 0:
		rec.State = RunStateSuccess
	default:
		rec.State = RunStateFailure
	}
}

// Serialize each lifecycle transaction, including cancellation, without holding the watcher-map lock or
// invoking subscribers under this lock. Otherwise a stale poll can overwrite a cancellation request.
func (r *Runs) recordLock(dir, id string) *sync.Mutex {
	key := filepath.Join(r.projectDir(dir), id)
	lock, _ := r.recordLocks.LoadOrStore(key, &sync.Mutex{})
	return lock.(*sync.Mutex)
}

func (r *Runs) refreshRecord(dir, id string) (RunRecord, bool, error) {
	lock := r.recordLock(dir, id)
	lock.Lock()
	defer lock.Unlock()
	// The record on disk is the reference: a build's preparation fills in its commit and process first.
	rec, err := r.readRecord(dir, id)
	if err != nil || rec.State != RunStateRunning {
		return rec, false, err
	}
	if rec.Preparing && r.checkPreparing(rec.Id) {
		// Its preparation alone writes the record until the build command starts.
		return rec, false, nil
	}
	changed := false
	if rec.Preparing {
		// wavesrv stopped while it fetched, verified or prepared the build.
		rec.Preparing = false
		rec.State = RunStateLost
		rec.FinishedAt = r.now().UnixMilli()
		changed = true
	} else {
		changed = r.update(&rec)
	}
	if changed {
		r.settle(&rec)
		err = r.writeRecord(rec)
	}
	return rec, changed, err
}
