// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// Cheap agent hooks (FR-PERF-012, DS-PERF-011): the agents' hooks run molten at every turn or tool call, each run a
// new process and a new connection to wavesrv. `molten agent state` and `statusline` connect with
// pkg/molten/agenthook; the other hook commands (session, notify) with setupHookRpcClient: the same authentication as
// every wsh command, but only the round trips the hook needs. No peer info (only wavesrv's logs read it) and no wsh
// activity report (a telemetry write in wavesrv for every hook run).

// setupHookRpcClient connects and authenticates like setupRpcClient, without the peer info.
func setupHookRpcClient(jwtToken string) error {
	rpcCtx, err := wshutil.ExtractUnverifiedRpcContext(jwtToken)
	if err != nil {
		return fmt.Errorf("error extracting rpc context from %s: %v", wshutil.WaveJwtTokenVarName, err)
	}
	sockName, err := wshutil.ExtractUnverifiedSocketName(jwtToken)
	if err != nil {
		return fmt.Errorf("error extracting socket name from %s: %v", wshutil.WaveJwtTokenVarName, err)
	}
	client, err := wshutil.SetupDomainSocketRpcClient(sockName, nil, "wshcmd")
	if err != nil {
		return fmt.Errorf("error setting up domain socket rpc client: %v", err)
	}
	authRtn, err := wshclient.AuthenticateCommand(client, jwtToken, &wshrpc.RpcOpts{Route: wshutil.ControlRoute})
	if err != nil {
		return fmt.Errorf("error authenticating: %v", err)
	}
	RpcContext = *rpcCtx
	RpcClient = client
	RpcClientRouteId = authRtn.RouteId
	return nil
}

func preRunSetupHookRpcClient(cmd *cobra.Command, args []string) error {
	jwtToken := os.Getenv(wshutil.WaveJwtTokenVarName)
	if jwtToken == "" {
		return fmt.Errorf("wsh must be run inside a Wave-managed SSH session (WAVETERM_JWT not found)")
	}
	return setupHookRpcClient(jwtToken)
}

// preRunCheckJwt fails as preRunSetupRpcClient does outside a terminal, for a command that connects by itself
// (pkg/molten/agenthook).
func preRunCheckJwt(cmd *cobra.Command, args []string) error {
	if os.Getenv(wshutil.WaveJwtTokenVarName) == "" {
		return fmt.Errorf("wsh must be run inside a Wave-managed SSH session (WAVETERM_JWT not found)")
	}
	return nil
}

// moltenHookWrap fails like moltenWrap, without the activity report.
func moltenHookWrap(fn func(cmd *cobra.Command, args []string) error) func(cmd *cobra.Command, args []string) error {
	return func(cmd *cobra.Command, args []string) error {
		if err := fn(cmd, args); err != nil {
			moltenReportError(err)
		}
		return nil
	}
}
