// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wshremote

import (
	"context"
	"strconv"

	goproc "github.com/shirou/gopsutil/v4/process"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/proctree"
	"github.com/wavetermdev/waveterm/pkg/util/procinfo"
)

// The Processes view names coding agents by agent (FR-SHELL-011): see molten.AgentProcessCommand.
func moltenAgentProcessCommand(ctx context.Context, pi *procinfo.ProcInfo) string {
	key := strconv.Itoa(int(pi.Pid)) + "/" + strconv.Itoa(int(pi.Ppid))
	return molten.AgentProcessCommand(key, pi.Command, func() (string, []string) {
		// proctree, not gopsutil, for the executable: gopsutil hands libproc a stack buffer on macOS (#249).
		args, _ := (&goproc.Process{Pid: pi.Pid}).CmdlineSliceWithContext(ctx)
		return proctree.Exe(pi.Pid), args
	})
}
