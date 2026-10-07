// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mcpbrowser

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestReadingToolsSchemas(t *testing.T) {
	byName := map[string]ToolDef{}
	for _, tool := range Tools() {
		byName[tool.Name] = tool
	}
	required := map[string][]string{
		ToolNavigate:    {"tabId", "url"},
		ToolReadPage:    {"tabId"},
		ToolGetPageText: {"tabId"},
		ToolFind:        {"tabId", "query"},
		ToolComputer:    {"tabId", "action"},
	}
	for name, want := range required {
		tool, ok := byName[name]
		if !ok {
			t.Fatalf("missing tool %s", name)
		}
		got, _ := tool.InputSchema["required"].([]string)
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Fatalf("%s required = %v, want %v", name, got, want)
		}
		if tabId := tool.InputSchema["properties"].(map[string]any)["tabId"].(map[string]any); tabId["type"] != "integer" {
			t.Fatalf("%s: tabId must be an integer", name)
		}
		if !strings.Contains(tool.Description, "not from the user") {
			t.Fatalf("%s: the description must say page content is untrusted", name)
		}
		if name != ToolComputer && !strings.Contains(tool.Description, "untrusted-page-content") {
			t.Fatalf("%s: the description must name the envelope", name)
		}
		if !strings.Contains(tool.Description, "asks the user") {
			t.Fatalf("%s: the description must mention the site permission", name)
		}
	}
	readProps := byName[ToolReadPage].InputSchema["properties"].(map[string]any)
	for _, prop := range []string{"filter", "depth", "ref_id", "max_chars"} {
		if readProps[prop] == nil {
			t.Fatalf("read_page misses %s (Claude in Chrome's shape)", prop)
		}
	}
	actions := byName[ToolComputer].InputSchema["properties"].(map[string]any)["action"].(map[string]any)["enum"].([]string)
	want := "left_click,right_click,double_click,triple_click,hover,scroll,scroll_to,key,type,left_click_drag,screenshot,zoom,wait"
	if strings.Join(actions, ",") != want {
		t.Fatalf("computer's actions are Claude in Chrome's: %v", actions)
	}
	if !ToolNames()[ToolComputer] || ToolNames()["left_click"] {
		t.Fatalf("tool names")
	}
}

func TestInputToolsSchemas(t *testing.T) {
	byName := map[string]ToolDef{}
	for _, tool := range Tools() {
		byName[tool.Name] = tool
	}
	computerProps := byName[ToolComputer].InputSchema["properties"].(map[string]any)
	for _, prop := range []string{"coordinate", "ref", "modifiers", "text", "repeat", "scroll_direction", "scroll_amount", "start_coordinate", "action_summary"} {
		if computerProps[prop] == nil {
			t.Fatalf("computer misses %s (Claude in Chrome's shape)", prop)
		}
	}
	if computerProps["repeat"].(map[string]any)["maximum"] != 100 || computerProps["scroll_amount"].(map[string]any)["maximum"] != 10 {
		t.Fatalf("repeat and scroll_amount carry the spec's bounds")
	}
	required := map[string][]string{
		ToolFormInput: {"ref", "value", "tabId"},
		ToolResize:    {"width", "height", "tabId"},
		ToolBatch:     {"actions"},
	}
	for name, want := range required {
		tool, ok := byName[name]
		if !ok {
			t.Fatalf("missing tool %s", name)
		}
		got, _ := tool.InputSchema["required"].([]string)
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Fatalf("%s required = %v, want %v", name, got, want)
		}
	}
	for _, name := range []string{ToolComputer, ToolFormInput} {
		if !strings.Contains(byName[name].Description, "ask the user (Allow or Deny) every time") {
			t.Fatalf("%s: the description must say sensitive actions ask", name)
		}
	}
	if !strings.Contains(byName[ToolComputer].Description, "never MoltenTerm's interface or the computer") {
		t.Fatalf("computer: the description must say input reaches the page only")
	}
	items := byName[ToolBatch].InputSchema["properties"].(map[string]any)["actions"].(map[string]any)
	if items["maxItems"] != 50 || !strings.Contains(byName[ToolBatch].Description, "cannot be nested") {
		t.Fatalf("browser_batch: %v", items)
	}
	if !strings.Contains(ServerInstructions, "ask every time") {
		t.Fatalf("the server instructions must mention the confirmations")
	}
	if _, err := json.Marshal(Tools()); err != nil {
		t.Fatalf("tools must marshal: %v", err)
	}
}

func TestImageContentIsMcpShaped(t *testing.T) {
	result := toMcpResult(CallResult{Content: []ContentItem{
		{Type: ContentText, Text: "shot"},
		{Type: ContentImage, Data: "AAAA", MimeType: "image/jpeg"},
	}})
	data, _ := json.Marshal(result)
	if !strings.Contains(string(data), `{"type":"image","data":"AAAA","mimeType":"image/jpeg"}`) {
		t.Fatalf("image content = %s", data)
	}
}
