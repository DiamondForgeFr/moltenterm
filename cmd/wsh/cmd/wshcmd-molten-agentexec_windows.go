// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build windows

package cmd

import (
	"errors"
	"os"
	"os/exec"
	"os/signal"
)

// Windows has no exec: the launcher runs the agent as its child on the same console and handles, lets Ctrl+C reach
// it (the console sends it to both), and returns its exit code (DS-SHELL-045).
const execKeepsPid = false

func execAgentBinary(real string, args []string, env []string) int {
	c := exec.Command(real, args...)
	c.Stdin, c.Stdout, c.Stderr, c.Env = os.Stdin, os.Stdout, os.Stderr, env
	signal.Ignore(os.Interrupt)
	if err := c.Run(); err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return ee.ExitCode()
		}
		WriteStderr("%s: %v\n", real, err)
		return 126
	}
	return 0
}
