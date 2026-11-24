// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wcore

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/contextpins"
	"github.com/wavetermdev/waveterm/pkg/molten/contexts"
	"github.com/wavetermdev/waveterm/pkg/molten/projectviews"
	"github.com/wavetermdev/waveterm/pkg/molten/viewpin"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func terminalPin(id string) map[string]any {
	return map[string]any{
		"id": id, "name": "Terminal", "rev": float64(2),
		"config": map[string]any{"tree": map[string]any{"pane": float64(0)}, "panes": []any{map[string]any{"view": "term", "controller": "shell"}}},
	}
}

func setClientMeta(t *testing.T, ctx context.Context, patch waveobj.MetaMapType) {
	t.Helper()
	client, err := wstore.DBGetSingleton[*waveobj.Client](ctx)
	if err != nil || client == nil {
		t.Fatalf("client: %v", err)
	}
	client.Meta = waveobj.MergeMeta(client.Meta, patch, false)
	if err := wstore.DBUpdate(ctx, client); err != nil {
		t.Fatal(err)
	}
}

func clientMetaOf(t *testing.T, ctx context.Context) waveobj.MetaMapType {
	t.Helper()
	client, err := wstore.DBGetSingleton[*waveobj.Client](ctx)
	if err != nil || client == nil {
		t.Fatalf("client: %v", err)
	}
	return client.Meta
}

func twoContexts() waveobj.MetaMapType {
	return waveobj.MetaMapType{contexts.ClientMetaKey: contexts.MetaValue([]contexts.Context{
		{Id: "a", Name: "Client"},
		{Id: "b", Name: "Personal"},
	})}
}

// #2526: the one row an earlier version kept is copied into every context, once.
func TestTheFormerTopRowIsCopiedIntoEveryContextOnce(t *testing.T) {
	ctx, _ := initContextsFixture(t)
	patch := twoContexts()
	patch[contextpins.LegacyMetaKey] = []any{terminalPin("g1"), terminalPin("g2")}
	setClientMeta(t, ctx, patch)

	if err := MigrateContextPins(ctx); err != nil {
		t.Fatal(err)
	}
	meta := clientMetaOf(t, ctx)
	for _, id := range []string{"a", "b"} {
		if got := pinIds(contextpins.PinsOf(meta, id)); len(got) != 2 || got[0] != "g1" || got[1] != "g2" {
			t.Fatalf("context %s holds %v, want g1 and g2", id, got)
		}
	}
	if _, ok := meta[contextpins.LegacyMetaKey]; ok {
		t.Fatalf("the former row stayed in the client meta")
	}

	setClientMeta(t, ctx, waveobj.MetaMapType{contextpins.MetaKey("a"): []any{terminalPin("g2")}})
	setClientMeta(t, ctx, waveobj.MetaMapType{contextpins.LegacyMetaKey: []any{terminalPin("g9")}})
	if err := MigrateContextPins(ctx); err != nil {
		t.Fatal(err)
	}
	meta = clientMetaOf(t, ctx)
	if got := pinIds(contextpins.PinsOf(meta, "a")); len(got) != 1 || got[0] != "g2" {
		t.Fatalf("a second start changed context a's row: %v", got)
	}
	if got := pinIds(contextpins.PinsOf(meta, "b")); len(got) != 2 {
		t.Fatalf("a second start changed context b's row: %v", got)
	}
}

func TestAnInstallationThatNeverUsedContextsKeepsItsRowInTheFirstOne(t *testing.T) {
	ctx, _ := initContextsFixture(t)
	setClientMeta(t, ctx, waveobj.MetaMapType{contextpins.LegacyMetaKey: []any{terminalPin("g1")}})
	if err := MigrateContextPins(ctx); err != nil {
		t.Fatal(err)
	}
	meta := clientMetaOf(t, ctx)
	if got := pinIds(contextpins.PinsOf(meta, contexts.DefaultId)); len(got) != 1 || got[0] != "g1" {
		t.Fatalf("the first context holds %v, want g1", got)
	}
	if contexts.Stored(meta) {
		t.Fatalf("the migration wrote a list of contexts: %v", meta[contexts.ClientMetaKey])
	}
}

func TestAWorkspaceReadsTheRowOfItsContext(t *testing.T) {
	ctx, ids := initContextsFixture(t, "client", "personal", "loose")
	meta := twoContexts()
	meta[contextpins.MetaKey("a")] = []any{terminalPin("g1")}
	meta[contextpins.MetaKey("b")] = []any{terminalPin("g2"), terminalPin("g3")}
	setClientMeta(t, ctx, meta)
	for name, want := range map[string]string{"client": "a", "personal": "b", "loose": "a"} {
		if _, err := ApplyContexts(ctx, func(s contexts.State) (contexts.State, []string, error) {
			return s.Assign(contexts.AssignRequest{WorkspaceId: ids[name], ContextId: want})
		}); err != nil {
			t.Fatal(err)
		}
	}
	if got := pinIds(pinsOfWorkspace(ctx, ids["client"])); len(got) != 1 || got[0] != "g1" {
		t.Fatalf("a client workspace reads %v, want g1", got)
	}
	if got := pinIds(pinsOfWorkspace(ctx, ids["personal"])); len(got) != 2 || got[0] != "g2" {
		t.Fatalf("a personal workspace reads %v, want g2 and g3", got)
	}
	if got := pinIds(pinsOfWorkspace(ctx, ids["loose"])); len(got) != 1 || got[0] != "g1" {
		t.Fatalf("a second workspace of the client context reads %v, want the same row", got)
	}
}

// A view pinned in one context's row is a plain view of its workspace in another context, whose row does not hold it.
func TestAViewPinnedInAnotherContextIsNotPinnedHere(t *testing.T) {
	ctx, _ := initContextsFixture(t)
	meta := twoContexts()
	meta[contextpins.MetaKey("a")] = []any{terminalPin("g1")}
	meta[contextpins.MetaKey("b")] = []any{}
	setClientMeta(t, ctx, meta)

	inA := makeProjectWorkspace(t, ctx, notuliaMeta())
	inB := makeProjectWorkspace(t, ctx, notuliaMeta())
	for ws, context := range map[string]string{inA: "a", inB: "b"} {
		if _, err := ApplyContexts(ctx, func(s contexts.State) (contexts.State, []string, error) {
			return s.Assign(contexts.AssignRequest{WorkspaceId: ws, ContextId: context})
		}); err != nil {
			t.Fatal(err)
		}
	}
	pinnedMeta := waveobj.MetaMapType{viewpin.GlobalPinMetaKey: "g1", viewpin.GlobalPinRevMetaKey: 2}
	tabA := addProjectTab(t, ctx, inA, "Terminal", pinnedMeta, notuliaDir)
	tabB := addProjectTab(t, ctx, inB, "Terminal", pinnedMeta, notuliaDir)
	if !pinnedViewTab(ctx, tabA) {
		t.Fatalf("the tab of context a's row is a pinned view in a")
	}
	if pinnedViewTab(ctx, tabB) {
		t.Fatalf("the same pin id is no pinned view in context b, whose row does not hold it")
	}

	activate(t, ctx, inA, tabA)
	if _, err := switchProject(ctx, projectviews.SwitchRequest{WorkspaceId: inA, ProjectId: "p2"}); err != nil {
		t.Fatal(err)
	}
	if got := instancesOfPin(t, ctx, inA, "g1"); got != 2 {
		t.Fatalf("context a: the pinned view gets an instance in p2, %d instances", got)
	}
	activate(t, ctx, inB, tabB)
	if _, err := switchProject(ctx, projectviews.SwitchRequest{WorkspaceId: inB, ProjectId: "p2"}); err != nil {
		t.Fatal(err)
	}
	if got := instancesOfPin(t, ctx, inB, "g1"); got != 1 {
		t.Fatalf("context b: nothing is pinned there, so no instance is made, %d instances", got)
	}
}

func instancesOfPin(t *testing.T, ctx context.Context, wsId string, pinId string) int {
	t.Helper()
	count := 0
	for _, tabId := range workspaceOf(t, ctx, wsId).TabIds {
		tab, err := wstore.DBGet[*waveobj.Tab](ctx, tabId)
		if err != nil || tab == nil {
			t.Fatalf("tab %s: %v", tabId, err)
		}
		if tab.Meta.GetString(viewpin.GlobalPinMetaKey, "") == pinId {
			count++
		}
	}
	return count
}

func TestDeletingAContextDeletesItsRow(t *testing.T) {
	ctx, _ := initContextsFixture(t)
	meta := twoContexts()
	meta[contextpins.MetaKey("a")] = []any{terminalPin("g1")}
	meta[contextpins.MetaKey("b")] = []any{terminalPin("g2")}
	setClientMeta(t, ctx, meta)
	if _, err := ApplyContexts(ctx, func(s contexts.State) (contexts.State, []string, error) {
		return s.Delete(contexts.DeleteRequest{Id: "b"})
	}); err != nil {
		t.Fatal(err)
	}
	after := clientMetaOf(t, ctx)
	if contextpins.Has(after, "b") {
		t.Fatalf("the deleted context's row stayed: %v", after[contextpins.MetaKey("b")])
	}
	if got := pinIds(contextpins.PinsOf(after, "a")); len(got) != 1 || got[0] != "g1" {
		t.Fatalf("the other context lost its row: %v", got)
	}
}

func TestACopyOfARowIsTheSameRowUntilOneContextChangesIt(t *testing.T) {
	ctx, _ := initContextsFixture(t)
	setClientMeta(t, ctx, waveobj.MetaMapType{contextpins.LegacyMetaKey: []any{terminalPin("g1")}})
	patch := twoContexts()
	setClientMeta(t, ctx, patch)
	if err := MigrateContextPins(ctx); err != nil {
		t.Fatal(err)
	}
	setClientMeta(t, ctx, waveobj.MetaMapType{contextpins.MetaKey("a"): []any{}})
	meta := clientMetaOf(t, ctx)
	if got := pinIds(contextpins.PinsOf(meta, "b")); len(got) != 1 {
		t.Fatalf("emptying a's row emptied b's: %v", got)
	}
	if !contextpins.Has(meta, "a") {
		t.Fatalf("a's emptied row is still its own")
	}
}
