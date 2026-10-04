// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package blockcontroller

import (
	"context"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/remote/conncontroller"
	"github.com/wavetermdev/waveterm/pkg/shellexec"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// Agent states from the process tree (FR-SHELL-011, #141): the agent states find each local terminal's process here,
// so they can look at what runs in its foreground. A durable terminal's shell is its job's command (#72), known from
// the store even before the window reattaches it after a restart; another local terminal's is its controller's
// process. Remote and WSL terminals have no local process.

const agentShellReadTimeout = 2 * time.Second

func init() {
	attention.SetShellLocator(attention.ShellLocator{Locate: locateAgentShell, List: listAgentShells})
}

func jobShellProcess(job *waveobj.Job) (attention.ShellProcess, bool) {
	if job == nil || job.AttachedBlockId == "" || job.CmdPid <= 0 || job.CmdExitTs > 0 {
		return attention.ShellProcess{}, false
	}
	if !conncontroller.IsLocalConnName(job.Connection) {
		return attention.ShellProcess{}, false
	}
	return attention.ShellProcess{BlockId: job.AttachedBlockId, Pid: int32(job.CmdPid), StartMs: job.CmdStartTs}, true
}

func localShellProcess(sc *ShellController) (attention.ShellProcess, bool) {
	sc.Lock.Lock()
	defer sc.Lock.Unlock()
	if sc.ShellProc == nil || sc.ProcStatus != Status_Running || !conncontroller.IsLocalConnName(sc.ConnName) {
		return attention.ShellProcess{}, false
	}
	// Only a local exec.Cmd has a local pid (an SSH session or a WSL command has none here).
	cw, ok := sc.ShellProc.Cmd.(shellexec.CmdWrap)
	if !ok || cw.Cmd == nil || cw.Cmd.Process == nil {
		return attention.ShellProcess{}, false
	}
	return attention.ShellProcess{BlockId: sc.BlockId, Pid: int32(cw.Cmd.Process.Pid), Command: sc.ControllerType == BlockController_Cmd}, true
}

func locateAgentShell(blockId string) (attention.ShellProcess, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), agentShellReadTimeout)
	defer cancel()
	jobId := ""
	switch c := getController(blockId).(type) {
	case *ShellController:
		return localShellProcess(c)
	case *DurableShellController:
		jobId = c.getJobId()
	}
	if jobId == "" {
		block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
		if err != nil || block == nil {
			return attention.ShellProcess{}, false
		}
		jobId = block.JobId
	}
	if jobId == "" {
		return attention.ShellProcess{}, false
	}
	job, err := wstore.DBGet[*waveobj.Job](ctx, jobId)
	if err != nil {
		return attention.ShellProcess{}, false
	}
	shell, ok := jobShellProcess(job)
	if !ok || shell.BlockId != blockId {
		return attention.ShellProcess{}, false
	}
	return shell, true
}

// listAgentShells lists the live local durable terminals, at startup: their shells survived the restart.
func listAgentShells() []attention.ShellProcess {
	ctx, cancel := context.WithTimeout(context.Background(), agentShellReadTimeout)
	defer cancel()
	jobs, err := wstore.DBGetAllObjsByType[*waveobj.Job](ctx, waveobj.OType_Job)
	if err != nil {
		return nil
	}
	var rtn []attention.ShellProcess
	for _, job := range jobs {
		shell, ok := jobShellProcess(job)
		if !ok {
			continue
		}
		// A job whose block was closed, or that its block no longer uses, is no terminal.
		block, err := wstore.DBGet[*waveobj.Block](ctx, shell.BlockId)
		if err != nil || block == nil || block.JobId != job.OID {
			continue
		}
		rtn = append(rtn, shell)
	}
	return rtn
}
