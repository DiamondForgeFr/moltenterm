// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wshremote

import (
	"context"
	"strconv"

	goproc "github.com/shirou/gopsutil/v4/process"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/util/procinfo"
)

// The Processes view names coding agents by agent (FR-SHELL-011): see molten.AgentProcessCommand.
func moltenAgentProcessCommand(ctx context.Context, pi *procinfo.ProcInfo) string {
	key := strconv.Itoa(int(pi.Pid)) + "/" + strconv.Itoa(int(pi.Ppid))
	return molten.AgentProcessCommand(key, pi.Command, func() (string, []string) {
		proc := &goproc.Process{Pid: pi.Pid}
		exe, _ := proc.ExeWithContext(ctx)
		args, _ := proc.CmdlineSliceWithContext(ctx)
		return exe, args
	})
}
