// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package browseragent

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
)

// managerBackend plays `molten mcp browser` in the test: the MCP server's calls go straight to the manager, as the
// route would carry them for the pane's token.
type managerBackend struct {
	m      *Manager
	source string
	token  string

	lock      sync.Mutex
	sessionId string
}

func (b *managerBackend) Start(ctx context.Context, client mcpbrowser.ClientInfo) {
	res, err := b.m.Hello(ctx, b.source, mcpbrowser.HelloRequest{Token: b.token, ClientName: client.Name})
	if err != nil {
		return
	}
	b.lock.Lock()
	defer b.lock.Unlock()
	b.sessionId = res.SessionId
}

func (b *managerBackend) session() string {
	b.lock.Lock()
	defer b.lock.Unlock()
	return b.sessionId
}

func (b *managerBackend) CallTool(ctx context.Context, tool string, args json.RawMessage) mcpbrowser.CallResult {
	return b.m.Call(ctx, b.source, mcpbrowser.CallRequest{SessionId: b.session(), Tool: tool, Args: args})
}

func (b *managerBackend) Close() {
	b.m.Bye(b.source, b.session())
}

type mcpClient struct {
	t   *testing.T
	in  *io.PipeWriter
	out *bufio.Scanner
}

func startMcp(t *testing.T, backend mcpbrowser.Backend) *mcpClient {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	server := mcpbrowser.MakeServer(backend, inR, outW, "test")
	go func() {
		server.Serve(context.Background())
		outW.Close()
	}()
	scanner := bufio.NewScanner(outR)
	scanner.Buffer(make([]byte, 1024*1024), 8*1024*1024)
	return &mcpClient{t: t, in: inW, out: scanner}
}

func (c *mcpClient) request(line string) map[string]any {
	c.t.Helper()
	if _, err := c.in.Write([]byte(line + "\n")); err != nil {
		c.t.Fatalf("write: %v", err)
	}
	lineCh := make(chan string, 1)
	go func() {
		if c.out.Scan() {
			lineCh <- c.out.Text()
		} else {
			lineCh <- ""
		}
	}()
	select {
	case line := <-lineCh:
		var msg map[string]any
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			c.t.Fatalf("bad response %q: %v", line, err)
		}
		return msg
	case <-time.After(5 * time.Second):
		c.t.Fatalf("no response")
	}
	return nil
}

func resultText(t *testing.T, msg map[string]any) string {
	t.Helper()
	result, ok := msg["result"].(map[string]any)
	if !ok {
		t.Fatalf("no result: %v", msg)
	}
	var parts []string
	for _, raw := range result["content"].([]any) {
		parts = append(parts, raw.(map[string]any)["text"].(string))
	}
	return strings.Join(parts, "\n")
}

// An MCP client sees the tab the user shared in tabs_context, marked shared by the user, and loses it at Stop sharing.
func TestMcpClientSeesTheSharedTab(t *testing.T) {
	m, env, _ := makeWorld(t)
	env.agentNames["term-a"] = "Claude Code"
	backend := &managerBackend{m: m, source: "proc:a", token: "tok-a"}
	c := startMcp(t, backend)
	c.request(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"test-client","version":"1"}}}`)
	listed := resultText(t, c.request(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"tabs_context","arguments":{}}}`))
	if !strings.Contains(listed, `"tabs":[]`) {
		t.Fatalf("nothing before the share: %s", listed)
	}
	entries, err := m.ListSessions(context.Background(), "tab:t1", ListRequest{BlockId: "p1"})
	if err != nil || len(entries.Sessions) != 1 || entries.Sessions[0].AgentName != "Claude Code" {
		t.Fatalf("the panel lists the connected agent: %+v %v", entries, err)
	}
	if _, err := m.Share(context.Background(), "tab:t1", ShareRequest{BlockId: "p1", BrowserTabId: "user-tab", SessionId: entries.Sessions[0].SessionId}); err != nil {
		t.Fatalf("share: %v", err)
	}
	listed = resultText(t, c.request(`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"tabs_context","arguments":{}}}`))
	if !strings.Contains(listed, `"owner":"shared by the user"`) || strings.Contains(listed, "SECRET-Q") {
		t.Fatalf("the shared tab, without its query: %s", listed)
	}
	if err := m.Control("tab:t1", ControlRequest{BlockId: "p1", BrowserTabId: "user-tab", Action: ControlStop}); err != nil {
		t.Fatalf("stop sharing: %v", err)
	}
	listed = resultText(t, c.request(`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"tabs_context","arguments":{}}}`))
	if !strings.Contains(listed, `"tabs":[]`) {
		t.Fatalf("the tab is gone after Stop sharing: %s", listed)
	}
	c.in.Close()
}
