// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package onboarding

import "syscall"

// The installer runs in a pseudo-terminal, as the leader of its own session and process group: killing the group
// stops what it started too (curl, bash, npm).
func killProcessGroup(pid int) error {
	return syscall.Kill(-pid, syscall.SIGKILL)
}
