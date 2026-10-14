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
	"github.com/wavetermdev/waveterm/pkg/molten/handoffwire"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// `molten mcp browser` (FR-BRW-008, DS-BRW-009): the stdio MCP server an agent launches from a MoltenTerm pane, e.g.
// `claude mcp add molten-browser -- molten mcp browser`. `molten mcp review` (FR-REV-004, DS-REV-005): the server of a
// review session, which MoltenTerm gives the session's agent itself. Both speak MCP on stdin/stdout and nothing else:
// stdout belongs to the protocol. Each tool call goes to wavesrv, which owns scope and permissions.

const (
	moltenMcpHelloTimeoutMs = 5000
	moltenMcpByeTimeoutMs   = 2000
	// Longer than wavesrv's own limit on a call (a 2-minute site permission wait, then a page load).
	moltenMcpCallTimeoutMs = 200000
)

var moltenMcpCmd = &cobra.Command{
	Use:   "mcp",
	Short: "MCP servers for coding agents (molten mcp browser, molten mcp review)",
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

var moltenMcpReviewCmd = &cobra.Command{
	Use:   "review",
	Short: "stdio MCP server of a review session: the PR's context and diff, and posts into MoltenTerm's review panel",
	Long: "stdio MCP server of a MoltenTerm review session (FR-REV-004). MoltenTerm gives it to the agent it starts for\n" +
		"a review; outside that session every call answers \"" + mcpreview.ErrNotInMoltenTerm + "\".",
	Args: cobra.NoArgs,
	RunE: moltenMcpReviewRun,
}

func init() {
	moltenCmd.AddCommand(moltenMcpCmd)
	moltenMcpCmd.AddCommand(moltenMcpBrowserCmd)
	moltenMcpCmd.AddCommand(moltenMcpReviewCmd)
}

// moltenMcpProtocol is how one server reaches its wavesrv route.
type moltenMcpProtocol struct {
	name     string
	route    string
	hello    string
	call     string
	bye      string
	notInErr string
	// fixed: wavesrv's refusals kept as their sentences.
	fixed     []string
	startFail string
	makeHello func(token string, client mcpbrowser.ClientInfo) any
	helloId   func(resp any) (string, error)
	makeCall  func(id string, tool string, args json.RawMessage) any
	makeBye   func(id string) any
}

var moltenMcpBrowserProtocol = moltenMcpProtocol{
	name: "molten mcp browser", route: mcpbrowser.RouteId,
	hello: mcpbrowser.HelloCommand, call: mcpbrowser.CallCommand, bye: mcpbrowser.ByeCommand,
	notInErr:  mcpbrowser.ErrNotInMoltenTerm,
	fixed:     []string{mcpbrowser.ErrNotInMoltenTerm, mcpbrowser.ErrRemotePane},
	startFail: "MoltenTerm's browser could not start a session for this pane",
	makeHello: func(token string, client mcpbrowser.ClientInfo) any {
		return mcpbrowser.HelloRequest{Token: token, ClientName: client.Name, ClientVersion: client.Version}
	},
	helloId: func(resp any) (string, error) {
		var result mcpbrowser.HelloResult
		err := utilfn.ReUnmarshal(&result, resp)
		return result.SessionId, err
	},
	makeCall: func(id string, tool string, args json.RawMessage) any {
		return mcpbrowser.CallRequest{SessionId: id, Tool: tool, Args: args}
	},
	makeBye: func(id string) any { return mcpbrowser.ByeRequest{SessionId: id} },
}

func moltenMcpReviewProtocol(sessionToken string) moltenMcpProtocol {
	return moltenMcpProtocol{
		name: "molten mcp review", route: mcpreview.RouteId,
		hello: mcpreview.HelloCommand, call: mcpreview.CallCommand, bye: mcpreview.ByeCommand,
		notInErr:  mcpreview.ErrNotInMoltenTerm,
		fixed:     []string{mcpreview.ErrNotInMoltenTerm, mcpreview.ErrRemotePane, mcpreview.ErrSessionEnded},
		startFail: "MoltenTerm's review session could not be reached",
		makeHello: func(token string, client mcpbrowser.ClientInfo) any {
			return mcpreview.HelloRequest{Token: token, SessionToken: sessionToken, ClientName: client.Name, ClientVersion: client.Version}
		},
		helloId: func(resp any) (string, error) {
			var result mcpreview.HelloResult
			err := utilfn.ReUnmarshal(&result, resp)
			return result.ConnId, err
		},
		makeCall: func(id string, tool string, args json.RawMessage) any {
			return mcpreview.CallRequest{ConnId: id, Tool: tool, Args: args}
		},
		makeBye: func(id string) any { return mcpreview.ByeRequest{ConnId: id} },
	}
}

func moltenMcpBrowserRun(cmd *cobra.Command, args []string) error {
	return runMoltenMcpServer(mcpbrowser.BrowserSpec(), moltenMcpBrowserProtocol, os.Getenv(wshutil.WaveJwtTokenVarName))
}

func moltenMcpReviewRun(cmd *cobra.Command, args []string) error {
	sessionToken := os.Getenv(mcpreview.SessionTokenVarName)
	jwt := os.Getenv(wshutil.WaveJwtTokenVarName)
	if sessionToken == "" {
		jwt = ""
	}
	return runMoltenMcpServer(mcpreview.Spec(), moltenMcpReviewProtocol(sessionToken), jwt)
}

// runMoltenMcpServer serves the spec's tools; without a terminal token, or when wavesrv cannot be reached, every call
// answers that it does not run in MoltenTerm.
func runMoltenMcpServer(spec mcpbrowser.ServerSpec, protocol moltenMcpProtocol, token string) error {
	var backend mcpbrowser.Backend = moltenMcpOfflineBackend{err: protocol.notInErr}
	if token != "" {
		if err := setupRpcClient(nil, token); err != nil {
			fmt.Fprintf(os.Stderr, "%s: MoltenTerm is not reachable (%v)\n", protocol.name, err)
		} else {
			backend = &moltenMcpRpcBackend{token: token, protocol: protocol}
		}
	}
	server := mcpbrowser.MakeSpecServer(spec, backend, os.Stdin, os.Stdout, wavebase.WaveVersion)
	if err := server.Serve(context.Background()); err != nil {
		fmt.Fprintf(os.Stderr, "%s: %v\n", protocol.name, err)
		WshExitCode = 1
	}
	return nil
}

type moltenMcpOfflineBackend struct {
	err string
}

func (moltenMcpOfflineBackend) Start(ctx context.Context, client mcpbrowser.ClientInfo) {}

func (b moltenMcpOfflineBackend) CallTool(ctx context.Context, tool string, args json.RawMessage) mcpbrowser.CallResult {
	return mcpbrowser.ErrorResult(b.err)
}

func (moltenMcpOfflineBackend) Close() {}

// moltenMcpRpcBackend opens one session in wavesrv and forwards each tool call to it.
type moltenMcpRpcBackend struct {
	token    string
	protocol moltenMcpProtocol

	lock      sync.Mutex
	client    mcpbrowser.ClientInfo
	sessionId string
	startErr  string
	// firstName: the pane's agent name, for the browser server's instructions.
	firstName string
}

func (b *moltenMcpRpcBackend) Start(ctx context.Context, client mcpbrowser.ClientInfo) {
	b.setClient(client)
	b.hello()
	if b.protocol.route == mcpbrowser.RouteId {
		b.setFirstName(moltenMcpOwnFirstName(b.token))
	}
}

func (b *moltenMcpRpcBackend) setFirstName(name string) {
	b.lock.Lock()
	defer b.lock.Unlock()
	b.firstName = name
}

// Instructions tells the agent its first name (FR-CONT-014) in the browser server's instructions.
func (b *moltenMcpRpcBackend) Instructions(base string) string {
	if b.protocol.route != mcpbrowser.RouteId {
		return base
	}
	b.lock.Lock()
	defer b.lock.Unlock()
	return mcpbrowser.ServerInstructions + mcpbrowser.AgentInstructions(b.firstName)
}

// moltenMcpOwnFirstName asks the handoff route for the pane's agent name, "" when it has none yet.
func moltenMcpOwnFirstName(token string) string {
	var list handoffwire.ListResult
	err := moltenHandoffRequest(handoffwire.ListCommand, handoffwire.ListRequest{Token: token, WaitName: true}, moltenHandoffListTimeoutMs, &list)
	if err != nil || list.You == nil {
		return ""
	}
	return list.You.FirstName
}

// moltenMcpAgentTool runs list_agents and send_to_agent on the handoff route (FR-CONT-015).
func moltenMcpAgentTool(token string, tool string, args json.RawMessage) mcpbrowser.CallResult {
	if tool == mcpbrowser.ToolListAgents {
		var list handoffwire.ListResult
		if err := moltenHandoffRequest(handoffwire.ListCommand, handoffwire.ListRequest{Token: token}, moltenHandoffListTimeoutMs, &list); err != nil {
			return mcpbrowser.ErrorResult(moltenHandoffError(err))
		}
		return mcpbrowser.TextResult(mcpbrowser.FormatAgentList(moltenMcpAgentList(list)))
	}
	var in mcpbrowser.SendToAgentArgs
	if err := json.Unmarshal(args, &in); err != nil {
		return mcpbrowser.ErrorResult("send_to_agent takes {name, brief: {goal, context, files, links, reply}}")
	}
	var brief handoffwire.Brief
	if len(in.Brief) > 0 {
		if err := json.Unmarshal(in.Brief, &brief); err != nil {
			return mcpbrowser.ErrorResult(fmt.Sprintf("brief could not be read: %v", err))
		}
	}
	var result handoffwire.SendResult
	err := moltenHandoffRequest(handoffwire.SendCommand, handoffwire.SendRequest{Token: token, To: in.Name, Brief: brief}, moltenHandoffSendTimeoutMs, &result)
	if err != nil {
		return mcpbrowser.ErrorResult(moltenHandoffError(err))
	}
	return mcpbrowser.TextResult(result.Message)
}

func moltenMcpAgentList(list handoffwire.ListResult) mcpbrowser.AgentList {
	entry := func(e handoffwire.AgentEntry) mcpbrowser.AgentListEntry {
		return mcpbrowser.AgentListEntry{FirstName: e.FirstName, AgentName: e.AgentName, State: e.State, Project: e.Project,
			Folder: e.Folder, Workspace: e.Workspace, Tab: e.Tab, You: e.You}
	}
	rtn := mcpbrowser.AgentList{Agents: []mcpbrowser.AgentListEntry{}}
	if list.You != nil {
		you := entry(*list.You)
		rtn.You = &you
	}
	for _, e := range list.Agents {
		rtn.Agents = append(rtn.Agents, entry(e))
	}
	return rtn
}

func (b *moltenMcpRpcBackend) setClient(client mcpbrowser.ClientInfo) {
	b.lock.Lock()
	defer b.lock.Unlock()
	b.client = client
}

// hello opens the session; a call made while there is none tries again (wavesrv was starting, or restarted).
func (b *moltenMcpRpcBackend) hello() {
	client := b.clientInfo()
	sessionId := ""
	resp, err := RpcClient.SendRpcRequest(b.protocol.hello, b.protocol.makeHello(b.token, client),
		&wshrpc.RpcOpts{Route: b.protocol.route, Timeout: moltenMcpHelloTimeoutMs})
	if err == nil {
		sessionId, err = b.protocol.helloId(resp)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s: no session: %v\n", b.protocol.name, err)
	}
	b.setSession(sessionId, moltenMcpStartError(b.protocol, err))
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
func moltenMcpStartError(protocol moltenMcpProtocol, err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	for _, fixed := range protocol.fixed {
		if strings.HasSuffix(msg, fixed) {
			return fixed
		}
	}
	return fmt.Sprintf("%s: %s", protocol.startFail, msg)
}

func (b *moltenMcpRpcBackend) session() (string, string) {
	b.lock.Lock()
	defer b.lock.Unlock()
	return b.sessionId, b.startErr
}

func (b *moltenMcpRpcBackend) CallTool(ctx context.Context, tool string, args json.RawMessage) mcpbrowser.CallResult {
	if b.protocol.route == mcpbrowser.RouteId && mcpbrowser.IsAgentTool(tool) {
		return moltenMcpAgentTool(b.token, tool, args)
	}
	sessionId, _ := b.session()
	if sessionId == "" {
		b.hello()
		var startErr string
		sessionId, startErr = b.session()
		if sessionId == "" {
			return mcpbrowser.ErrorResult(startErr)
		}
	}
	handler, err := RpcClient.SendComplexRequest(b.protocol.call, b.protocol.makeCall(sessionId, tool, args),
		&wshrpc.RpcOpts{Route: b.protocol.route, Timeout: moltenMcpCallTimeoutMs})
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
	RpcClient.SendRpcRequest(b.protocol.bye, b.protocol.makeBye(sessionId),
		&wshrpc.RpcOpts{Route: b.protocol.route, Timeout: moltenMcpByeTimeoutMs})
}
