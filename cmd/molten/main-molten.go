// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

// The molten command of local terminals on macOS and Linux (FR-PERF-012, DS-PERF-011). Coding agents' hooks run
// `molten agent state`, `molten agent hook` and `molten agent statusline` up to once a second; this small program runs those itself
// (pkg/molten/agenthook) and replaces itself with wsh, next to it, for every other molten command, which wsh runs as
// before (it reads its name, molten, from the first argument). Windows and remote hosts keep molten as wsh.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"

	"github.com/wavetermdev/waveterm/pkg/molten/agenthook"
)

func main() {
	env := agenthook.Env{Getenv: os.Getenv, Stdin: os.Stdin, Stdout: os.Stdout, Stderr: os.Stderr}
	if len(os.Args) > 2 && os.Args[1] == "agent" && os.Args[2] == "statusline" {
		env.CacheDir = agenthook.StatusLineCacheDir()
	}
	if handled, code := agenthook.RunFast(os.Args[1:], env); handled {
		os.Exit(code)
	}
	execWsh()
}

func execWsh() {
	self, err := os.Executable()
	if err != nil {
		fmt.Fprintf(os.Stderr, "molten: cannot find wsh: %v\n", err)
		os.Exit(127)
	}
	wsh := filepath.Join(filepath.Dir(self), "wsh")
	err = syscall.Exec(wsh, os.Args, os.Environ())
	fmt.Fprintf(os.Stderr, "molten: cannot run %s: %v\n", wsh, err)
	os.Exit(127)
}
