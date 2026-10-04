// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestKeptWorktreeLink(t *testing.T) {
	_, clone, tree := makeWorktreeFixture(t)
	term := func(meta waveobj.MetaMapType) *waveobj.Block {
		return &waveobj.Block{OID: "b1", Meta: meta}
	}
	if got := keptWorktreeLink(term(waveobj.MetaMapType{"view": "term", molten.WorktreeMetaKey: tree})); got != realPath(tree) {
		t.Fatalf("a local terminal linked to a worktree: %q", got)
	}
	cases := map[string]*waveobj.Block{
		"no block":          nil,
		"no link":           term(waveobj.MetaMapType{"view": "term"}),
		"not a terminal":    term(waveobj.MetaMapType{"view": "preview", molten.WorktreeMetaKey: tree}),
		"remote":            term(waveobj.MetaMapType{"view": "term", "connection": "user@host", molten.WorktreeMetaKey: tree}),
		"relative link":     term(waveobj.MetaMapType{"view": "term", molten.WorktreeMetaKey: "wt"}),
		"main tree as link": term(waveobj.MetaMapType{"view": "term", molten.WorktreeMetaKey: clone}),
		"removed worktree":  term(waveobj.MetaMapType{"view": "term", molten.WorktreeMetaKey: tree + "-gone"}),
	}
	for name, block := range cases {
		if got := keptWorktreeLink(block); got != "" {
			t.Errorf("%s: %q", name, got)
		}
	}
}

func TestKeptWorktreeNotice(t *testing.T) {
	n := keptWorktreeNotice("/repos/app-wt-fix", "ws1", "tab1")
	if n.Key != "worktree:kept:/repos/app-wt-fix" || n.Title != "Worktree app-wt-fix is still on disk" {
		t.Fatalf("notice: %+v", n)
	}
	if n.WorkspaceId != "ws1" || n.TabId != "tab1" || !strings.Contains(n.Message, "/repos/app-wt-fix") {
		t.Fatalf("notice location: %+v", n)
	}
	if len(n.Actions) != 1 || n.Actions[0].Kind != "gesture" || n.Actions[0].Gesture != WorktreeReviewGesture ||
		n.Actions[0].Args["path"] != "/repos/app-wt-fix" || n.Actions[0].Label != "Review and remove…" {
		t.Fatalf("notice action: %+v", n.Actions)
	}
}

// One worktree is one notice, whatever path its terminals were linked by (a symlink to it, a trailing slash); the
// terminals of a closed workspace give one notice per worktree they leave (#134).
func TestKeptWorktreesOnePerCanonicalPath(t *testing.T) {
	base, _, tree := makeWorktreeFixture(t)
	other := filepath.Join(base, "wt2")
	gitRun(t, filepath.Join(base, "clone"), "worktree", "add", "-q", "-b", "feature/6-y", other)
	alias := filepath.Join(base, "alias")
	if err := os.Symlink(tree, alias); err != nil {
		t.Fatal(err)
	}
	term := func(id string, link string) *waveobj.Block {
		return &waveobj.Block{OID: id, Meta: waveobj.MetaMapType{"view": "term", molten.WorktreeMetaKey: link}}
	}
	blocks := []*waveobj.Block{
		term("b1", tree),
		term("b2", alias),
		term("b3", tree+"/"),
		{OID: "b4", Meta: waveobj.MetaMapType{"view": "preview"}},
		term("b5", other),
		term("b6", tree+"-gone"),
	}
	got := keptWorktrees(blocks)
	want := []string{realPath(tree), realPath(other)}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("kept worktrees: %v, want %v", got, want)
	}
	if len(keptWorktrees(nil)) != 0 {
		t.Fatal("no block, no worktree")
	}
}

// Plans and removals name the worktree by its canonical path, so the windows can group rows and resolve notices.
func TestWorktreePlanTellsTheCanonicalPath(t *testing.T) {
	base, _, tree := makeWorktreeFixture(t)
	alias := filepath.Join(base, "alias")
	if err := os.Symlink(tree, alias); err != nil {
		t.Fatal(err)
	}
	w := MakeWorktrees(plainRunner, noTerminals)
	byLink, err := w.Plan(WorktreeRequest{Dir: alias})
	if err != nil {
		t.Fatal(err)
	}
	direct, _ := w.Plan(WorktreeRequest{Dir: tree})
	if byLink.Real == "" || byLink.Real != direct.Real || byLink.Real != realPath(tree) {
		t.Fatalf("canonical paths: %q %q", byLink.Real, direct.Real)
	}
	res, err := w.Remove(WorktreeRemoveRequest{Dir: tree})
	if err != nil || res.Real != realPath(tree) {
		t.Fatalf("removal: %+v %v", res, err)
	}
}
