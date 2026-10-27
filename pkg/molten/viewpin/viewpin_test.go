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

func TestPaneConfigKeepsWhatItShows(t *testing.T) {
	term := PaneConfig(waveobj.MetaMapType{"view": "term", "controller": "shell", "cmd:cwd": "/p", "molten:origin": "x"}, false, repo)
	if !reflect.DeepEqual(term, waveobj.MetaMapType{"view": "term", "controller": "shell"}) {
		t.Fatalf("terminal: %v", term)
	}
	agent := PaneConfig(waveobj.MetaMapType{"view": "term", "controller": "shell", "cmd:cwd": "/p", "connection": "box"}, true, repo)
	if agent[AgentSlotMetaKey] != true || agent["connection"] != "box" || agent["cmd:cwd"] != nil {
		t.Fatalf("agent slot: %v", agent)
	}
	page := PaneConfig(waveobj.MetaMapType{
		"view": "molten-browser", "url": repo + "/pulls",
		"molten:browser:tabs":    []any{map[string]any{"id": "a", "url": repo}, map[string]any{"id": "b", "url": "https://npmjs.com"}},
		"molten:browser:open:01": "x",
	}, false, repo)
	if page["url"] != RepoToken+"/pulls" || page["molten:browser:open:01"] != nil {
		t.Fatalf("page: %v", page)
	}
	tabs := page["molten:browser:tabs"].([]any)
	if tabs[0].(map[string]any)["url"] != RepoToken || tabs[1].(map[string]any)["url"] != "https://npmjs.com" {
		t.Fatalf("page tabs: %v", tabs)
	}
	other := PaneConfig(waveobj.MetaMapType{"view": "molten-browser", "url": repo + "-docs"}, false, repo)
	if other["url"] != repo+"-docs" {
		t.Fatalf("another repository stays: %v", other)
	}
}

func TestResolvePaneOnAnotherProject(t *testing.T) {
	other := "https://github.com/DiamondForgeFr/saasfoundry"
	page := ResolvePane(waveobj.MetaMapType{"view": "molten-browser", "url": RepoToken + "/pulls"}, "/sf", other)
	if page["url"] != other+"/pulls" || page["cmd:cwd"] != nil {
		t.Fatalf("page: %v", page)
	}
	term := ResolvePane(waveobj.MetaMapType{"view": "term", "controller": "shell"}, "/sf", other)
	if term["cmd:cwd"] != "/sf" {
		t.Fatalf("terminal: %v", term)
	}
	if ResolvePane(waveobj.MetaMapType{"view": "web", "url": RepoToken}, "", "")["url"] != "https://github.com" {
		t.Fatal("a project without a repository opens GitHub")
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
	cfg := Capture(tree, map[string]bool{"a": true}, repo, func(id string) (waveobj.MetaMapType, bool) {
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
