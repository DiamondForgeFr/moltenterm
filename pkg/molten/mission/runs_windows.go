// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

//go:build windows

package mission

import (
	"os"
	"os/exec"
)

func detachRun(cmd *exec.Cmd) {}

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	_, err := os.FindProcess(pid)
	return err == nil
}

func stopRunGroup(pid int) error {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return proc.Kill()
}

func killRunGroup(pid int) error {
	return stopRunGroup(pid)
}
