// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
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
	if got := keptWorktreeLink(term(waveobj.MetaMapType{"view": "term", molten.WorktreeMetaKey: tree})); got != tree {
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
