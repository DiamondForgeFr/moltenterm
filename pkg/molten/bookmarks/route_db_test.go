// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package bookmarks

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// Not parallel: the data folder the stores open is a process-wide variable.
func TestReadBlockSiteReadsTheTerminalsWorkspaceAndTheClient(t *testing.T) {
	dataDir := t.TempDir()
	saved := wavebase.DataHome_VarCache
	wavebase.DataHome_VarCache = dataDir
	t.Cleanup(func() { wavebase.DataHome_VarCache = saved })
	if err := os.MkdirAll(filepath.Join(dataDir, wavebase.WaveDBDir), 0700); err != nil {
		t.Fatal(err)
	}
	if err := wstore.InitWStore(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	const (
		tabA   = "0a1b2c3d-0000-4000-8000-00000000000a"
		tabB   = "0a1b2c3d-0000-4000-8000-00000000000b"
		blockA = "0a1b2c3d-0000-4000-8000-0000000000a1"
		blockB = "0a1b2c3d-0000-4000-8000-0000000000b1"
		noSuch = "0a1b2c3d-0000-4000-8000-0000000000ff"
	)
	meta := fixtureClientMeta(t)
	for _, obj := range []waveobj.WaveObj{
		&waveobj.Client{OID: "client-1", WindowIds: []string{}, Meta: meta},
		&waveobj.Workspace{OID: "ws-a", Name: "Acme", TabIds: []string{tabA}, Meta: workspaceMeta(t, workspaceWithTwoProjects)},
		&waveobj.Tab{OID: tabA, BlockIds: []string{blockA}},
		&waveobj.Block{OID: blockA, ParentORef: waveobj.MakeORef(waveobj.OType_Tab, tabA).String()},
		&waveobj.Workspace{OID: "ws-b", Name: "Beta", TabIds: []string{tabB}},
		&waveobj.Tab{OID: tabB, BlockIds: []string{blockB}},
		&waveobj.Block{OID: blockB, ParentORef: waveobj.MakeORef(waveobj.OType_Tab, tabB).String()},
	} {
		if err := wstore.DBInsert(ctx, obj); err != nil {
			t.Fatal(err)
		}
	}

	link := &routeLink{read: readBlockSite}
	out, err := link.handle(molten.BookmarksListCommand, localCallerOf(blockA), molten.BookmarksRequest{BlockId: blockA})
	if err != nil {
		t.Fatal(err)
	}
	view := out.(molten.BookmarksView)
	want := []string{
		"Staging @ project:Desktop:, context:Client SEFERS:Ops",
		"Vite config @ project:Desktop:Docs, app::",
		"Dashboards @ workspace:Acme:Shared",
		"Everywhere @ app::",
	}
	if got := shapes(view.Bookmarks); !reflect.DeepEqual(got, want) || view.Workspace != "Acme" || view.Context != "Client SEFERS" {
		t.Fatalf("the terminal of ws-a reads\n%s\nin %+v", strings.Join(got, "\n"), view)
	}

	out, err = link.handle(molten.BookmarksListCommand, localCallerOf(blockB), molten.BookmarksRequest{BlockId: blockB})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := titles(out.(molten.BookmarksView).Bookmarks), []string{"Staging", "Vite config", "Everywhere"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("a workspace of ws-b with no project reads %v, want %v (its context's and the app's)", got, want)
	}
	if _, err := link.handle(molten.BookmarksListCommand, localCallerOf(blockA), molten.BookmarksRequest{BlockId: blockB}); err == nil {
		t.Error("the terminal of ws-a read the workspace of ws-b")
	}
	if _, err := link.handle(molten.BookmarksListCommand, localCallerOf(noSuch), molten.BookmarksRequest{BlockId: noSuch}); err == nil {
		t.Error("a block that does not exist was answered")
	}

	client, err := wstore.DBGetSingleton[*waveobj.Client](ctx)
	if err != nil {
		t.Fatal(err)
	}
	delete(client.Meta, molten.BookmarksMetaKey)
	if err := wstore.DBUpdate(ctx, client); err != nil {
		t.Fatal(err)
	}
	out, err = link.handle(molten.BookmarksListCommand, localCallerOf(blockA), molten.BookmarksRequest{BlockId: blockA})
	if err != nil || len(out.(molten.BookmarksView).Bookmarks) != 0 {
		t.Errorf("a client with no bookmark lists none: %+v %v", out, err)
	}
}
