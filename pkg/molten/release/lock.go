// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package release

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

const lockDirName = "molten-release"

// lock holds the release worktree until release is called: Mission Control and a terminal may both start a step, and
// two resets of one worktree would undo each other. A lock whose process is gone was left by an interrupted step and
// is taken over.
func (e *Env) lock(ctx context.Context, root string) (func(), error) {
	common, err := e.commonDir(ctx, root)
	if err != nil {
		return nil, err
	}
	dir := filepath.Join(common, lockDirName)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "release.lock")
	for attempt := 0; attempt < 2; attempt++ {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
		if err == nil {
			fmt.Fprintf(f, "%d\n", os.Getpid())
			f.Close()
			return func() { os.Remove(path) }, nil
		}
		if !os.IsExist(err) {
			return nil, err
		}
		if pid := lockOwner(path); pid > 0 && processAlive(pid) {
			return nil, fmt.Errorf("a release step is already running in the release worktree (pid %d)", pid)
		}
		os.Remove(path)
	}
	return nil, fmt.Errorf("could not take the release lock %s", path)
}

func lockOwner(path string) int {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		return 0
	}
	return pid
}

func processAlive(pid int) bool {
	if pid == os.Getpid() {
		return true
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return proc.Signal(syscall.Signal(0)) == nil
}
