// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package cmd

import (
	"syscall"
)

// The launcher replaces itself with the agent: the same process, so the terminal, the window size, job control
// (Ctrl+Z), signals and the exit code are the real binary's own (DS-SHELL-045).
const execKeepsPid = true

// execAgentBinary returns only when the exec failed. argv[0] is the real binary's path: the pane's agent detection
// then reads the agent from it even when the binary is named after its version (Claude Code's native installer).
func execAgentBinary(real string, args []string, env []string) int {
	argv := append([]string{real}, args...)
	err := syscall.Exec(real, argv, env)
	WriteStderr("%s: %v\n", real, err)
	return 126
}
