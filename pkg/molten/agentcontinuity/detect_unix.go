// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package agentcontinuity

import (
	"os"
	"os/exec"
	"syscall"
)

func setProbeProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func killProbeProcessGroup(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
}

// endProbeLeftovers ends a background child a probe that exited left in its process group. The group's id cannot be
// reused while such a child lives, and is gone otherwise.
func endProbeLeftovers(cmd *exec.Cmd) {
	killProbeProcessGroup(cmd)
}

// openNoBlock opens a file for reading without blocking on a FIFO; reading a regular file is unaffected.
func openNoBlock(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK, 0)
}
