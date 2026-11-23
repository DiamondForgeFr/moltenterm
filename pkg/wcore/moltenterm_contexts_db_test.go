// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wcore

import (
	"context"
	"slices"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/contexts"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func initContextsFixture(t *testing.T, names ...string) (context.Context, map[string]string) {
	t.Helper()
	initWorkspaceViewStores(t)
	ctx := context.Background()
	if _, err := CreateClient(ctx); err != nil {
		t.Fatalf("client: %v", err)
	}
	ids := map[string]string{}
	for _, name := range names {
		ws := &waveobj.Workspace{OID: "ws-" + name, TabIds: []string{}, Name: name, Icon: "star"}
		if err := wstore.DBInsert(ctx, ws); err != nil {
			t.Fatalf("workspace %s: %v", name, err)
		}
		ids[name] = ws.OID
	}
	return ctx, ids
}

func storedContexts(t *testing.T, ctx context.Context) ([]contexts.Context, bool) {
	t.Helper()
	client, err := wstore.DBGetSingleton[*waveobj.Client](ctx)
	if err != nil {
		t.Fatal(err)
	}
	return contexts.ReadContexts(client.Meta), contexts.Stored(client.Meta)
}

func workspaceContextMeta(t *testing.T, ctx context.Context, id string) (string, bool) {
	t.Helper()
	ws, err := wstore.DBMustGet[*waveobj.Workspace](ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	value, found := ws.Meta[contexts.WorkspaceMetaKey].(string)
	return value, found
}

// #2476: an installation that never used contexts writes nothing, and every workspace is in the first one.
func TestContextsOfAnInstallationThatNeverUsedThem(t *testing.T) {
	ctx, ids := initContextsFixture(t, "a", "b")
	state, err := ReadContexts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(state.Contexts) != 1 || state.Contexts[0].Id != contexts.DefaultId {
		t.Fatalf("contexts %+v", state.Contexts)
	}
	for name, id := range ids {
		if state.Of[id] != contexts.DefaultId {
			t.Fatalf("workspace %s is in %q", name, state.Of[id])
		}
		if _, found := workspaceContextMeta(t, ctx, id); found {
			t.Fatalf("reading wrote the meta of workspace %s", name)
		}
	}
	if _, stored := storedContexts(t, ctx); stored {
		t.Fatalf("reading wrote the list")
	}
}

func TestCreatingAContextWritesTheListAndOnlyTheMovedWorkspaces(t *testing.T) {
	ctx, ids := initContextsFixture(t, "a", "b", "c")
	state, err := ApplyContexts(ctx, func(s contexts.State) (contexts.State, []string, error) {
		return s.Create(contexts.CreateRequest{Name: "DiamondForge", Emblem: "briefcase", Workspaces: []string{ids["b"], ids["c"]}}, "df")
	})
	if err != nil {
		t.Fatal(err)
	}
	list, stored := storedContexts(t, ctx)
	if !stored || len(list) != 2 || list[0].Id != contexts.DefaultId || list[1].Id != "df" || list[1].Emblem != "briefcase" {
		t.Fatalf("stored %v: %+v", stored, list)
	}
	if !contexts.SameContexts(list, state.Contexts) {
		t.Fatalf("the answer is not what was written: %+v / %+v", state.Contexts, list)
	}
	for _, name := range []string{"b", "c"} {
		if got, _ := workspaceContextMeta(t, ctx, ids[name]); got != "df" {
			t.Fatalf("workspace %s is in %q", name, got)
		}
	}
	if _, found := workspaceContextMeta(t, ctx, ids["a"]); found {
		t.Fatalf("a workspace that did not move was written")
	}
	read, err := ReadContexts(ctx)
	if err != nil || read.Of[ids["a"]] != contexts.DefaultId || read.Of[ids["b"]] != "df" {
		t.Fatalf("read back %+v %v", read.Of, err)
	}
}

func TestDeletingTheFirstContextWritesTheWorkspacesThatNeverCarriedAnId(t *testing.T) {
	ctx, ids := initContextsFixture(t, "a", "b")
	if _, err := ApplyContexts(ctx, func(s contexts.State) (contexts.State, []string, error) {
		return s.Create(contexts.CreateRequest{Name: "Second", Workspaces: []string{ids["b"]}}, "two")
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := ApplyContexts(ctx, func(s contexts.State) (contexts.State, []string, error) {
		return s.Delete(contexts.DeleteRequest{Id: contexts.DefaultId})
	}); err != nil {
		t.Fatal(err)
	}
	list, _ := storedContexts(t, ctx)
	if len(list) != 1 || list[0].Id != "two" {
		t.Fatalf("contexts %+v", list)
	}
	if got, found := workspaceContextMeta(t, ctx, ids["a"]); !found || got != "two" {
		t.Fatalf("workspace a is in %q (written: %v)", got, found)
	}
}

func TestAChangeThatFailsWritesNothing(t *testing.T) {
	ctx, ids := initContextsFixture(t, "a")
	_, err := ApplyContexts(ctx, func(s contexts.State) (contexts.State, []string, error) {
		return s.Create(contexts.CreateRequest{Name: "Broken", Workspaces: []string{ids["a"], "ghost"}}, "x")
	})
	if err == nil {
		t.Fatalf("a change naming a workspace that does not exist was applied")
	}
	if _, stored := storedContexts(t, ctx); stored {
		t.Fatalf("a refused change wrote the list")
	}
	if _, found := workspaceContextMeta(t, ctx, ids["a"]); found {
		t.Fatalf("a refused change wrote a workspace")
	}
}

func TestATouchThatChangesNothingWritesNothing(t *testing.T) {
	ctx, ids := initContextsFixture(t, "a")
	if _, err := ApplyContexts(ctx, func(s contexts.State) (contexts.State, []string, error) {
		next, err := s.Touch(contexts.TouchRequest{ContextId: contexts.DefaultId, WorkspaceId: ids["a"]})
		return next, nil, err
	}); err != nil {
		t.Fatal(err)
	}
	list, stored := storedContexts(t, ctx)
	if !stored || list[0].Last != ids["a"] {
		t.Fatalf("the first touch is remembered: %v %+v", stored, list)
	}
	before, err := wstore.DBGetSingleton[*waveobj.Client](ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ApplyContexts(ctx, func(s contexts.State) (contexts.State, []string, error) {
		next, err := s.Touch(contexts.TouchRequest{ContextId: contexts.DefaultId, WorkspaceId: ids["a"]})
		return next, nil, err
	}); err != nil {
		t.Fatal(err)
	}
	after, err := wstore.DBGetSingleton[*waveobj.Client](ctx)
	if err != nil {
		t.Fatal(err)
	}
	if after.Version != before.Version {
		t.Fatalf("a touch that changed nothing wrote the client again: v%d to v%d", before.Version, after.Version)
	}
}

func TestAWorkspaceThatIsGoneIsRefusedAndNothingIsWritten(t *testing.T) {
	ctx, ids := initContextsFixture(t, "a", "b")
	if err := wstore.DBDelete(ctx, waveobj.OType_Workspace, ids["b"]); err != nil {
		t.Fatal(err)
	}
	if _, err := ApplyContexts(ctx, func(s contexts.State) (contexts.State, []string, error) {
		return s.Create(contexts.CreateRequest{Name: "Two", Workspaces: []string{ids["a"], ids["b"]}}, "two")
	}); err == nil {
		t.Fatalf("a workspace deleted meanwhile was moved")
	}
	if slices.Contains(storedContextIds(t, ctx), "two") {
		t.Fatalf("the list was written")
	}
}

func storedContextIds(t *testing.T, ctx context.Context) []string {
	t.Helper()
	list, _ := storedContexts(t, ctx)
	rtn := []string{}
	for _, c := range list {
		rtn = append(rtn, c.Id)
	}
	return rtn
}
