// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package viewpin

import (
	"reflect"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestCopyPaneKeepsWhereThePanelIs(t *testing.T) {
	t.Parallel()
	page := CopyPane(waveobj.MetaMapType{
		"view": "molten-browser", "url": repo + "/pulls",
		"molten:browser:tabs":    []any{map[string]any{"id": "a", "url": repo}, map[string]any{"id": "b", "url": StartPageUrl}},
		"molten:browser:open:01": "x",
	}, false)
	if page["url"] != repo+"/pulls" {
		t.Fatalf("a copy of a page keeps its exact address, never the repository's token: %v", page)
	}
	tabs := page["molten:browser:tabs"].([]any)
	if tabs[0].(map[string]any)["url"] != repo || tabs[1].(map[string]any)["url"] != StartPageUrl {
		t.Fatalf("the page's own tabs keep their addresses: %v", tabs)
	}
	if page["molten:browser:open:01"] != nil {
		t.Fatalf("what belongs to one moment stays out of a copy: %v", page)
	}
	start := CopyPane(waveobj.MetaMapType{"view": "web", "url": StartPageUrl}, false)
	if start["url"] != StartPageUrl {
		t.Fatalf("the start page stays the start page: %v", start)
	}
	term := CopyPane(waveobj.MetaMapType{"view": "term", "controller": "shell", "cmd:cwd": "/p/sub", "molten:origin": "x"}, false)
	if !reflect.DeepEqual(term, waveobj.MetaMapType{"view": "term", "controller": "shell", "cmd:cwd": "/p/sub"}) {
		t.Fatalf("a copy of a terminal keeps its folder: %v", term)
	}
	files := CopyPane(waveobj.MetaMapType{"view": "preview", "file": "/p/sub/readme.md"}, false)
	if files["file"] != "/p/sub/readme.md" {
		t.Fatalf("a copy of a file panel keeps its path: %v", files)
	}
}

func TestCopyPaneOfAnAgentIsASlotThatWaits(t *testing.T) {
	t.Parallel()
	agent := CopyPane(waveobj.MetaMapType{"view": "term", "controller": "shell", "cmd:cwd": "/p", "connection": "box"}, true)
	if agent[AgentSlotMetaKey] != true || agent["connection"] != "box" || agent["cmd:cwd"] != nil {
		t.Fatalf("an agent runs in the panel it started in: its copy is an empty slot, %v", agent)
	}
}

func TestCopyIsNotAPin(t *testing.T) {
	t.Parallel()
	meta := waveobj.MetaMapType{"view": "term", "controller": "shell", "cmd:cwd": "/p/sub"}
	pinned := PaneConfig(meta, false, Project{Dir: "/p"})
	if pinned["cmd:cwd"] != nil {
		t.Fatalf("a pinned configuration never carries a terminal's folder: %v", pinned)
	}
	if ResolvePane(pinned, Project{Dir: "/other"})["cmd:cwd"] != "/other" {
		t.Fatal("a pinned terminal opens on the project it is shown on")
	}
	copied := ResolvePane(CopyPane(meta, false), Project{Dir: "/other"})
	if copied["cmd:cwd"] != "/p/sub" {
		t.Fatalf("a copy opens where the panel was, whatever the project: %v", copied)
	}
}

func TestCaptureCopyOfOnePanel(t *testing.T) {
	t.Parallel()
	panels := map[string]waveobj.MetaMapType{
		"b1": {"view": "term", "controller": "shell", "cmd:cwd": "/p/sub"},
		"b2": {"view": "molten-browser", "url": repo + "/issues"},
	}
	metaOf := func(id string) (waveobj.MetaMapType, bool) {
		m, ok := panels[id]
		return m, ok
	}
	cfg := CaptureCopy(Node{BlockId: "b1"}, map[string]bool{}, metaOf)
	if len(cfg.Panes) != 1 || cfg.Tree.Pane == nil || *cfg.Tree.Pane != 0 || cfg.Panes[0]["cmd:cwd"] != "/p/sub" {
		t.Fatalf("one panel, one pane, its folder kept: %+v", cfg)
	}
	if len(CaptureCopy(Node{BlockId: "gone"}, nil, metaOf).Panes) != 0 {
		t.Fatal("a panel that is gone leaves nothing to copy")
	}
	whole := Capture(Node{Dir: "row", Children: []Node{{BlockId: "b1"}, {BlockId: "b2"}}}, nil, Project{Dir: "/p", RepoUrl: repo}, metaOf)
	if len(whole.Panes) != 2 || whole.Panes[1]["url"] != RepoToken+"/issues" {
		t.Fatalf("a pinned capture still names the repository by its token: %+v", whole)
	}
}

func TestCheckAdopt(t *testing.T) {
	t.Parallel()
	if err := CheckAdopt(BuildRequest{}); err != nil {
		t.Fatalf("a build that adopts nothing is fine: %v", err)
	}
	if err := CheckAdopt(BuildRequest{AdoptBlockId: "b1", AdoptFromTabId: "t1"}); err != nil {
		t.Fatalf("a panel moved into a new view: %v", err)
	}
	if CheckAdopt(BuildRequest{AdoptBlockId: "b1"}) == nil {
		t.Fatal("a panel moved in must say the view it leaves")
	}
	if CheckAdopt(BuildRequest{AdoptBlockId: "b1", AdoptFromTabId: "t1", TabId: "t2"}) == nil {
		t.Fatal("a panel never moves into an existing view this way")
	}
}
