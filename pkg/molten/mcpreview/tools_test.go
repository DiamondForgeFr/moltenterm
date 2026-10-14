// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mcpreview

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
)

// DS-REV-005: the read tools are read-only, no tool publishes, approves, merges or writes files, names are unique.
func TestReviewTools(t *testing.T) {
	seen := map[string]bool{}
	readTools := map[string]bool{ToolContext: true, ToolFiles: true, ToolDiff: true, ToolSelection: true}
	for _, tool := range Tools() {
		if seen[tool.Name] {
			t.Errorf("duplicate tool %s", tool.Name)
		}
		seen[tool.Name] = true
		if tool.Annotations == nil || tool.Annotations.ReadOnlyHint != readTools[tool.Name] || tool.Annotations.DestructiveHint || tool.Annotations.OpenWorldHint {
			t.Errorf("%s annotations %+v", tool.Name, tool.Annotations)
		}
		for _, word := range []string{"merge", "approve", "publish", "push", "write"} {
			if strings.Contains(tool.Name, word) {
				t.Errorf("tool %s may %s", tool.Name, word)
			}
		}
		if tool.InputSchema["type"] != "object" {
			t.Errorf("%s schema %v", tool.Name, tool.InputSchema)
		}
	}
	if len(seen) != 9 || !ToolNames()[ToolKeepNote] {
		t.Errorf("tools %v", seen)
	}
}

type offline struct{}

func (offline) Start(ctx context.Context, client mcpbrowser.ClientInfo) {}
func (offline) CallTool(ctx context.Context, tool string, args json.RawMessage) mcpbrowser.CallResult {
	return mcpbrowser.ErrorResult(ErrNotInMoltenTerm)
}
func (offline) Close() {}

// FR-REV-004 AC2: `molten mcp review` answers initialize as molten-review and lists the review tools only.
func TestReviewServerSpec(t *testing.T) {
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	server := mcpbrowser.MakeSpecServer(Spec(), offline{}, inR, outW, "test")
	go func() {
		server.Serve(context.Background())
		outW.Close()
	}()
	scanner := bufio.NewScanner(outR)
	scanner.Buffer(make([]byte, 1024*1024), 8*1024*1024)
	exchange := func(line string) map[string]any {
		t.Helper()
		inW.Write([]byte(line + "\n"))
		if !scanner.Scan() {
			t.Fatal("no response")
		}
		var msg map[string]any
		if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil {
			t.Fatal(err)
		}
		return msg
	}
	init := exchange(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"claude-code"}}}`)
	result := init["result"].(map[string]any)
	if result["serverInfo"].(map[string]any)["name"] != ServerName || !strings.Contains(result["instructions"].(string), "Nothing you do publishes") {
		t.Fatalf("initialize %v", result)
	}
	list := exchange(`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	tools := list["result"].(map[string]any)["tools"].([]any)
	if len(tools) != len(Tools()) || tools[0].(map[string]any)["name"] != ToolContext {
		t.Fatalf("tools %v", tools)
	}
	browser := exchange(`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"navigate","arguments":{}}}`)
	if browser["error"] == nil {
		t.Fatalf("a browser tool was accepted: %v", browser)
	}
	call := exchange(`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"review_context","arguments":{}}}`)
	content := call["result"].(map[string]any)["content"].([]any)[0].(map[string]any)
	if content["text"] != ErrNotInMoltenTerm {
		t.Fatalf("offline call %v", call)
	}
	inW.Close()
}
