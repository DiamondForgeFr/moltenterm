// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package reopen

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
)

func fakeStore(restored *[]string, fail *bool) Store {
	return Store{
		Capture: func(ctx context.Context, req RecordRequest) (Entry, error) {
			return Entry{Target: Target{Kind: req.Kind, WorkspaceId: req.WorkspaceId, TabId: req.TabId, BlockId: req.BlockId, Name: req.BlockId + req.Kind}}, nil
		},
		Restore: func(ctx context.Context, e Entry, req ReopenRequest) (ReopenResult, error) {
			if *fail {
				return ReopenResult{}, errors.New("no room")
			}
			*restored = append(*restored, e.Target.Name)
			return ReopenResult{}, nil
		},
	}
}

// #512: three panes closed in a row come back in reverse order; nothing left says so.
func TestReopenLastWalksBackThroughTheCloses(t *testing.T) {
	var restored []string
	fail := false
	store, stacks := fakeStore(&restored, &fail), MakeStacks()
	ctx := context.Background()
	for _, b := range []string{"a", "b", "c"} {
		if _, err := Record(ctx, store, stacks, RecordRequest{Kind: KindPane, WorkspaceId: "w", TabId: "t", BlockId: b}); err != nil {
			t.Fatal(err)
		}
	}
	for _, want := range []string{"cpane", "bpane", "apane"} {
		res, err := ReopenLast(ctx, store, stacks, ReopenRequest{WorkspaceId: "w", TabId: "t"})
		if err != nil || !res.Reopened || res.Name != want || res.Kind != KindPane {
			t.Fatalf("reopen: %+v %v, want %s", res, err, want)
		}
	}
	if res, err := ReopenLast(ctx, store, stacks, ReopenRequest{WorkspaceId: "w", TabId: "t"}); err != nil || res.Reopened {
		t.Fatalf("nothing to reopen: %+v %v", res, err)
	}
}

// #1744: a browser reopens the last closed tab or window, whichever closed last; panels and views share one order.
func TestReopenLastKeepsOneClosingOrderForPanelsAndViews(t *testing.T) {
	var restored []string
	fail := false
	store, stacks := fakeStore(&restored, &fail), MakeStacks()
	ctx := context.Background()
	closes := []RecordRequest{
		{Kind: KindPane, WorkspaceId: "w", TabId: "t1", BlockId: "a"},
		{Kind: KindTab, WorkspaceId: "w", TabId: "t2"},
		{Kind: KindPane, WorkspaceId: "w", TabId: "t1", BlockId: "b"},
		{Kind: KindTab, WorkspaceId: "w", TabId: "t1"},
		{Kind: KindPane, WorkspaceId: "other", TabId: "t9", BlockId: "z"},
	}
	for _, req := range closes {
		if _, err := Record(ctx, store, stacks, req); err != nil {
			t.Fatal(err)
		}
	}
	want := []string{"tab", "bpane", "tab", "apane"}
	for _, name := range want {
		res, err := ReopenLast(ctx, store, stacks, ReopenRequest{WorkspaceId: "w", TabId: "t"})
		if err != nil || !res.Reopened || res.Name != name {
			t.Fatalf("reopen: %+v %v, want %s", res, err, name)
		}
	}
	if res, err := ReopenLast(ctx, store, stacks, ReopenRequest{WorkspaceId: "w", TabId: "t"}); err != nil || res.Reopened {
		t.Fatalf("this workspace has nothing left: %+v %v", res, err)
	}
	if stacks.Len("other") != 1 {
		t.Fatal("another workspace keeps its own closes")
	}
}

// The panels and the views are trimmed on their own counts, so a flood of one kind never reorders or evicts the other.
func TestReopenKeepsTheOrderWhenOneKindOverflows(t *testing.T) {
	var restored []string
	fail := false
	store, stacks := fakeStore(&restored, &fail), MakeStacks()
	ctx := context.Background()
	record := func(req RecordRequest) {
		if _, err := Record(ctx, store, stacks, req); err != nil {
			t.Fatal(err)
		}
	}
	record(RecordRequest{Kind: KindTab, WorkspaceId: "w", TabId: "view"})
	for i := 0; i < StackSize+3; i++ {
		record(RecordRequest{Kind: KindPane, WorkspaceId: "w", TabId: "t", BlockId: fmt.Sprintf("p%02d", i)})
	}
	for i := 0; i < StackSize; i++ {
		res, err := ReopenLast(ctx, store, stacks, ReopenRequest{WorkspaceId: "w", TabId: "t"})
		want := fmt.Sprintf("p%02dpane", StackSize+2-i)
		if err != nil || res.Name != want {
			t.Fatalf("reopen %d: %+v %v, want %s", i, res, err, want)
		}
	}
	if res, err := ReopenLast(ctx, store, stacks, ReopenRequest{WorkspaceId: "w", TabId: "t"}); err != nil || res.Name != "tab" {
		t.Fatalf("the view closed first is still there: %+v %v", res, err)
	}
}

func TestReopenKeepsAnEntryThatFailedAndDropsADeclinedClose(t *testing.T) {
	var restored []string
	fail := true
	store, stacks := fakeStore(&restored, &fail), MakeStacks()
	ctx := context.Background()
	kept, _ := Record(ctx, store, stacks, RecordRequest{Kind: KindTab, WorkspaceId: "w", TabId: "t1"})
	if _, err := ReopenLast(ctx, store, stacks, ReopenRequest{WorkspaceId: "w", TabId: "t"}); err == nil {
		t.Fatal("the restore error is reported")
	}
	if stacks.Len("w") != 1 {
		t.Fatal("a failed reopen keeps its entry")
	}
	declined, _ := Record(ctx, store, stacks, RecordRequest{Kind: KindTab, WorkspaceId: "w", TabId: "t2"})
	if declined.Id == "" || declined.Id == kept.Id || !stacks.Drop("w", declined.Id) || stacks.Len("w") != 1 {
		t.Fatalf("a declined close goes: %+v %+v", declined, kept)
	}
	fail = false
	if res, _ := ReopenLast(ctx, store, stacks, ReopenRequest{WorkspaceId: "w", TabId: "t"}); res.Name != "tab" {
		t.Fatalf("the kept entry comes back: %+v", res)
	}
}

// A pane closed beside one closed after it goes back beside that pane's new block once it came back.
func TestReopenPlacesBesideAPaneThatCameBack(t *testing.T) {
	var targets []string
	store := Store{
		Restore: func(ctx context.Context, e Entry, req ReopenRequest) (ReopenResult, error) {
			targets = append(targets, e.Pane.TargetBlockId)
			return ReopenResult{BlockId: "new-" + e.Target.BlockId}, nil
		},
	}
	stacks := MakeStacks()
	pane := func(block, target string) Entry {
		return Entry{Target: Target{Kind: KindPane, WorkspaceId: "w", BlockId: block}, Pane: &Pane{PanePlacement: molten.PanePlacement{TargetBlockId: target, Split: "down"}}}
	}
	stacks.Push(pane("a", "b"))
	stacks.Push(pane("b", "c"))
	for i := 0; i < 2; i++ {
		if _, err := ReopenLast(context.Background(), store, stacks, ReopenRequest{WorkspaceId: "w"}); err != nil {
			t.Fatal(err)
		}
	}
	if len(targets) != 2 || targets[0] != "c" || targets[1] != "new-b" {
		t.Fatalf("targets %v", targets)
	}
}

func TestRecordNeedsItsTargets(t *testing.T) {
	var restored []string
	fail := false
	store, stacks := fakeStore(&restored, &fail), MakeStacks()
	for _, req := range []RecordRequest{
		{Kind: KindPane, WorkspaceId: "w", TabId: "t"},
		{Kind: KindTab, TabId: "t"},
		{Kind: "window", WorkspaceId: "w", TabId: "t"},
	} {
		if _, err := Record(context.Background(), store, stacks, req); err == nil {
			t.Errorf("%+v is refused", req)
		}
	}
}

// #662: only a window records and reopens closes; a remote host forging a tab source does not.
func TestRouteAnswersWindowsOnly(t *testing.T) {
	e := routetest.Make(t)
	var restored []string
	fail := false
	link, err := localroute.MakeLink(e.Router, (&routeLink{store: fakeStore(&restored, &fail), stacks: MakeStacks()}).route())
	if err != nil {
		t.Fatal(err)
	}
	record := map[string]any{"kind": KindPane, "workspaceid": "w", "tabid": "t", "blockid": "b"}
	for _, command := range []string{RecordCommand, DropCommand, ReopenCommand} {
		routetest.MustRefuse(t, link, e.NonWindows(), command, record)
	}
	if _, errStr := routetest.Ask(t, link, e.Window(), RecordCommand, record); errStr != "" {
		t.Fatalf("the window's record: %s", errStr)
	}
	if _, errStr := routetest.Ask(t, link, e.Window(), ReopenCommand, map[string]any{"workspaceid": "w", "tabid": "t"}); errStr != "" || len(restored) != 1 {
		t.Fatalf("the window's reopen: %q %v", errStr, restored)
	}
}
