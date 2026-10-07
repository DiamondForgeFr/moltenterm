// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build windows

package agentcontinuity

import "os/exec"

func setProbeProcessGroup(cmd *exec.Cmd) {}

func killProbeProcessGroup(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	cmd.Process.Kill()
}
