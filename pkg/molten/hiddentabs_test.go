// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"slices"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func hiddenWs(tabs []string, hidden []any) *waveobj.Workspace {
	return &waveobj.Workspace{TabIds: tabs, Meta: waveobj.MetaMapType{HiddenTabsMetaKey: hidden}}
}

func TestHiddenTabIdsKeepsTheWorkspacesTabsOnly(t *testing.T) {
	ws := hiddenWs([]string{"a", "b", "c"}, []any{"c", "gone", 3})
	if got := HiddenTabIds(ws); !slices.Equal(got, []string{"c"}) {
		t.Errorf("hidden %v", got)
	}
	if !IsHiddenTab(ws, "c") || IsHiddenTab(ws, "a") {
		t.Errorf("IsHiddenTab")
	}
}

func TestRevealTab(t *testing.T) {
	ws := hiddenWs([]string{"a", "b", "c"}, []any{"b", "c"})
	if !RevealTab(ws, "b") || !slices.Equal(HiddenTabIds(ws), []string{"c"}) {
		t.Errorf("hidden after reveal: %v", HiddenTabIds(ws))
	}
	if RevealTab(ws, "a") {
		t.Errorf("a shown tab is not revealed")
	}
	RevealTab(ws, "c")
	if _, ok := ws.Meta[HiddenTabsMetaKey]; ok {
		t.Errorf("an empty list leaves the meta")
	}
}

// A drag in a tab bar sends the shown tabs only: the hidden ones stay in the workspace.
func TestKeepHiddenTabs(t *testing.T) {
	ws := hiddenWs([]string{"a", "h", "b"}, []any{"h"})
	if got := KeepHiddenTabs(ws, []string{"b", "a"}); !slices.Equal(got, []string{"b", "a", "h"}) {
		t.Errorf("tabs %v", got)
	}
	if got := KeepHiddenTabs(ws, []string{"h", "b", "a"}); !slices.Equal(got, []string{"h", "b", "a"}) {
		t.Errorf("a list that has it is kept as sent: %v", got)
	}
}

func TestVisibleNeighbour(t *testing.T) {
	tabs := []string{"a", "h1", "b", "h2"}
	hidden := []string{"h1", "h2"}
	cases := []struct {
		idx  int
		want string
	}{{0, "a"}, {1, "a"}, {2, "a"}, {3, "b"}, {4, "b"}}
	for _, c := range cases {
		if got := VisibleNeighbour(tabs, hidden, c.idx); got != c.want {
			t.Errorf("idx %d: %q, want %q", c.idx, got, c.want)
		}
	}
	if got := VisibleNeighbour([]string{"h1"}, hidden, 0); got != "" {
		t.Errorf("only hidden tabs: %q", got)
	}
	if got := VisibleNeighbour([]string{"h1", "b"}, []string{"h1"}, 0); got != "b" {
		t.Errorf("the right side: %q", got)
	}
}
