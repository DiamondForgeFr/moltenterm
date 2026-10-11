// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package proctree

import "time"

// Cpu is a process's cumulative CPU time, user and system, since it started (#493: the keep-awake tells an agent's
// busy process tree from an idle one by how much of it was used between two reads).
type Cpu struct {
	// Self: the process's own threads, ended ones included.
	Self time.Duration
	// Children: the children it waited for, with what they had of their own children. A child's CPU moves here when
	// its parent reaps it, so work done by short-lived processes between two reads is not lost.
	Children time.Duration
}

func (c Cpu) Total() time.Duration {
	return c.Self + c.Children
}

// ReadCpu reads a process's cumulative CPU time; false when it cannot be read (an ended process, another user's, an
// unsupported platform).
func ReadCpu(pid int32) (Cpu, bool) {
	if pid <= 0 {
		return Cpu{}, false
	}
	return readCpu(pid)
}
