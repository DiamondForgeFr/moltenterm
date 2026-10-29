// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"slices"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func activate(ws *waveobj.Workspace, next string) {
	RememberActiveTab(ws, next)
	ws.ActiveTabId = next
}

func TestTabHistoryKeepsTheLatestFirst(t *testing.T) {
	ws := &waveobj.Workspace{TabIds: []string{"a", "b", "c"}, ActiveTabId: "a"}
	activate(ws, "b")
	activate(ws, "c")
	if got := TabHistory(ws); !slices.Equal(got, []string{"b", "a"}) {
		t.Fatalf("history: got %v", got)
	}
	activate(ws, "a")
	if got := TabHistory(ws); !slices.Equal(got, []string{"c", "b"}) {
		t.Fatalf("a view comes out of the history once shown: got %v", got)
	}
}

func TestTabHistoryDropsClosedViewsAndCaps(t *testing.T) {
	ids := []string{}
	for i := 0; i < TabHistoryMax+5; i++ {
		ids = append(ids, string(rune('a'+i)))
	}
	ws := &waveobj.Workspace{TabIds: slices.Clone(ids), ActiveTabId: ids[0]}
	for _, id := range ids[1:] {
		activate(ws, id)
	}
	if got := len(ws.Meta[TabHistoryMetaKey].([]string)); got != TabHistoryMax {
		t.Fatalf("stored history: got %d, want %d", got, TabHistoryMax)
	}
	ws.TabIds = slices.DeleteFunc(ws.TabIds, func(id string) bool { return id == ids[len(ids)-2] })
	if got := TabHistory(ws); slices.Contains(got, ids[len(ids)-2]) {
		t.Fatalf("a closed view stays in the history: %v", got)
	}
}

func TestPreviousShownTabSkipsHiddenTabs(t *testing.T) {
	ws := &waveobj.Workspace{TabIds: []string{"a", "agent", "c"}, ActiveTabId: "a"}
	activate(ws, "agent")
	activate(ws, "c")
	if got := PreviousShownTab(ws, nil); got != "agent" {
		t.Fatalf("got %q, want agent", got)
	}
	if got := PreviousShownTab(ws, []string{"agent"}); got != "a" {
		t.Fatalf("got %q, want a", got)
	}
	if got := PreviousShownTab(&waveobj.Workspace{TabIds: []string{"a"}}, nil); got != "" {
		t.Fatalf("no history: got %q", got)
	}
}

func TestTabHistoryReadsWhatTheDatabaseStores(t *testing.T) {
	ws := &waveobj.Workspace{
		TabIds: []string{"a", "b"},
		Meta:   waveobj.MetaMapType{TabHistoryMetaKey: []any{"b", "gone", "a"}},
	}
	if got := TabHistory(ws); !slices.Equal(got, []string{"b", "a"}) {
		t.Fatalf("got %v", got)
	}
}
