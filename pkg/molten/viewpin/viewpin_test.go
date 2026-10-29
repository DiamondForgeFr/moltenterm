// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package viewpin

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/reopen"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const repo = "https://github.com/DiamondForgeFr/moltenterm"

func TestPinnedKeepsTheTab(t *testing.T) {
	client := waveobj.MetaMapType{GlobalPinsMetaKey: []any{map[string]any{"id": "g1", "name": "Review"}}}
	cases := []struct {
		name string
		tab  waveobj.MetaMapType
		want bool
	}{
		{"temporary", waveobj.MetaMapType{}, false},
		{"pinned here", waveobj.MetaMapType{PinMetaKey: PinWorkspace, PinConfigMetaKey: map[string]any{"panes": []any{}}}, true},
		{"pinned here without a configuration", waveobj.MetaMapType{PinMetaKey: PinWorkspace}, false},
		{"pinned everywhere", waveobj.MetaMapType{GlobalPinMetaKey: "g1"}, true},
		{"a pin gone from the client", waveobj.MetaMapType{GlobalPinMetaKey: "g2"}, false},
	}
	for _, c := range cases {
		if got := Pinned(c.tab, client); got != c.want {
			t.Errorf("%s: Pinned = %v, want %v", c.name, got, c.want)
		}
	}
	if Pinned(waveobj.MetaMapType{GlobalPinMetaKey: "g1"}, nil) {
		t.Errorf("a client without pins keeps no instance")
	}
}

func TestPaneConfigKeepsWhatItShows(t *testing.T) {
	term := PaneConfig(waveobj.MetaMapType{"view": "term", "controller": "shell", "cmd:cwd": "/p", "molten:origin": "x"}, false, Project{RepoUrl: repo})
	if !reflect.DeepEqual(term, waveobj.MetaMapType{"view": "term", "controller": "shell"}) {
		t.Fatalf("terminal: %v", term)
	}
	agent := PaneConfig(waveobj.MetaMapType{"view": "term", "controller": "shell", "cmd:cwd": "/p", "connection": "box"}, true, Project{RepoUrl: repo})
	if agent[AgentSlotMetaKey] != true || agent["connection"] != "box" || agent["cmd:cwd"] != nil {
		t.Fatalf("agent slot: %v", agent)
	}
	page := PaneConfig(waveobj.MetaMapType{
		"view": "molten-browser", "url": repo + "/pulls",
		"molten:browser:tabs":    []any{map[string]any{"id": "a", "url": repo}, map[string]any{"id": "b", "url": "https://npmjs.com"}},
		"molten:browser:open:01": "x",
	}, false, Project{RepoUrl: repo})
	if page["url"] != RepoToken+"/pulls" || page["molten:browser:open:01"] != nil {
		t.Fatalf("page: %v", page)
	}
	tabs := page["molten:browser:tabs"].([]any)
	if tabs[0].(map[string]any)["url"] != RepoToken || tabs[1].(map[string]any)["url"] != "https://npmjs.com" {
		t.Fatalf("page tabs: %v", tabs)
	}
	other := PaneConfig(waveobj.MetaMapType{"view": "molten-browser", "url": repo + "-docs"}, false, Project{RepoUrl: repo})
	if other["url"] != repo+"-docs" {
		t.Fatalf("another repository stays: %v", other)
	}
}

func TestResolvePaneOnAnotherProject(t *testing.T) {
	other := "https://github.com/DiamondForgeFr/saasfoundry"
	page := ResolvePane(waveobj.MetaMapType{"view": "molten-browser", "url": RepoToken + "/pulls"}, Project{Dir: "/sf", RepoUrl: other})
	if page["url"] != other+"/pulls" || page["cmd:cwd"] != nil {
		t.Fatalf("page: %v", page)
	}
	term := ResolvePane(waveobj.MetaMapType{"view": "term", "controller": "shell"}, Project{Dir: "/sf", RepoUrl: other})
	if term["cmd:cwd"] != "/sf" {
		t.Fatalf("terminal: %v", term)
	}
	if ResolvePane(waveobj.MetaMapType{"view": "web", "url": RepoToken}, Project{})["url"] != StartPageUrl {
		t.Fatal("a project without a repository opens the start page, never GitHub's home page")
	}
}

func TestResolvePaneWithoutRemoteNeverOpensGitHubHome(t *testing.T) {
	meta := waveobj.MetaMapType{
		"view":             "molten-browser",
		"url":              RepoToken,
		browserTabsMetaKey: []any{map[string]any{"id": "t1", "url": RepoToken + "/pulls"}},
	}
	for _, p := range []Project{{}, {Dir: "/sf"}} {
		page := ResolvePane(meta, p)
		if page["url"] != StartPageUrl {
			t.Fatalf("project %+v: url %v", p, page["url"])
		}
		tabs, _ := page[browserTabsMetaKey].([]any)
		if len(tabs) != 1 || tabs[0].(map[string]any)["url"] != StartPageUrl {
			t.Fatalf("project %+v: tabs %v", p, tabs)
		}
	}
}

func TestStartPagePinsAsTheRepositoryPage(t *testing.T) {
	pinned := PaneConfig(waveobj.MetaMapType{"view": "molten-browser", "url": StartPageUrl}, false, Project{Dir: "/sf"})
	if pinned["url"] != RepoToken {
		t.Fatalf("pinned: %v", pinned)
	}
	other := "https://github.com/DiamondForgeFr/saasfoundry"
	if ResolvePane(pinned, Project{Dir: "/sf", RepoUrl: other})["url"] != other {
		t.Fatal("a project with a remote opens its repository")
	}
}

func TestCaptureFoldsAndRebuilds(t *testing.T) {
	tree := Node{Dir: "row", Children: []Node{
		{BlockId: "a"},
		{Dir: "column", Children: []Node{{BlockId: "b"}, {BlockId: "gone"}}},
		{BlockId: "c"},
	}}
	metas := map[string]waveobj.MetaMapType{
		"a": {"view": "term", "controller": "shell"},
		"b": {"view": "molten-project"},
		"c": {"view": "molten-browser", "url": repo},
	}
	cfg := Capture(tree, map[string]bool{"a": true}, Project{RepoUrl: repo}, func(id string) (waveobj.MetaMapType, bool) {
		m, ok := metas[id]
		return m, ok
	})
	if len(cfg.Panes) != 3 || len(cfg.Tree.Children) != 3 || cfg.Tree.Children[1].Pane == nil {
		t.Fatalf("config: %+v", cfg)
	}
	if cfg.Panes[0][AgentSlotMetaKey] != true || cfg.Panes[2]["url"] != RepoToken {
		t.Fatalf("panes: %v", cfg.Panes)
	}
	leaves := reopen.LayoutLeaves(LayoutRoot(cfg.Tree), "", func(id string) (map[string]any, bool) {
		for i := range cfg.Panes {
			if PaneBlockId(i) == id {
				return cfg.Panes[i], true
			}
		}
		return nil, false
	})
	if len(leaves) != 3 || leaves[1].Split != "right" || leaves[2].Split != "right" {
		t.Fatalf("leaves: %+v", leaves)
	}
}

func TestRepoWebUrl(t *testing.T) {
	if OriginUrlOf("[core]\n\tbare = false\n[remote \"origin\"]\n\turl = git@github.com:o/n.git\n") != "git@github.com:o/n.git" {
		t.Fatal("origin url")
	}
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	config := "[remote \"upstream\"]\n\turl = https://github.com/u/n\n[remote \"origin\"]\n\turl = https://github.com/o/n.git\n"
	if err := os.WriteFile(filepath.Join(dir, ".git", "config"), []byte(config), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := RepoWebUrl(dir); got != "https://github.com/o/n" {
		t.Fatalf("repo: %q", got)
	}
	wt := t.TempDir()
	if err := os.WriteFile(filepath.Join(wt, ".git"), []byte("gitdir: "+filepath.Join(dir, ".git")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := RepoWebUrl(wt); got != "https://github.com/o/n" {
		t.Fatalf("worktree repo: %q", got)
	}
	if RepoWebUrl(t.TempDir()) != "" {
		t.Fatal("no clone")
	}
}

func TestFileViewFollowsTheProject(t *testing.T) {
	cfg := PaneConfig(waveobj.MetaMapType{"view": "preview", "file": "/a/proj/docs"}, false, Project{Dir: "/a/proj/"})
	if cfg["file"] != ProjectToken+"/docs" {
		t.Fatalf("config: %v", cfg)
	}
	if PaneConfig(waveobj.MetaMapType{"view": "preview", "file": "/a/project2"}, false, Project{Dir: "/a/proj"})["file"] != "/a/project2" {
		t.Fatal("a sibling folder stays")
	}
	if ResolvePane(cfg, Project{Dir: "/b/other"})["file"] != "/b/other/docs" {
		t.Fatal("resolved on another project")
	}
	if ResolvePane(waveobj.MetaMapType{"view": "preview", "file": ProjectToken}, Project{})["file"] != "~" {
		t.Fatal("no project: home")
	}
}

func TestPageTitleGoesWithItsAddress(t *testing.T) {
	tabs := []any{map[string]any{"url": repo, "title": "old"}}
	cfg := PaneConfig(waveobj.MetaMapType{"view": "molten-browser", "molten:browser:tabs": tabs}, false, Project{RepoUrl: repo})
	tab := cfg["molten:browser:tabs"].([]any)[0].(map[string]any)
	if tab["title"] != nil || tab["url"] != RepoToken {
		t.Fatalf("tab: %v", tab)
	}
}
