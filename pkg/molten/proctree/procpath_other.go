// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build !darwin

package proctree

import (
	"context"
	"time"

	goproc "github.com/shirou/gopsutil/v4/process"
)

// Linux reads /proc and Windows calls the system through x/sys/windows: neither hands a stack buffer to C the way
// gopsutil does on macOS (procpath_darwin.go).
const procReadTimeout = 2 * time.Second

// Exe is the path of a process's executable, or "" when it cannot be read.
func Exe(pid int32) string {
	if pid <= 0 {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), procReadTimeout)
	defer cancel()
	exe, err := (&goproc.Process{Pid: pid}).ExeWithContext(ctx)
	if err != nil {
		return ""
	}
	return exe
}

// Cwd is a process's current folder, or "" when it cannot be read.
func Cwd(pid int32) string {
	if pid <= 0 {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), procReadTimeout)
	defer cancel()
	cwd, err := (&goproc.Process{Pid: pid}).CwdWithContext(ctx)
	if err != nil {
		return ""
	}
	return cwd
}
