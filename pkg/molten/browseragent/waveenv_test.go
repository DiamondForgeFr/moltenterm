// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package browseragent

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// The real environment (wstore) lists the browser panels of a workspace, and only of that workspace (#2333): the fakes of
// the other tests stand for it, so what it reads is checked here against a real database in a temporary folder.

const (
	idTermMain       = "10000000-0000-4000-8000-000000000001"
	idPanelA         = "10000000-0000-4000-8000-000000000002"
	idPanelB         = "10000000-0000-4000-8000-000000000003"
	idPanelReview    = "10000000-0000-4000-8000-000000000004"
	idPanelElsewhere = "10000000-0000-4000-8000-000000000005"
	idTabMain        = "20000000-0000-4000-8000-000000000001"
	idTabReview      = "20000000-0000-4000-8000-000000000002"
	idTabOther       = "20000000-0000-4000-8000-000000000003"
	idWsMine         = "30000000-0000-4000-8000-000000000001"
	idWsOther        = "30000000-0000-4000-8000-000000000002"
	idWsMissing      = "30000000-0000-4000-8000-000000000003"
)

func initWorkspaceStore(t *testing.T) {
	t.Helper()
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
}

func insertObj(t *testing.T, obj waveobj.WaveObj) {
	t.Helper()
	if err := wstore.DBInsert(context.Background(), obj); err != nil {
		t.Fatalf("inserting %s: %v", obj.GetOType(), err)
	}
}

func browserPanelBlock(oid string, tabOid string, active string, tabs ...map[string]any) *waveobj.Block {
	list := make([]any, 0, len(tabs))
	for _, tab := range tabs {
		list = append(list, tab)
	}
	return &waveobj.Block{OID: oid, ParentORef: waveobj.MakeORef(waveobj.OType_Tab, tabOid).String(), Meta: waveobj.MetaMapType{
		waveobj.MetaKey_View:        molten.BrowserView,
		molten.BrowserTabsMetaKey:   list,
		molten.BrowserActiveMetaKey: active,
	}}
}

func TestWorkspacePanelsReadsTheBrowserPanelsOfEveryWaveTabOfTheWorkspaceOnly(t *testing.T) {
	initWorkspaceStore(t)
	insertObj(t, &waveobj.Block{OID: idTermMain, ParentORef: waveobj.MakeORef(waveobj.OType_Tab, idTabMain).String(), Meta: waveobj.MetaMapType{waveobj.MetaKey_View: "term"}})
	insertObj(t, browserPanelBlock(idPanelA, idTabMain, "a1", map[string]any{"id": "a1", "url": "https://docs.example/guide", "title": "Guide"}))
	insertObj(t, browserPanelBlock(idPanelB, idTabMain, "b2",
		map[string]any{"id": "b1", "url": "https://docs.example/other"},
		map[string]any{"id": "b2", "url": "https://docs.example/guide", "engine": "brave"}))
	insertObj(t, browserPanelBlock(idPanelReview, idTabReview, "r1", map[string]any{"id": "r1", "url": "https://docs.example/guide"}))
	insertObj(t, browserPanelBlock(idPanelElsewhere, idTabOther, "e1", map[string]any{"id": "e1", "url": "https://docs.example/guide"}))
	insertObj(t, &waveobj.Tab{OID: idTabMain, Name: "Main", BlockIds: []string{idTermMain, idPanelA, idPanelB},
		Meta: waveobj.MetaMapType{molten.BrowserRecentMetaKey: []any{idPanelB, idPanelA}}})
	insertObj(t, &waveobj.Tab{OID: idTabReview, Name: "Review", BlockIds: []string{idPanelReview}})
	insertObj(t, &waveobj.Tab{OID: idTabOther, Name: "Other workspace", BlockIds: []string{idPanelElsewhere}})
	insertObj(t, &waveobj.Workspace{OID: idWsMine, TabIds: []string{idTabMain, idTabReview}, ActiveTabId: idTabMain})
	insertObj(t, &waveobj.Workspace{OID: idWsOther, TabIds: []string{idTabOther}, ActiveTabId: idTabOther})

	ctx := context.Background()
	panels, err := waveEnv{}.WorkspacePanels(ctx, idWsMine)
	if err != nil {
		t.Fatalf("WorkspacePanels: %v", err)
	}
	var got []string
	for _, p := range panels {
		got = append(got, p.BlockId)
		if p.WorkspaceId != idWsMine {
			t.Fatalf("a panel of another workspace: %+v", p)
		}
	}
	if len(got) != 3 || got[0] != idPanelA || got[1] != idPanelB || got[2] != idPanelReview {
		t.Fatalf("the browser panels of both Wave tabs, in layout order, none of the other workspace: %v", got)
	}
	a, b, review := panels[0], panels[1], panels[2]
	if a.TabId != idTabMain || a.TabName != "Main" || !a.Shown || a.Active != "a1" || a.Recent != 1 || a.Order != 1 {
		t.Fatalf("the first panel: %+v", a)
	}
	if b.Recent != 0 || b.Order != 2 || b.Active != "b2" || len(b.Tabs) != 2 || b.Tabs[1].Engine != "brave" {
		t.Fatalf("the second panel: %+v", b)
	}
	if review.TabName != "Review" || review.Shown || review.Recent != -1 || review.Order != 1 {
		t.Fatalf("the panel of the other Wave tab: %+v", review)
	}
	if _, err := (waveEnv{}).WorkspacePanels(ctx, idWsMissing); err == nil {
		t.Fatalf("an unknown workspace is an error, not an empty list")
	}
	other, err := waveEnv{}.WorkspacePanels(ctx, idWsOther)
	if err != nil || len(other) != 1 || other[0].BlockId != idPanelElsewhere {
		t.Fatalf("the other workspace sees its own panel only: %+v %v", other, err)
	}
	loc, err := waveEnv{}.LocateBlock(ctx, idPanelReview)
	if err != nil || loc.WorkspaceId != idWsMine || loc.TabId != idTabReview {
		t.Fatalf("the panel is located where the list says: %+v %v", loc, err)
	}
	panel, found, err := waveEnv{}.ReadPanel(ctx, idPanelReview)
	if err != nil || !found || panel.WorkspaceId != idWsMine || panel.TabId != idTabReview || len(panel.Tabs) != 1 {
		t.Fatalf("a panel reads the same: %+v %v %v", panel, found, err)
	}
}

func TestRecentRankIsThePlaceInTheFocusHistory(t *testing.T) {
	history := []any{"p1", 7, "p2"}
	if recentRank(history, "p1") != 0 || recentRank(history, "p2") != 2 || recentRank(history, "p3") != -1 {
		t.Fatalf("ranks: %d %d %d", recentRank(history, "p1"), recentRank(history, "p2"), recentRank(history, "p3"))
	}
	if recentRank(nil, "p1") != -1 || recentRank("x", "p1") != -1 {
		t.Fatalf("no history, no rank")
	}
}
