// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"encoding/json"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/viewpin"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

func treeJson(t *testing.T, n viewpin.Node) string {
	t.Helper()
	barr, err := json.Marshal(n)
	if err != nil {
		t.Fatalf("marshal tree: %v", err)
	}
	return string(barr)
}

func TestWorkspaceViewConfigAgentLeftGraphicsRight(t *testing.T) {
	cfg, ok := WorkspaceViewConfig([]string{"browser", "agent", "files"})
	if !ok || len(cfg.Panes) != 3 {
		t.Fatalf("config %+v %v", cfg, ok)
	}
	if cfg.Panes[1][viewpin.AgentSlotMetaKey] != true || cfg.Panes[1]["view"] != "term" {
		t.Fatalf("the agent is a terminal agent slot: %v", cfg.Panes[1])
	}
	if cfg.Panes[0]["view"] != "molten-browser" || cfg.Panes[0]["url"] != viewpin.RepoToken {
		t.Fatalf("browser %v", cfg.Panes[0])
	}
	if cfg.Panes[2]["view"] != "preview" || cfg.Panes[2]["file"] != viewpin.ProjectToken {
		t.Fatalf("files %v", cfg.Panes[2])
	}
	want := `{"dir":"row","children":[{"pane":1},{"dir":"column","children":[{"pane":0},{"pane":2}]}]}`
	if got := treeJson(t, cfg.Tree); got != want {
		t.Fatalf("tree %s, want %s", got, want)
	}
}

func TestWorkspaceViewConfigWithoutAgent(t *testing.T) {
	cfg, ok := WorkspaceViewConfig([]string{"project", "nope", "integration"})
	if !ok || len(cfg.Panes) != 2 {
		t.Fatalf("config %+v %v", cfg, ok)
	}
	if cfg.Panes[0]["view"] != "molten-project" || cfg.Panes[1]["view"] != "molten-reviews" {
		t.Fatalf("panes %v", cfg.Panes)
	}
	want := `{"dir":"row","children":[{"pane":0},{"pane":1}]}`
	if got := treeJson(t, cfg.Tree); got != want {
		t.Fatalf("tree %s, want %s", got, want)
	}
	one, _ := WorkspaceViewConfig([]string{"terminal"})
	if got := treeJson(t, one.Tree); got != `{"pane":0}` {
		t.Fatalf("one panel %s", got)
	}
	if _, ok := WorkspaceViewConfig([]string{"nope"}); ok {
		t.Fatalf("a view without a known panel is skipped")
	}
}

func TestWorkspaceViewTabs(t *testing.T) {
	tabs := workspaceViewTabs([]wconfig.NewWorkspaceViewType{
		{NameKey: "workspaceViews.names.scoping", Panels: []string{"agent", "browser", "files"}},
		{Name: "Mine", Panels: []string{"terminal"}},
		{Panels: []string{"cicd"}},
		{Name: "Empty", Panels: []string{"nope"}},
	})
	if len(tabs) != 3 {
		t.Fatalf("tabs %+v", tabs)
	}
	first := tabs[0]
	if first.Name != "workspaceViews.names.scoping" || first.Meta[ViewNameKeyMetaKey] != first.Name {
		t.Fatalf("a key-named view %+v", first)
	}
	if first.Meta[viewpin.PinMetaKey] != viewpin.PinWorkspace || first.Meta[ViewPendingMetaKey] != true {
		t.Fatalf("pinned in the workspace and pending %+v", first.Meta)
	}
	if !viewpin.Pinned(first.Meta, nil) {
		t.Fatalf("the view counts as pinned, so it stays without panels")
	}
	cfg, _ := first.Meta[viewpin.PinConfigMetaKey].(map[string]any)
	if panes, _ := cfg["panes"].([]any); len(panes) != 3 {
		t.Fatalf("stored configuration %v", cfg)
	}
	if tabs[1].Name != "Mine" || tabs[1].Meta[ViewNameKeyMetaKey] != nil {
		t.Fatalf("a typed name stays as typed %+v", tabs[1])
	}
	if tabs[2].Name != DefaultViewNameKey || tabs[2].Meta[ViewNameKeyMetaKey] != DefaultViewNameKey {
		t.Fatalf("a view without a name %+v", tabs[2])
	}
	if len(workspaceViewTabs(nil)) != 0 {
		t.Fatalf("an empty template gives no view")
	}
}
