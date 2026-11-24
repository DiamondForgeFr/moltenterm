// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wcore

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/contexts"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func mkdirs(t *testing.T, dirs ...string) {
	t.Helper()
	for _, dir := range dirs {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
}

func newTermIn(ctx context.Context, tabId string) string {
	def := blockDefInWorkspaceFolder(ctx, tabId, &waveobj.BlockDef{Meta: waveobj.MetaMapType{waveobj.MetaKey_View: "term", waveobj.MetaKey_Controller: "shell"}})
	return def.Meta.GetString(waveobj.MetaKey_CmdCwd, "")
}

// #2516: the folder chosen in the workspace's settings and the context's folder are saved on their own objects, read
// back from the database as a restart reads them, and a new terminal starts in the narrowest scope's folder: the
// project's root, else the workspace's chosen folder, else the context's.
func TestNewTerminalStartsInTheNarrowestScopesFolder(t *testing.T) {
	ctx, ids := initContextsFixture(t, "sefers", "other")
	root := t.TempDir()
	contextDir := filepath.Join(root, "customers")
	workspaceDir := filepath.Join(contextDir, "sefers")
	projectDir := filepath.Join(workspaceDir, "app")
	mkdirs(t, projectDir)

	tab := &waveobj.Tab{OID: "tab-sefers", BlockIds: []string{}}
	if err := wstore.DBInsert(ctx, tab); err != nil {
		t.Fatal(err)
	}
	ws, err := wstore.DBMustGet[*waveobj.Workspace](ctx, ids["sefers"])
	if err != nil {
		t.Fatal(err)
	}
	ws.TabIds = []string{tab.OID}
	if err := wstore.DBUpdate(ctx, ws); err != nil {
		t.Fatal(err)
	}

	if _, err := ApplyContexts(ctx, func(s contexts.State) (contexts.State, []string, error) {
		next, moved, err := s.Create(contexts.CreateRequest{Name: "Client", Workspaces: []string{ids["sefers"]}}, "client")
		if err != nil {
			return s, nil, err
		}
		folder := contextDir
		next, _, err = next.Update(contexts.UpdateRequest{Id: "client", Folder: &folder})
		return next, moved, err
	}); err != nil {
		t.Fatal(err)
	}
	if got := newTermIn(ctx, tab.OID); got != contextDir {
		t.Fatalf("with the context's folder only, a new terminal starts in %q, want %q", got, contextDir)
	}

	// The workspace's settings save the chosen folder; its terminal went home before (the developer's case).
	if err := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Workspace, ids["sefers"]), waveobj.MetaMapType{molten.WorkspaceFolderMetaKey: "/home/someone"}, false); err != nil {
		t.Fatal(err)
	}
	if err := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Workspace, ids["sefers"]), waveobj.MetaMapType{molten.WorkspaceFolderMetaKey: workspaceDir, molten.WorkspaceFolderChosenMetaKey: true, molten.WorkspaceIconMetaKey: "logo.png"}, false); err != nil {
		t.Fatal(err)
	}
	if got := newTermIn(ctx, tab.OID); got != workspaceDir {
		t.Fatalf("with a chosen workspace folder, a new terminal starts in %q, want %q", got, workspaceDir)
	}

	if err := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Workspace, ids["sefers"]), waveobj.MetaMapType{molten.ProjectMetaKey: projectDir}, false); err != nil {
		t.Fatal(err)
	}
	if got := newTermIn(ctx, tab.OID); got != projectDir {
		t.Fatalf("with a project inside the workspace's folder, a new terminal starts in %q, want %q", got, projectDir)
	}

	// Read back as a restart does: from the database, not from a cache.
	saved, err := wstore.DBMustGet[*waveobj.Workspace](ctx, ids["sefers"])
	if err != nil {
		t.Fatal(err)
	}
	if molten.ChosenWorkspaceFolder(saved.Meta) != workspaceDir || saved.Meta.GetString(molten.WorkspaceIconMetaKey, "") != "logo.png" {
		t.Fatalf("workspace meta after a re-read: %v", saved.Meta)
	}
	list, _ := storedContexts(t, ctx)
	if got := contexts.FolderOf(list, saved.Meta); got != contextDir {
		t.Fatalf("context folder after a re-read: %q, want %q", got, contextDir)
	}
	other, err := wstore.DBMustGet[*waveobj.Workspace](ctx, ids["other"])
	if err != nil {
		t.Fatal(err)
	}
	if got := contexts.FolderOf(list, other.Meta); got != "" {
		t.Fatalf("the other context's workspace got the folder %q", got)
	}
}
