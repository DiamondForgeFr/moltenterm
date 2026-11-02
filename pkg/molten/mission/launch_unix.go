// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package mission

import "syscall"

// processGroupOf tells which launch server a port's listener belongs to: each server leads a session of its own.
func processGroupOf(pid int) int {
	pgid, err := syscall.Getpgid(pid)
	if err != nil {
		return 0
	}
	return pgid
}

// A foreign port holder is stopped alone, never its group: it may share a group with the developer's shell.
func stopProcess(pid int) error {
	if pid <= 0 {
		return nil
	}
	return syscall.Kill(pid, syscall.SIGTERM)
}

func killProcess(pid int) error {
	if pid <= 0 {
		return nil
	}
	return syscall.Kill(pid, syscall.SIGKILL)
}
