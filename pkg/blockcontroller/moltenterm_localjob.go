// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package blockcontroller

import (
	"context"
	"fmt"
	"log"

	"github.com/wavetermdev/waveterm/pkg/filestore"
	"github.com/wavetermdev/waveterm/pkg/jobcontroller"
	"github.com/wavetermdev/waveterm/pkg/shellexec"
	"github.com/wavetermdev/waveterm/pkg/util/shellutil"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// Local durable shells (#72): the local branch of DurableShellController, built like the local branch of
// ShellController (shell path and options from the block, wsh through the local socket).

const localJobIncompatibleNotice = "\r\n[MoltenTerm: this session was started by an older MoltenTerm and cannot be reattached; a new shell starts]\r\n"

func (dsc *DurableShellController) startNewLocalJob(ctx context.Context, blockMeta waveobj.MetaMapType, rtOpts *waveobj.RuntimeOpts) (string, error) {
	termSize := waveobj.TermSize{Rows: shellutil.DefaultTermRows, Cols: shellutil.DefaultTermCols}
	if rtOpts != nil && rtOpts.TermSize.Rows > 0 && rtOpts.TermSize.Cols > 0 {
		termSize = rtOpts.TermSize
	}
	shellPath, err := getLocalShellPath(blockMeta)
	if err != nil {
		return "", err
	}
	shellType := shellutil.GetShellTypeFromShellPath(shellPath)
	swapToken := makeSwapToken(ctx, ctx, dsc.BlockId, blockMeta, dsc.ConnName, shellType)
	if !blockMeta.GetBool(waveobj.MetaKey_CmdNoWsh, false) {
		rpcContext := wshrpc.RpcContext{
			ProcRoute: true,
			SockName:  wavebase.GetDomainSocketName(),
			BlockId:   dsc.BlockId,
		}
		jwtStr, err := wshutil.MakeClientJWTToken(rpcContext)
		if err != nil {
			return "", fmt.Errorf("error making jwt token: %w", err)
		}
		swapToken.RpcContext = &rpcContext
		swapToken.Env[wshutil.WaveJwtTokenVarName] = jwtStr
	}
	cmdOpts := shellexec.CommandOptsType{
		Interactive: true,
		Login:       true,
		Cwd:         blockMeta.GetString(waveobj.MetaKey_CmdCwd, ""),
		SwapToken:   swapToken,
		ForceJwt:    blockMeta.GetBool(waveobj.MetaKey_CmdJwt, false),
		ShellPath:   shellPath,
		ShellOpts:   getLocalShellOpts(blockMeta),
	}
	cmdStr := blockMeta.GetString(waveobj.MetaKey_Cmd, "")
	jobId, err := shellexec.StartLocalShellJob(ctx, ctx, termSize, cmdStr, cmdOpts, dsc.BlockId)
	if err != nil {
		return "", fmt.Errorf("failed to start durable local shell: %w", err)
	}
	return jobId, nil
}

// releaseIncompatibleLocalJob ends a local job a newer Moltenterm cannot speak to, says so in the terminal, and
// reports whether the block must start a new shell.
func (dsc *DurableShellController) releaseIncompatibleLocalJob(ctx context.Context, jobId string) bool {
	job, err := wstore.DBGet[*waveobj.Job](ctx, jobId)
	if err != nil || job == nil || job.Connection != wshrpc.LocalConnName || shellexec.LocalJobCompatible(job) {
		return false
	}
	log.Printf("block %q: local job %s has another protocol, starting a new shell\n", dsc.BlockId, jobId)
	jobcontroller.TerminateAndDetachJob(ctx, jobId)
	filestore.WFS.AppendData(ctx, dsc.BlockId, wavebase.BlockFile_Term, []byte(localJobIncompatibleNotice))
	return true
}
