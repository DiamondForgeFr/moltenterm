// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package mission

import (
	"os/exec"
	"syscall"
)

// A run gets its own session: it outlives a MoltenTerm restart, and cancelling stops its whole process group.
func detachRun(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	return syscall.Kill(pid, 0) == nil
}

func stopRunGroup(pid int) error {
	// kill(-0) would signal wavesrv's own process group.
	if pid <= 0 {
		return nil
	}
	return syscall.Kill(-pid, syscall.SIGTERM)
}

// killRunGroup is for a group that did not stop on SIGTERM.
func killRunGroup(pid int) error {
	if pid <= 0 {
		return nil
	}
	return syscall.Kill(-pid, syscall.SIGKILL)
}
