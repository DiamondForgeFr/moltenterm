// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build windows

package agentcontinuity

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
)

func setProbeProcessGroup(cmd *exec.Cmd) {}

// killProbeProcessGroup kills the probe's whole tree: an npm agent is a .cmd shim whose node child would outlive
// cmd.exe.
func killProbeProcessGroup(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	if root := os.Getenv("SystemRoot"); root != "" {
		exec.Command(filepath.Join(root, "System32", "taskkill.exe"), "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid)).Run()
	}
	cmd.Process.Kill()
}

// endProbeLeftovers does nothing on Windows: the exited probe's id may already belong to another process.
func endProbeLeftovers(cmd *exec.Cmd) {}

func openNoBlock(path string) (*os.File, error) {
	return os.Open(path)
}
