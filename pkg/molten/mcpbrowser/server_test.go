// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mcpbrowser

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeBackend struct {
	lock    sync.Mutex
	started []ClientInfo
	calls   []string
	closed  bool
	block   chan struct{}
}

func (b *fakeBackend) Start(ctx context.Context, client ClientInfo) {
	b.lock.Lock()
	defer b.lock.Unlock()
	b.started = append(b.started, client)
}

func (b *fakeBackend) CallTool(ctx context.Context, tool string, args json.RawMessage) CallResult {
	b.lock.Lock()
	b.calls = append(b.calls, tool+" "+string(args))
	block := b.block
	b.lock.Unlock()
	if block != nil {
		select {
		case <-block:
		case <-ctx.Done():
			return ErrorResult("cancelled")
		}
	}
	return TextResult("ran " + tool)
}

func (b *fakeBackend) Close() {
	b.lock.Lock()
	defer b.lock.Unlock()
	b.closed = true
}

// testClient drives a server over pipes, one JSON-RPC line at a time.
type testClient struct {
	t      *testing.T
	in     *io.PipeWriter
	out    *bufio.Scanner
	done   chan error
	server *Server
}

func startServer(t *testing.T, backend Backend) *testClient {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	server := MakeServer(backend, inR, outW, "test")
	done := make(chan error, 1)
	go func() {
		done <- server.Serve(context.Background())
		outW.Close()
	}()
	scanner := bufio.NewScanner(outR)
	scanner.Buffer(make([]byte, 1024*1024), 8*1024*1024)
	return &testClient{t: t, in: inW, out: scanner, done: done, server: server}
}

func (c *testClient) send(line string) {
	c.t.Helper()
	if _, err := c.in.Write([]byte(line + "\n")); err != nil {
		c.t.Fatalf("write: %v", err)
	}
}

func (c *testClient) recv() map[string]any {
	c.t.Helper()
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
		if line == "" {
			c.t.Fatalf("no response")
		}
		if strings.Contains(line, "\n") {
			c.t.Fatalf("response with an embedded newline: %q", line)
		}
		var msg map[string]any
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			c.t.Fatalf("bad response %q: %v", line, err)
		}
		return msg
	case <-time.After(5 * time.Second):
		c.t.Fatalf("timeout waiting for a response")
	}
	return nil
}

func (c *testClient) close() {
	c.in.Close()
	select {
	case <-c.done:
	case <-time.After(5 * time.Second):
		c.t.Fatalf("server did not stop on EOF")
	}
}

func errorCode(msg map[string]any) int {
	e, _ := msg["error"].(map[string]any)
	code, _ := e["code"].(float64)
	return int(code)
}

func TestInitializeNegotiatesVersion(t *testing.T) {
	backend := &fakeBackend{}
	c := startServer(t, backend)
	defer c.close()
	c.send(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"claude-code","version":"2.1.0"}}}`)
	resp := c.recv()
	result := resp["result"].(map[string]any)
	if result["protocolVersion"] != "2025-06-18" {
		t.Fatalf("protocolVersion = %v", result["protocolVersion"])
	}
	if _, ok := result["capabilities"].(map[string]any)["tools"]; !ok {
		t.Fatalf("tools capability missing: %v", result["capabilities"])
	}
	if result["serverInfo"].(map[string]any)["name"] != ServerName {
		t.Fatalf("serverInfo = %v", result["serverInfo"])
	}
	if resp["id"].(float64) != 1 {
		t.Fatalf("id = %v", resp["id"])
	}
	c.send(`{"jsonrpc":"2.0","id":"x","method":"initialize","params":{"protocolVersion":"1999-01-01","clientInfo":{"name":"other"}}}`)
	resp = c.recv()
	if resp["result"].(map[string]any)["protocolVersion"] != SupportedProtocolVersions[0] {
		t.Fatalf("unknown version must get the newest supported one, got %v", resp["result"])
	}
	backend.lock.Lock()
	defer backend.lock.Unlock()
	if len(backend.started) != 1 || backend.started[0].Name != "claude-code" || backend.started[0].Version != "2.1.0" {
		t.Fatalf("backend must start once with the first client info, got %v", backend.started)
	}
}

func TestToolsListAndCall(t *testing.T) {
	backend := &fakeBackend{}
	c := startServer(t, backend)
	c.send(`{"jsonrpc":"2.0","method":"notifications/initialized"}`)
	c.send(`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	resp := c.recv()
	tools := resp["result"].(map[string]any)["tools"].([]any)
	var names []string
	for _, raw := range tools {
		tool := raw.(map[string]any)
		names = append(names, tool["name"].(string))
		if tool["inputSchema"].(map[string]any)["type"] != "object" {
			t.Fatalf("tool %v: inputSchema must be an object schema", tool["name"])
		}
		if !strings.Contains(tool["description"].(string), "MoltenTerm") {
			t.Fatalf("tool %v: description must say what it drives", tool["name"])
		}
	}
	if strings.Join(names, ",") != "tabs_context,tabs_create,tabs_close" {
		t.Fatalf("tools = %v", names)
	}
	c.send(`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"tabs_close","arguments":{"tabId":4}}}`)
	resp = c.recv()
	result := resp["result"].(map[string]any)
	content := result["content"].([]any)[0].(map[string]any)
	if content["type"] != "text" || content["text"] != "ran tabs_close" {
		t.Fatalf("call result = %v", result)
	}
	if _, has := result["isError"]; has {
		t.Fatalf("a success has no isError: %v", result)
	}
	c.send(`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"tabs_create"}}`)
	c.recv()
	c.close()
	backend.lock.Lock()
	defer backend.lock.Unlock()
	if len(backend.calls) != 2 || backend.calls[0] != `tabs_close {"tabId":4}` || backend.calls[1] != "tabs_create {}" {
		t.Fatalf("calls = %v", backend.calls)
	}
	if !backend.closed {
		t.Fatalf("EOF must close the backend (ends the session)")
	}
	if len(backend.started) != 1 {
		t.Fatalf("a call before initialize starts the backend once, got %v", backend.started)
	}
}

func TestProtocolErrors(t *testing.T) {
	c := startServer(t, &fakeBackend{})
	defer c.close()
	cases := []struct {
		line string
		code int
		id   any
	}{
		{`{not json`, CodeParseError, nil},
		{`[{"jsonrpc":"2.0","id":1,"method":"ping"}]`, CodeInvalidRequest, nil},
		{`{"jsonrpc":"1.0","id":5,"method":"ping"}`, CodeInvalidRequest, float64(5)},
		{`{"jsonrpc":"2.0","id":6,"method":"resources/list"}`, CodeMethodNotFound, float64(6)},
		{`{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"javascript_tool","arguments":{}}}`, CodeInvalidParams, float64(7)},
		{`{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"tabs_close","arguments":[1]}}`, CodeInvalidParams, float64(8)},
		{`{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{}}`, CodeInvalidParams, float64(9)},
	}
	for _, tc := range cases {
		c.send(tc.line)
		resp := c.recv()
		if errorCode(resp) != tc.code {
			t.Fatalf("%s: code = %d, want %d (%v)", tc.line, errorCode(resp), tc.code, resp)
		}
		if resp["id"] != tc.id {
			t.Fatalf("%s: id = %v, want %v", tc.line, resp["id"], tc.id)
		}
	}
	c.send(`{"jsonrpc":"2.0","id":10,"method":"ping"}`)
	if resp := c.recv(); resp["error"] != nil || resp["result"] == nil {
		t.Fatalf("ping = %v", resp)
	}
}

func TestCancelledCallGetsNoResponse(t *testing.T) {
	backend := &fakeBackend{block: make(chan struct{})}
	c := startServer(t, backend)
	defer c.close()
	c.send(`{"jsonrpc":"2.0","id":"slow","method":"tools/call","params":{"name":"tabs_create","arguments":{}}}`)
	for {
		backend.lock.Lock()
		n := len(backend.calls)
		backend.lock.Unlock()
		if n == 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	c.send(`{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":"slow","reason":"user"}}`)
	c.send(`{"jsonrpc":"2.0","id":11,"method":"ping"}`)
	resp := c.recv()
	if resp["id"] != float64(11) {
		t.Fatalf("the cancelled call must not be answered, got %v", resp)
	}
}

func TestOversizedLineIsRefused(t *testing.T) {
	c := startServer(t, &fakeBackend{})
	defer c.close()
	big := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"tabs_create","arguments":{"x":"` +
		strings.Repeat("a", MaxMessageBytes) + `"}}}`
	go c.send(big)
	resp := c.recv()
	if errorCode(resp) != CodeInvalidRequest {
		t.Fatalf("oversized line = %v", resp)
	}
	c.send(`{"jsonrpc":"2.0","id":2,"method":"ping"}`)
	if resp := c.recv(); resp["id"] != float64(2) {
		t.Fatalf("the server must keep reading after an oversized line, got %v", resp)
	}
}

func TestOfflineBackendAnswersNotInMoltenTerm(t *testing.T) {
	c := startServer(t, OfflineBackend{})
	defer c.close()
	c.send(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	if tools := c.recv()["result"].(map[string]any)["tools"].([]any); len(tools) != 3 {
		t.Fatalf("offline server must still list its tools, got %d", len(tools))
	}
	for i, name := range []string{"tabs_context", "tabs_create", "tabs_close"} {
		c.send(`{"jsonrpc":"2.0","id":` + string(rune('2'+i)) + `,"method":"tools/call","params":{"name":"` + name + `","arguments":{"tabId":1}}}`)
		result := c.recv()["result"].(map[string]any)
		content := result["content"].([]any)[0].(map[string]any)
		if result["isError"] != true || content["text"] != ErrNotInMoltenTerm {
			t.Fatalf("%s outside MoltenTerm = %v", name, result)
		}
	}
}
