// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten/handoffwire"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// `molten mcp browser` (FR-BRW-008, DS-BRW-009): the stdio MCP server an agent launches from a MoltenTerm pane, e.g.
// `claude mcp add molten-browser -- molten mcp browser`. `molten mcp review` (FR-REV-004, DS-REV-005): the server of a
// review session, which MoltenTerm gives the session's agent itself. Both speak MCP on stdin/stdout and nothing else:
// stdout belongs to the protocol. Each tool call goes to wavesrv, which owns scope and permissions, over a link that
// survives MoltenTerm restarts (wshcmd-molten-mcplink.go, #1029).

const (
	moltenMcpHelloTimeoutMs = 5000
	moltenMcpByeTimeoutMs   = 2000
	// Longer than wavesrv's own limit on a call (a 2-minute site permission wait, then a page load).
	moltenMcpCallTimeoutMs = 200000

	moltenMcpBrowserServer = "molten-browser"
	moltenMcpReviewServer  = "molten-review"
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
	server   string
	route    string
	hello    string
	call     string
	bye      string
	notInErr string
	// sessionEnded: wavesrv's answer to a session id it does not know, e.g. one opened on a previous link.
	sessionEnded string
	// fixed: wavesrv's refusals kept as their sentences.
	fixed     []string
	startFail string
	// readOnly: a tool whose call may be sent again when the link died before its answer.
	readOnly  func(tool string) bool
	makeHello func(token string, client mcpbrowser.ClientInfo) any
	helloId   func(resp any) (string, error)
	makeCall  func(id string, tool string, args json.RawMessage) any
	makeBye   func(id string) any
}

func isMoltenMcpBrowserReadOnly(tool string) bool {
	switch tool {
	case mcpbrowser.ToolTabsContext, mcpbrowser.ToolReadPage, mcpbrowser.ToolGetPageText, mcpbrowser.ToolFind,
		mcpbrowser.ToolListAgents:
		return true
	}
	return false
}

func isMoltenMcpReviewReadOnly(tool string) bool {
	switch tool {
	case mcpreview.ToolContext, mcpreview.ToolFiles, mcpreview.ToolDiff, mcpreview.ToolSelection:
		return true
	}
	return false
}

var moltenMcpBrowserProtocol = moltenMcpProtocol{
	name: "molten mcp browser", server: moltenMcpBrowserServer, route: mcpbrowser.RouteId,
	hello: mcpbrowser.HelloCommand, call: mcpbrowser.CallCommand, bye: mcpbrowser.ByeCommand,
	notInErr:     mcpbrowser.ErrNotInMoltenTerm,
	sessionEnded: mcpbrowser.ErrSessionEnded,
	fixed:        []string{mcpbrowser.ErrNotInMoltenTerm, mcpbrowser.ErrRemotePane},
	startFail:    "MoltenTerm's browser could not start a session for this pane",
	readOnly:     isMoltenMcpBrowserReadOnly,
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
		name: "molten mcp review", server: moltenMcpReviewServer, route: mcpreview.RouteId,
		hello: mcpreview.HelloCommand, call: mcpreview.CallCommand, bye: mcpreview.ByeCommand,
		notInErr:     mcpreview.ErrNotInMoltenTerm,
		sessionEnded: mcpreview.ErrSessionEnded,
		fixed:        []string{mcpreview.ErrNotInMoltenTerm, mcpreview.ErrRemotePane, mcpreview.ErrSessionEnded},
		startFail:    "MoltenTerm's review session could not be reached",
		readOnly:     isMoltenMcpReviewReadOnly,
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

// runMoltenMcpServer serves the spec's tools; without a terminal token every call answers that it does not run in
// MoltenTerm. With one, the server reaches wavesrv whenever it can: MoltenTerm may start, quit or restart while the
// agent runs.
func runMoltenMcpServer(spec mcpbrowser.ServerSpec, protocol moltenMcpProtocol, token string) error {
	var backend mcpbrowser.Backend = moltenMcpOfflineBackend{err: protocol.notInErr}
	if token != "" {
		backend = makeMoltenMcpRpcBackend(token, protocol, moltenMcpDial)
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

// moltenMcpRpcBackend opens one session in wavesrv and forwards each tool call to it, opening a new one when the link
// to wavesrv was made again.
type moltenMcpRpcBackend struct {
	token    string
	protocol moltenMcpProtocol
	link     *moltenMcpLink

	lock      sync.Mutex
	client    mcpbrowser.ClientInfo
	sessionId string
	// sessionGen: the link's connection the session was opened on.
	sessionGen int
	startErr   string
	// firstName: the pane's agent name, for the browser server's instructions.
	firstName string
}

func makeMoltenMcpRpcBackend(token string, protocol moltenMcpProtocol, dial moltenMcpDialFn) *moltenMcpRpcBackend {
	b := &moltenMcpRpcBackend{token: token, protocol: protocol, link: makeMoltenMcpLink(token, dial)}
	b.link.restored = b.sendLinkNotice
	return b
}

func (b *moltenMcpRpcBackend) Start(ctx context.Context, client mcpbrowser.ClientInfo) {
	b.setClient(client)
	b.hello()
	if b.protocol.route == mcpbrowser.RouteId {
		b.setFirstName(b.ownFirstName())
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

func (b *moltenMcpRpcBackend) handoffRequest(ctx context.Context, command string, data any, timeoutMs int, readOnly bool, out any) error {
	resp, _, err := b.link.call(ctx, command, data, handoffwire.RouteId, int64(timeoutMs), readOnly)
	if err != nil {
		return err
	}
	return utilfn.ReUnmarshal(out, resp)
}

// ownFirstName asks the handoff route for the pane's agent name, "" when it has none yet.
func (b *moltenMcpRpcBackend) ownFirstName() string {
	var list handoffwire.ListResult
	err := b.handoffRequest(context.Background(), handoffwire.ListCommand, handoffwire.ListRequest{Token: b.token, WaitName: true},
		moltenHandoffListTimeoutMs, true, &list)
	if err != nil || list.You == nil {
		return ""
	}
	return list.You.FirstName
}

// agentTool runs list_agents and send_to_agent on the handoff route (FR-CONT-015). A send is never replayed.
func (b *moltenMcpRpcBackend) agentTool(ctx context.Context, tool string, args json.RawMessage) mcpbrowser.CallResult {
	if tool == mcpbrowser.ToolListAgents {
		var list handoffwire.ListResult
		if err := b.handoffRequest(ctx, handoffwire.ListCommand, handoffwire.ListRequest{Token: b.token}, moltenHandoffListTimeoutMs, true, &list); err != nil {
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
	err := b.handoffRequest(ctx, handoffwire.SendCommand, handoffwire.SendRequest{Token: b.token, To: in.Name, Brief: brief},
		moltenHandoffSendTimeoutMs, false, &result)
	if err != nil {
		return mcpbrowser.ErrorResult(moltenHandoffError(err))
	}
	return mcpbrowser.TextResult(result.Message)
}

// sendLinkNotice tells MoltenTerm the link is back after calls failed, on the new connection itself: a failure here is
// not one the agent saw.
func (b *moltenMcpRpcBackend) sendLinkNotice(conn *moltenMcpConn, failed int) {
	fmt.Fprintf(os.Stderr, "%s: connected to MoltenTerm again, %d calls failed meanwhile\n", b.protocol.name, failed)
	req := handoffwire.LinkNoticeRequest{Token: b.token, Server: b.protocol.server, Failed: failed}
	opts := moltenMcpOpts(handoffwire.RouteId, moltenMcpNoticeTimeoutMs)
	if _, err := conn.rpc.SendRpcRequest(handoffwire.LinkNoticeCommand, req, opts); err != nil {
		fmt.Fprintf(os.Stderr, "%s: the reconnect notice was not shown: %v\n", b.protocol.name, err)
	}
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

// hello opens the session; a call made while there is none, or after the link was made again, tries again.
func (b *moltenMcpRpcBackend) hello() {
	client := b.clientInfo()
	sessionId := ""
	resp, gen, err := b.link.call(context.Background(), b.protocol.hello, b.protocol.makeHello(b.token, client),
		b.protocol.route, moltenMcpHelloTimeoutMs, true)
	if err == nil {
		sessionId, err = b.protocol.helloId(resp)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s: no session: %v\n", b.protocol.name, err)
	}
	b.setSession(sessionId, gen, moltenMcpStartError(b.protocol, err))
}

func (b *moltenMcpRpcBackend) clientInfo() mcpbrowser.ClientInfo {
	b.lock.Lock()
	defer b.lock.Unlock()
	return b.client
}

func (b *moltenMcpRpcBackend) setSession(sessionId string, gen int, startErr string) {
	b.lock.Lock()
	defer b.lock.Unlock()
	b.sessionId = sessionId
	b.sessionGen = gen
	b.startErr = startErr
}

// moltenMcpStartError keeps wavesrv's refusals as their fixed sentences (an agent outside a local MoltenTerm pane
// reads "Not running in a MoltenTerm terminal") and the link's own sentences; anything else says the session could not
// start.
func moltenMcpStartError(protocol moltenMcpProtocol, err error) string {
	if err == nil {
		return ""
	}
	var linkErr *moltenMcpLinkError
	if errors.As(err, &linkErr) {
		return linkErr.Error()
	}
	msg := err.Error()
	for _, fixed := range protocol.fixed {
		if strings.HasSuffix(msg, fixed) {
			return fixed
		}
	}
	return fmt.Sprintf("%s: %s", protocol.startFail, msg)
}

func (b *moltenMcpRpcBackend) session() (string, int, string) {
	b.lock.Lock()
	defer b.lock.Unlock()
	return b.sessionId, b.sessionGen, b.startErr
}

// currentSession returns a session opened on the link's current connection, opening one when needed.
func (b *moltenMcpRpcBackend) currentSession() (string, int, string) {
	sessionId, sessionGen, _ := b.session()
	if sessionId != "" {
		if _, gen, err := b.link.get(); err != nil || gen == sessionGen {
			return sessionId, sessionGen, ""
		}
	}
	b.hello()
	sessionId, sessionGen, startErr := b.session()
	return sessionId, sessionGen, startErr
}

func (b *moltenMcpRpcBackend) CallTool(ctx context.Context, tool string, args json.RawMessage) mcpbrowser.CallResult {
	if b.protocol.route == mcpbrowser.RouteId && mcpbrowser.IsAgentTool(tool) {
		return b.agentTool(ctx, tool, args)
	}
	for attempt := 0; ; attempt++ {
		sessionId, sessionGen, startErr := b.currentSession()
		if sessionId == "" {
			return mcpbrowser.ErrorResult(startErr)
		}
		resp, gen, err := b.link.call(ctx, b.protocol.call, b.protocol.makeCall(sessionId, tool, args), b.protocol.route,
			moltenMcpCallTimeoutMs, b.protocol.readOnly(tool))
		if err != nil {
			return mcpbrowser.ErrorResult(err.Error())
		}
		var result mcpbrowser.CallResult
		if err := utilfn.ReUnmarshal(&result, resp); err != nil {
			return mcpbrowser.ErrorResult(fmt.Sprintf("unreadable answer from MoltenTerm: %v", err))
		}
		// The link was made again under the call: wavesrv did not know the session, so nothing was done.
		if attempt == 0 && gen != sessionGen && moltenMcpIsSessionEnded(result, b.protocol.sessionEnded) {
			b.setSession("", 0, "")
			continue
		}
		return result
	}
}

func moltenMcpIsSessionEnded(result mcpbrowser.CallResult, sentence string) bool {
	return result.IsError && len(result.Content) > 0 && result.Content[0].Text == sentence
}

func (b *moltenMcpRpcBackend) Close() {
	defer b.link.close()
	sessionId, _, _ := b.session()
	if sessionId == "" {
		return
	}
	conn := b.link.current()
	if conn == nil {
		return
	}
	conn.rpc.SendRpcRequest(b.protocol.bye, b.protocol.makeBye(sessionId), moltenMcpOpts(b.protocol.route, moltenMcpByeTimeoutMs))
}
