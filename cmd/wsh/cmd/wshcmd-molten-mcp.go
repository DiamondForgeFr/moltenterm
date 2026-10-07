// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// `molten mcp browser` (FR-BRW-008, DS-BRW-009): the stdio MCP server an agent launches from a MoltenTerm pane, e.g.
// `claude mcp add molten-browser -- molten mcp browser`. It speaks MCP on stdin/stdout and nothing else: stdout belongs
// to the protocol. Each tool call goes to the agent session in wavesrv, which owns scope and permissions.

const (
	moltenMcpHelloTimeoutMs = 5000
	moltenMcpByeTimeoutMs   = 2000
	// Longer than any tool of this version; later tools that wait for the user (site permission, 120 s) raise it.
	moltenMcpCallTimeoutMs = 150000
)

var moltenMcpCmd = &cobra.Command{
	Use:   "mcp",
	Short: "MCP servers for coding agents (molten mcp browser)",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		return cmd.Help()
	},
}

var moltenMcpBrowserCmd = &cobra.Command{
	Use:   "browser",
	Short: "stdio MCP server that lets the agent of this pane drive tabs of MoltenTerm's browser panel",
	Long: "stdio MCP server that lets the coding agent of this pane drive tabs of MoltenTerm's browser panel, for\n" +
		"example: claude mcp add molten-browser -- molten mcp browser. Outside a MoltenTerm terminal the tools are\n" +
		"listed and every call answers \"" + mcpbrowser.ErrNotInMoltenTerm + "\".",
	Args: cobra.NoArgs,
	// No PreRunE: the server must start outside MoltenTerm too, and answer there.
	RunE: moltenMcpBrowserRun,
}

func init() {
	moltenCmd.AddCommand(moltenMcpCmd)
	moltenMcpCmd.AddCommand(moltenMcpBrowserCmd)
}

func moltenMcpBrowserRun(cmd *cobra.Command, args []string) error {
	var backend mcpbrowser.Backend = mcpbrowser.OfflineBackend{}
	token := os.Getenv(wshutil.WaveJwtTokenVarName)
	if token != "" {
		if err := setupRpcClient(nil, token); err != nil {
			fmt.Fprintf(os.Stderr, "molten mcp browser: MoltenTerm is not reachable (%v)\n", err)
		} else {
			backend = &moltenMcpRpcBackend{token: token}
		}
	}
	server := mcpbrowser.MakeServer(backend, os.Stdin, os.Stdout, wavebase.WaveVersion)
	if err := server.Serve(context.Background()); err != nil {
		fmt.Fprintf(os.Stderr, "molten mcp browser: %v\n", err)
		WshExitCode = 1
	}
	return nil
}

// moltenMcpRpcBackend opens one agent session in wavesrv and forwards each tool call to it.
type moltenMcpRpcBackend struct {
	token string

	lock      sync.Mutex
	client    mcpbrowser.ClientInfo
	sessionId string
	startErr  string
}

func (b *moltenMcpRpcBackend) Start(ctx context.Context, client mcpbrowser.ClientInfo) {
	b.setClient(client)
	b.hello()
}

func (b *moltenMcpRpcBackend) setClient(client mcpbrowser.ClientInfo) {
	b.lock.Lock()
	defer b.lock.Unlock()
	b.client = client
}

// hello opens the session; a call made while there is none tries again (wavesrv was starting, or restarted).
func (b *moltenMcpRpcBackend) hello() {
	client := b.clientInfo()
	var result mcpbrowser.HelloResult
	resp, err := RpcClient.SendRpcRequest(mcpbrowser.HelloCommand, mcpbrowser.HelloRequest{
		Token:         b.token,
		ClientName:    client.Name,
		ClientVersion: client.Version,
	}, &wshrpc.RpcOpts{Route: mcpbrowser.RouteId, Timeout: moltenMcpHelloTimeoutMs})
	if err == nil {
		err = utilfn.ReUnmarshal(&result, resp)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "molten mcp browser: no session: %v\n", err)
	}
	b.setSession(result.SessionId, moltenMcpStartError(err))
}

func (b *moltenMcpRpcBackend) clientInfo() mcpbrowser.ClientInfo {
	b.lock.Lock()
	defer b.lock.Unlock()
	return b.client
}

func (b *moltenMcpRpcBackend) setSession(sessionId string, startErr string) {
	b.lock.Lock()
	defer b.lock.Unlock()
	b.sessionId = sessionId
	b.startErr = startErr
}

// moltenMcpStartError keeps wavesrv's refusals as their fixed sentences (an agent outside a local MoltenTerm pane
// reads "Not running in a MoltenTerm terminal"); anything else says the session could not start.
func moltenMcpStartError(err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	for _, fixed := range []string{mcpbrowser.ErrNotInMoltenTerm, mcpbrowser.ErrRemotePane} {
		if strings.HasSuffix(msg, fixed) {
			return fixed
		}
	}
	return fmt.Sprintf("MoltenTerm's browser could not start a session for this pane: %s", msg)
}

func (b *moltenMcpRpcBackend) session() (string, string) {
	b.lock.Lock()
	defer b.lock.Unlock()
	return b.sessionId, b.startErr
}

func (b *moltenMcpRpcBackend) CallTool(ctx context.Context, tool string, args json.RawMessage) mcpbrowser.CallResult {
	sessionId, _ := b.session()
	if sessionId == "" {
		b.hello()
		var startErr string
		sessionId, startErr = b.session()
		if sessionId == "" {
			return mcpbrowser.ErrorResult(startErr)
		}
	}
	handler, err := RpcClient.SendComplexRequest(mcpbrowser.CallCommand, mcpbrowser.CallRequest{
		SessionId: sessionId,
		Tool:      tool,
		Args:      args,
	}, &wshrpc.RpcOpts{Route: mcpbrowser.RouteId, Timeout: moltenMcpCallTimeoutMs})
	if err != nil {
		return mcpbrowser.ErrorResult(fmt.Sprintf("MoltenTerm is not reachable: %v", err))
	}
	type response struct {
		data any
		err  error
	}
	respCh := make(chan response, 1)
	go func() {
		data, err := handler.NextResponse()
		respCh <- response{data: data, err: err}
	}()
	select {
	case resp := <-respCh:
		if resp.err != nil {
			return mcpbrowser.ErrorResult(resp.err.Error())
		}
		var result mcpbrowser.CallResult
		if err := utilfn.ReUnmarshal(&result, resp.data); err != nil {
			return mcpbrowser.ErrorResult(fmt.Sprintf("unreadable answer from MoltenTerm: %v", err))
		}
		return result
	case <-ctx.Done():
		cancelCtx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		handler.SendCancel(cancelCtx)
		return mcpbrowser.ErrorResult("Cancelled")
	}
}

func (b *moltenMcpRpcBackend) Close() {
	sessionId, _ := b.session()
	if sessionId == "" {
		return
	}
	RpcClient.SendRpcRequest(mcpbrowser.ByeCommand, mcpbrowser.ByeRequest{SessionId: sessionId},
		&wshrpc.RpcOpts{Route: mcpbrowser.RouteId, Timeout: moltenMcpByeTimeoutMs})
}
