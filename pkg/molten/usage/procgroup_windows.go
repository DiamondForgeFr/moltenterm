// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

//go:build windows

package usage

import "os/exec"

func setProcessGroup(cmd *exec.Cmd) {}

func killProcessGroup(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	cmd.Process.Kill()
}
