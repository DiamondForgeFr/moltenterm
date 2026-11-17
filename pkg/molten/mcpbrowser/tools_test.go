// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

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

// tabs_show (#1994) is one tool of the server, so Claude Code and Codex list it alike; it names a tab and nothing else.
func TestTabsShowToolBringsAPageInFrontOfTheUser(t *testing.T) {
	var found *ToolDef
	for _, tool := range Tools() {
		if tool.Name == ToolTabsShow {
			found = &tool
		}
	}
	if found == nil || !ToolNames()[ToolTabsShow] {
		t.Fatal("tabs_show is not one of the server's tools")
	}
	required, _ := found.InputSchema["required"].([]string)
	props := found.InputSchema["properties"].(map[string]any)
	if strings.Join(required, ",") != "tabId" || len(props) != 1 || props["tabId"].(map[string]any)["type"] != "integer" {
		t.Fatalf("tabs_show takes the id of a tab and nothing else: %v", found.InputSchema)
	}
	for _, want := range []string{"in front of the user", "Keyboard focus never moves", "asks no site permission", "do not repeat"} {
		if !strings.Contains(found.Description, want) {
			t.Fatalf("the description lacks %q: %s", want, found.Description)
		}
	}
	if !strings.Contains(ServerInstructions, "tabs_show") {
		t.Fatalf("the server instructions must name tabs_show")
	}
}

// tabs_create takes an address and reuses a page that is already open (#2333): one tool of the one server, so Claude Code
// and Codex learn the same words from the same description and instructions.
func TestTabsCreateReusesOpenPagesAndTheToolsSayHow(t *testing.T) {
	byName := map[string]ToolDef{}
	for _, tool := range Tools() {
		byName[tool.Name] = tool
	}
	create := byName[ToolTabsCreate]
	props := create.InputSchema["properties"].(map[string]any)
	if props["url"].(map[string]any)["type"] != "string" || props["reload"].(map[string]any)["type"] != "boolean" || props["newTab"].(map[string]any)["type"] != "boolean" {
		t.Fatalf("tabs_create takes url, reload and newTab: %v", props)
	}
	if required, _ := create.InputSchema["required"].([]string); len(required) != 0 {
		t.Fatalf("tabs_create still opens an empty tab without arguments: %v", required)
	}
	for _, want := range []string{"already open", "reused tab N", "opened tab N", "newTab: true", "reload: true", "waiting for the developer", "asked for on its bar"} {
		if !strings.Contains(create.Description, want) {
			t.Fatalf("tabs_create's description lacks %q: %s", want, create.Description)
		}
	}
	for _, want := range []string{"otherPages", "tabs_create with its address", "Call tabs_context before opening a page", "without credentials"} {
		if !strings.Contains(byName[ToolTabsContext].Description, want) {
			t.Fatalf("tabs_context's description lacks %q: %s", want, byName[ToolTabsContext].Description)
		}
	}
	if !strings.Contains(byName[ToolNavigate].Description, "reload") || !strings.Contains(byName[ToolNavigate].InputSchema["properties"].(map[string]any)["url"].(map[string]any)["description"].(string), "reload") {
		t.Fatalf("navigate loads a page again with \"reload\"")
	}
	for _, name := range []string{"Claude Code", "Codex", ""} {
		got := ServerInstructions + AgentInstructions(name)
		for _, want := range []string{"call tabs_context", "reuses a page that is already open", "newTab: true", "reload", "`molten open`", "--new-tab", "pages.md"} {
			if !strings.Contains(got, want) {
				t.Fatalf("the instructions for %q lack %q", name, want)
			}
		}
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
