// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build unix

package stdinwatch

import (
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

// ParentWatcher returns a check that the parent this process has now still runs. A process whose parent exits is
// given to init (or a subreaper), so its parent pid changes; the pid of a gone parent is never read as alive.
func ParentWatcher() func() bool {
	start := os.Getppid()
	return func() bool {
		ppid := os.Getppid()
		return ppid == start && ppid > 1
	}
}

// Fd0State describes descriptor 0: closed, or the kind of file now holding it.
func Fd0State() string {
	var st unix.Stat_t
	if err := unix.Fstat(0, &st); err != nil {
		return fmt.Sprintf("not open (%v)", err)
	}
	flags, err := unix.FcntlInt(0, unix.F_GETFL, 0)
	if err != nil {
		return fmt.Sprintf("open, mode %#o, flags unreadable (%v)", st.Mode, err)
	}
	return fmt.Sprintf("open, mode %#o, flags %#x", st.Mode, flags)
}
