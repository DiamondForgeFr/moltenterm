// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	goproc "github.com/shirou/gopsutil/v4/process"
	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten/agentlaunch"
	"github.com/wavetermdev/waveterm/pkg/molten/keepawake"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// The inhibitor shims (FR-SHELL-023, DS-SHELL-024). In a local MoltenTerm terminal, `caffeinate` (macOS) and
// `systemd-inhibit` (Linux) are wsh under those names, in the agent launchers' folder: the shim asks wavesrv for the
// session's policy and reports the attempt. Let it sleep: no block; a wrapped command runs alone, a bare caffeinate
// waits for its -t timeout, its -w process or a signal. Otherwise, or when wavesrv does not answer in time, the real
// tool runs with the same arguments (fail open: the shim never breaks its caller).

// The whole exchange with wavesrv, connection included (DS-SHELL-024).
const moltenSleepShimTimeout = 500 * time.Millisecond

const moltenSleepShimPidPoll = time.Second

var moltenSleepShimCmd = &cobra.Command{
	Use:                "sleepshim --tool <caffeinate|systemd-inhibit> -- [args...]",
	Short:              "what caffeinate and systemd-inhibit run in a MoltenTerm terminal (sleep policy)",
	Hidden:             true,
	DisableFlagParsing: true,
	RunE:               moltenSleepShimRun,
}

func init() {
	moltenCmd.AddCommand(moltenSleepShimCmd)
}

// moltenSleepShimArgs is the wsh command line a shim runs, or nil when the program is no shim. The shims exist where
// the tool does: caffeinate on macOS, systemd-inhibit on Linux.
func moltenSleepShimArgs(args []string, base string) []string {
	if (base != keepawake.ToolCaffeinate || runtime.GOOS != "darwin") && (base != keepawake.ToolSystemdInhibit || runtime.GOOS != "linux") {
		return nil
	}
	rtn := []string{args[0], MoltenProgramName, "sleepshim", "--tool", base, "--"}
	return append(rtn, args[1:]...)
}

func moltenSleepShimRun(cmd *cobra.Command, args []string) error {
	if len(args) < 3 || args[0] != "--tool" || args[2] != "--" || !keepawake.IsShimTool(args[1]) {
		WriteStderr("usage: molten sleepshim --tool <caffeinate|systemd-inhibit> -- [args...]\n")
		WshExitCode = 2
		return nil
	}
	WshExitCode = runMoltenSleepShim(args[1], args[3:], os.Getenv)
	return nil
}

func runMoltenSleepShim(tool string, args []string, getenv func(string) string) int {
	real, found := agentlaunch.FindRealBinary(tool, getenv("PATH"), getenv(agentlaunch.AgentBinDirVarName), agentlaunch.IsLauncher)
	policy := askMoltenSleepPolicy(tool, args, getenv)
	if policy == keepawake.PolicyLetSleep {
		if code, handled := neutraliseSleepTool(tool, args); handled {
			return code
		}
	}
	if !found {
		WriteStderr("%s: command not found (MoltenTerm sleep shim)\n", tool)
		return moltenAgentLaunchMissingCode
	}
	return execAgentBinary(real, args, os.Environ())
}

// askMoltenSleepPolicy asks wavesrv within the shim's time cap; any failure lets the real tool run.
func askMoltenSleepPolicy(tool string, args []string, getenv func(string) string) string {
	jwt := getenv(wshutil.WaveJwtTokenVarName)
	if jwt == "" {
		return keepawake.PolicyAllow
	}
	deadline := time.Now().Add(moltenSleepShimTimeout)
	connected := moltenLaunchConnect(jwt)
	select {
	case ok := <-connected:
		if !ok {
			return keepawake.PolicyAllow
		}
	case <-time.After(time.Until(deadline)):
		return keepawake.PolicyAllow
	}
	left := time.Until(deadline)
	if left <= 0 {
		return keepawake.PolicyAllow
	}
	req := keepawake.ShimRequest{
		BlockId:   getenv("WAVETERM_BLOCKID"),
		Tool:      tool,
		Args:      args,
		Pid:       int32(os.Getpid()),
		ParentPid: int32(os.Getppid()),
	}
	if RpcContext.BlockId != "" {
		req.BlockId = RpcContext.BlockId
	}
	done := make(chan string, 1)
	go func() {
		opts := &wshrpc.RpcOpts{Route: keepawake.Route, Timeout: max(int64(left/time.Millisecond), 1)}
		out, err := RpcClient.SendRpcRequest(keepawake.ShimCommand, req, opts)
		var answer keepawake.ShimAnswer
		if err != nil || utilfn.ReUnmarshal(&answer, out) != nil {
			done <- keepawake.PolicyAllow
			return
		}
		done <- answer.Policy
	}()
	select {
	case policy := <-done:
		return policy
	case <-time.After(left):
		return keepawake.PolicyAllow
	}
}

// neutraliseSleepTool does what the caller expects without the block. handled is false when the real tool must answer
// (a listing, help, an option it does not know).
func neutraliseSleepTool(tool string, args []string) (int, bool) {
	if tool == keepawake.ToolSystemdInhibit {
		call := keepawake.ParseInhibit(args)
		if call.Passthrough {
			return 0, false
		}
		return execWrappedCommand(call.Command), true
	}
	call := keepawake.ParseCaffeinate(args)
	if call.Invalid {
		return 0, false
	}
	if len(call.Command) > 0 {
		return execWrappedCommand(call.Command), true
	}
	return waitLikeCaffeinate(call), true
}

func execWrappedCommand(command []string) int {
	path, err := exec.LookPath(command[0])
	if err != nil {
		WriteStderr("%s: %v\n", command[0], err)
		return moltenAgentLaunchMissingCode
	}
	return execAgentBinary(path, command[1:], os.Environ())
}

// waitLikeCaffeinate stays alive as a bare caffeinate would: until its timeout, the end of the process it waits for,
// or a signal; with neither a timeout nor a process, until a signal.
func waitLikeCaffeinate(call keepawake.CaffeinateCall) int {
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	var timeout <-chan time.Time
	if call.Timeout > 0 {
		timeout = time.After(call.Timeout)
	}
	var poll <-chan time.Time
	if call.WaitPid > 0 {
		ticker := time.NewTicker(moltenSleepShimPidPoll)
		defer ticker.Stop()
		poll = ticker.C
	}
	for {
		select {
		case sig := <-signals:
			if s, ok := sig.(syscall.Signal); ok {
				return 128 + int(s)
			}
			return 1
		case <-timeout:
			return 0
		case <-poll:
			if alive, err := goproc.PidExists(int32(call.WaitPid)); err == nil && !alive {
				return 0
			}
		}
	}
}
