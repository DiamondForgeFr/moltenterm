// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package shellexec

import (
	"context"
	"fmt"
	"os"
	"strconv"

	"github.com/wavetermdev/waveterm/pkg/blocklogger"
	"github.com/wavetermdev/waveterm/pkg/jobcontroller"
	"github.com/wavetermdev/waveterm/pkg/molten/agentparts"
	"github.com/wavetermdev/waveterm/pkg/util/shellutil"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// Local terminals as durable jobs (#72): the shell runs under Wave's job manager (`wsh jobmanager`, its own session,
// holding the PTY) instead of being a child of wavesrv, so quitting or updating Moltenterm leaves it running and the
// panel reattaches at the next start. Wave does this only for SSH; this is the local start path, built like
// StartLocalShellProc.

// LocalJobProtocol is recorded with every local job. A newer Moltenterm reattaches only to jobs of the same protocol:
// bump it whenever the messages between wavesrv and the job manager change.
const LocalJobProtocol = 1
const LocalJobProtocolVarName = "MOLTEN_JOB_PROTOCOL"

const localJobCwdVarName = "MOLTEN_JOB_CWD"

// Jobs have no working directory of their own: a tiny launcher moves to it, then becomes the shell (same PID, same
// PTY). The job manager ignores SIGHUP to outlive the app, and an ignored signal is inherited: the launcher restores it,
// or the shell would survive the end of its terminal. Only zsh may reset a signal ignored on entry (sh and bash may
// not), so the launcher is zsh when there is one.
const localJobLauncherBody = `cd -- "$` + localJobCwdVarName + `" 2>/dev/null || cd; unset ` + localJobCwdVarName + `; exec "$0" "$@"`
const localJobZsh = "/bin/zsh"

func localJobLauncher() (string, string) {
	if _, err := os.Stat(localJobZsh); err == nil {
		return localJobZsh, "trap - HUP; " + localJobLauncherBody
	}
	return "/bin/sh", localJobLauncherBody
}

func localJobShellArgs(shellPath string, cmdStr string, cmdOpts CommandOptsType) []string {
	shellOpts := append([]string{}, cmdOpts.ShellOpts...)
	if cmdStr != "" {
		return append(shellOpts, "-c", cmdStr)
	}
	switch shellutil.GetShellTypeFromShellPath(shellPath) {
	case shellutil.ShellType_bash:
		// --rcfile cannot be combined with -l or -i
		return append(shellOpts, "--rcfile", shellutil.GetLocalBashRcFileOverride())
	case shellutil.ShellType_fish:
		if cmdOpts.Login {
			shellOpts = append(shellOpts, "-l")
		}
		return append(shellOpts, "-C", fmt.Sprintf("source %s", shellutil.HardQuoteFish(shellutil.GetLocalWaveFishFilePath())))
	case shellutil.ShellType_pwsh:
		return append(shellOpts, "-ExecutionPolicy", "Bypass", "-NoExit", "-File", shellutil.GetLocalWavePowershellEnv())
	}
	if cmdOpts.Login {
		shellOpts = append(shellOpts, "-l")
	}
	if cmdOpts.Interactive {
		shellOpts = append(shellOpts, "-i")
	}
	return shellOpts
}

// LocalJobLaunch is what the job manager starts for a local shell: the launcher, then the shell and its arguments.
func LocalJobLaunch(shellPath string, shellArgs []string) (string, []string) {
	launcher, body := localJobLauncher()
	return launcher, append([]string{"-c", body, shellPath}, shellArgs...)
}

func StartLocalShellJob(ctx context.Context, logCtx context.Context, termSize waveobj.TermSize, cmdStr string, cmdOpts CommandOptsType, blockId string) (string, error) {
	if cmdOpts.SwapToken == nil {
		return "", fmt.Errorf("SwapToken is required in CommandOptsType")
	}
	shellutil.InitCustomShellStartupFiles()
	shellPath := cmdOpts.ShellPath
	if shellPath == "" {
		shellPath = shellutil.DetectLocalShellPath()
	}
	shellArgs := localJobShellArgs(shellPath, cmdStr, cmdOpts)
	env := shellutil.WaveshellLocalEnvVars(shellutil.DefaultTermType)
	if os.Getenv("LANG") == "" {
		env["LANG"] = wavebase.DetermineLang()
	}
	if cmdStr == "" && shellutil.GetShellTypeFromShellPath(shellPath) == shellutil.ShellType_zsh {
		env["ZDOTDIR"] = shellutil.GetLocalZshZDotDir()
	}
	packedToken, err := cmdOpts.SwapToken.PackForClient()
	if err != nil {
		blocklogger.Infof(logCtx, "error packing swap token: %v", err)
	} else {
		env[wavebase.WaveSwapTokenVarName] = packedToken
	}
	if jwtToken := cmdOpts.SwapToken.Env[wavebase.WaveJwtTokenVarName]; jwtToken != "" && cmdOpts.ForceJwt {
		env[wavebase.WaveJwtTokenVarName] = jwtToken
	}
	cwd := cmdOpts.Cwd
	if cwd == "" || checkCwd(cwd) != nil {
		cwd = wavebase.GetHomeDir()
	}
	// The job env is laid over wavesrv's initial env, so an inherited value holding only slots is overridden with an
	// empty one: a job env cannot unset a variable.
	if pluginDirs, set := moltenAgentPartsEnv(); set {
		env[agentparts.PluginDirsVarName] = pluginDirs
	}
	if browser := moltenBrowserEnv(); browser != "" {
		env[shellutil.BrowserVarName] = browser
	}
	env[localJobCwdVarName] = cwd
	env[LocalJobProtocolVarName] = strconv.Itoa(LocalJobProtocol)
	// An interactive shell gets MoltenTerm's managed environment from the integration scripts: its generation tells
	// later versions whether it is outdated (FR-SHELL-041). A block's command gets none of it.
	if cmdStr == "" {
		env[shellutil.MoltenShellGenVarName] = strconv.Itoa(shellutil.MoltenShellGeneration)
	}
	if termSize.Rows <= 0 || termSize.Cols <= 0 {
		termSize.Rows = shellutil.DefaultTermRows
		termSize.Cols = shellutil.DefaultTermCols
	}
	shellutil.AddTokenSwapEntry(cmdOpts.SwapToken)
	cmd, args := LocalJobLaunch(shellPath, shellArgs)
	blocklogger.Debugf(logCtx, "[conndebug] durable local shell:%s args:%v cwd:%s\n", shellPath, shellArgs, cwd)
	jobId, err := jobcontroller.StartJob(ctx, jobcontroller.StartJobParams{
		ConnName: wshrpc.LocalConnName,
		JobKind:  jobcontroller.JobKind_Shell,
		Cmd:      cmd,
		Args:     args,
		Env:      env,
		TermSize: &termSize,
		BlockId:  blockId,
	})
	if err != nil {
		return "", fmt.Errorf("failed to start local job: %w", err)
	}
	return jobId, nil
}

// LocalJobCompatible tells whether this Moltenterm can reattach to a local job started by an earlier run.
func LocalJobCompatible(job *waveobj.Job) bool {
	if job == nil {
		return false
	}
	return job.CmdEnv[LocalJobProtocolVarName] == strconv.Itoa(LocalJobProtocol)
}
