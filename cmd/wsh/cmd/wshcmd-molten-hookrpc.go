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

// The terminal has no MoltenTerm token: a shell started outside MoltenTerm, or one without its integration (/bin/sh).
// English like all CLI output (agents parse it), and without the token's name, which says Wave and SSH (#750).
func errNotMoltenTerminal() error {
	return fmt.Errorf("this command must run in a MoltenTerm terminal, and this terminal is not one")
}

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
		return errNotMoltenTerminal()
	}
	return setupHookRpcClient(jwtToken)
}

// preRunCheckJwt fails as preRunSetupRpcClient does outside a terminal, for a command that connects by itself
// (pkg/molten/agenthook).
func preRunCheckJwt(cmd *cobra.Command, args []string) error {
	if os.Getenv(wshutil.WaveJwtTokenVarName) == "" {
		return errNotMoltenTerminal()
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
