// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"slices"
	"testing"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/molten/projectviews"
	"github.com/wavetermdev/waveterm/pkg/molten/viewpin"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const (
	notuliaDir        = "/x/Notulia"
	notuliaWebsiteDir = "/x/Notulia-website"
)

func notuliaMeta() waveobj.MetaMapType {
	return waveobj.MetaMapType{
		projectviews.ProjectsMetaKey: []any{
			map[string]any{"id": "p1", "type": "Desktop", "dir": notuliaDir},
			map[string]any{"id": "p2", "type": "Website", "dir": notuliaWebsiteDir},
		},
		projectviews.CurrentProjectMetaKey: "p1",
		projectviews.LiveProjectMetaKey:    notuliaDir,
		projectviews.LiveTypeMetaKey:       "Desktop",
	}
}

func makeProjectWorkspace(t *testing.T, ctx context.Context, meta waveobj.MetaMapType) string {
	t.Helper()
	ws := &waveobj.Workspace{OID: uuid.NewString(), TabIds: []string{}, Meta: meta}
	if err := wstore.DBInsert(ctx, ws); err != nil {
		t.Fatal(err)
	}
	return ws.OID
}

// addProjectTab makes a tab the way a window does, with a terminal in cwd.
func addProjectTab(t *testing.T, ctx context.Context, wsId string, name string, tabMeta waveobj.MetaMapType, cwd string) string {
	t.Helper()
	tab, err := createTabObj(ctx, wsId, name, tabMeta)
	if err != nil {
		t.Fatal(err)
	}
	if cwd != "" {
		block := &waveobj.Block{
			OID:        uuid.NewString(),
			ParentORef: waveobj.MakeORef(waveobj.OType_Tab, tab.OID).String(),
			Meta:       waveobj.MetaMapType{waveobj.MetaKey_View: "term", waveobj.MetaKey_CmdCwd: cwd},
		}
		if err := wstore.DBInsert(ctx, block); err != nil {
			t.Fatal(err)
		}
		stored, _ := wstore.DBGet[*waveobj.Tab](ctx, tab.OID)
		stored.BlockIds = append(stored.BlockIds, block.OID)
		if err := wstore.DBUpdate(ctx, stored); err != nil {
			t.Fatal(err)
		}
	}
	return tab.OID
}

func workspaceOf(t *testing.T, ctx context.Context, wsId string) *waveobj.Workspace {
	t.Helper()
	ws, err := GetWorkspace(ctx, wsId)
	if err != nil {
		t.Fatal(err)
	}
	return ws
}

func ownersOf(t *testing.T, ctx context.Context, wsId string) map[string]string {
	t.Helper()
	return projectviews.ReadTabProjects(workspaceOf(t, ctx, wsId).Meta)
}

func pinnedTabMeta() waveobj.MetaMapType {
	return waveobj.MetaMapType{
		viewpin.PinMetaKey:       viewpin.PinWorkspace,
		viewpin.PinConfigMetaKey: map[string]any{"tree": map[string]any{}, "panes": []any{map[string]any{"view": "term"}}},
	}
}

func activate(t *testing.T, ctx context.Context, wsId string, tabId string) {
	t.Helper()
	if err := SetActiveTab(ctx, wsId, tabId); err != nil {
		t.Fatal(err)
	}
}

func TestATemporaryViewBelongsToTheProjectItIsMadeIn(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	wsId := makeProjectWorkspace(t, ctx, notuliaMeta())
	a := addProjectTab(t, ctx, wsId, "a", nil, "")
	if err := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Workspace, wsId), projectviews.LiveUpdate(projectviews.Project{Id: "p2", Type: "Website", Dir: notuliaWebsiteDir}), false); err != nil {
		t.Fatal(err)
	}
	b := addProjectTab(t, ctx, wsId, "b", nil, "")
	project := addProjectTab(t, ctx, wsId, "Project", waveobj.MetaMapType{mission.ProjectTabMetaKey: true}, "")
	pinned := addProjectTab(t, ctx, wsId, "tile", pinnedTabMeta(), "")
	owners := ownersOf(t, ctx, wsId)
	if owners[a] != "p1" || owners[b] != "p2" {
		t.Fatalf("owners %v", owners)
	}
	if _, ok := owners[project]; ok {
		t.Fatalf("the Project tab is every project's: %v", owners)
	}
	if _, ok := owners[pinned]; ok {
		t.Fatalf("a pinned view is every project's: %v", owners)
	}
}

func TestAViewReopenedGoesBackToItsOwnProject(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	wsId := makeProjectWorkspace(t, ctx, notuliaMeta())
	hinted := addProjectTab(t, ctx, wsId, "back", waveobj.MetaMapType{projectviews.ViewProjectHintMetaKey: "p2"}, "")
	lost := addProjectTab(t, ctx, wsId, "gone", waveobj.MetaMapType{projectviews.ViewProjectHintMetaKey: "p9"}, "")
	owners := ownersOf(t, ctx, wsId)
	if owners[hinted] != "p2" || owners[lost] != "p1" {
		t.Fatalf("owners %v: the hint names the project, an unknown one means the current", owners)
	}
	for _, id := range []string{hinted, lost} {
		tab, _ := wstore.DBGet[*waveobj.Tab](ctx, id)
		if tab.Meta.HasKey(projectviews.ViewProjectHintMetaKey) {
			t.Fatalf("the hint never stays on the tab: %v", tab.Meta)
		}
	}
}

func TestAWorkspaceWithOneProjectMapsNothing(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	wsId := makeProjectWorkspace(t, ctx, waveobj.MetaMapType{projectviews.LiveProjectMetaKey: notuliaDir, projectviews.LiveTypeMetaKey: "Desktop"})
	addProjectTab(t, ctx, wsId, "a", nil, "")
	addProjectTab(t, ctx, wsId, "b", nil, "")
	if ws := workspaceOf(t, ctx, wsId); ws.Meta.HasKey(projectviews.TabProjectsMetaKey) {
		t.Fatalf("one project: nothing is mapped, %v", ws.Meta)
	}
}

func TestSwitchBetweenTwoProjectsKeepsEveryTabAndRemembersTheLastView(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	wsId := makeProjectWorkspace(t, ctx, notuliaMeta())
	a1 := addProjectTab(t, ctx, wsId, "a1", nil, notuliaDir)
	a2 := addProjectTab(t, ctx, wsId, "a2", nil, notuliaDir)
	tile := addProjectTab(t, ctx, wsId, "tile", pinnedTabMeta(), notuliaDir)
	if err := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Workspace, wsId), projectviews.LiveUpdate(projectviews.Project{Id: "p2", Type: "Website", Dir: notuliaWebsiteDir}), false); err != nil {
		t.Fatal(err)
	}
	b1 := addProjectTab(t, ctx, wsId, "b1", nil, notuliaWebsiteDir)
	b2 := addProjectTab(t, ctx, wsId, "b2", nil, notuliaWebsiteDir)
	activate(t, ctx, wsId, b2)
	activate(t, ctx, wsId, a2)
	before := workspaceOf(t, ctx, wsId)
	blocksBefore := countObjs[*waveobj.Block](t, ctx, waveobj.OType_Block)

	res, err := switchProject(ctx, projectviews.SwitchRequest{WorkspaceId: wsId, ProjectId: "p2"})
	if err != nil {
		t.Fatal(err)
	}
	ws := workspaceOf(t, ctx, wsId)
	if res.TabId != b2 || ws.ActiveTabId != b2 {
		t.Fatalf("the last view shown in p2 (b2) is shown: result %q, active %q", res.TabId, ws.ActiveTabId)
	}
	if projectviews.CurrentProjectId(ws.Meta) != "p2" || ws.Meta.GetString(projectviews.LiveProjectMetaKey, "") != notuliaWebsiteDir ||
		ws.Meta.GetString(projectviews.LiveFolderMetaKey, "") != notuliaWebsiteDir {
		t.Fatalf("the live keys follow p2: %v", ws.Meta)
	}
	if !slices.Equal(ws.TabIds, before.TabIds) {
		t.Fatalf("a switch closes, adds and moves no tab: %v, was %v", ws.TabIds, before.TabIds)
	}
	if got := countObjs[*waveobj.Block](t, ctx, waveobj.OType_Block); got != blocksBefore {
		t.Fatalf("a switch closes no panel: %d blocks, was %d", got, blocksBefore)
	}
	shown := projectviews.ShownTabs(ws.TabIds, projectviews.ReadTabProjects(ws.Meta), projectviews.ReadProjects(ws.Meta), "p2")
	if !slices.Equal(shown, []string{tile, b1, b2}) {
		t.Fatalf("p2 shows its own views and the pinned tile: %v", shown)
	}

	res, err = switchProject(ctx, projectviews.SwitchRequest{WorkspaceId: wsId, ProjectId: "p1"})
	if err != nil {
		t.Fatal(err)
	}
	if res.TabId != a2 {
		t.Fatalf("and back, the last view of p1 (a2, not a1 %s) is shown: %q", a1, res.TabId)
	}
	if again, _ := switchProject(ctx, projectviews.SwitchRequest{WorkspaceId: wsId, ProjectId: "p1"}); again.TabId != a2 {
		t.Fatalf("a switch to the current project changes nothing: %q", again.TabId)
	}
}

func TestSwitchingOnAPinnedViewKeepsItOnScreen(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	wsId := makeProjectWorkspace(t, ctx, notuliaMeta())
	addProjectTab(t, ctx, wsId, "a1", nil, notuliaDir)
	tile := addProjectTab(t, ctx, wsId, "tile", pinnedTabMeta(), notuliaDir)
	activate(t, ctx, wsId, tile)
	res, err := switchProject(ctx, projectviews.SwitchRequest{WorkspaceId: wsId, ProjectId: "p2"})
	if err != nil {
		t.Fatal(err)
	}
	if res.TabId != tile || workspaceOf(t, ctx, wsId).ActiveTabId != tile {
		t.Fatalf("a pinned view is every project's, it stays: %q", res.TabId)
	}
}

// A switch that cannot give the target a view to show leaves the view on screen, which is the left project's: that
// project stays current, never the target with another project's view on screen.
func TestAFailedSwitchPutsTheLeftProjectBack(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	wsId := makeProjectWorkspace(t, ctx, notuliaMeta())
	a1 := addProjectTab(t, ctx, wsId, "a1", nil, notuliaDir)
	activate(t, ctx, wsId, a1)
	if err := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Workspace, wsId), projectviews.LiveUpdate(projectviews.Project{Id: "p2", Type: "Website", Dir: notuliaWebsiteDir}), false); err != nil {
		t.Fatal(err)
	}
	if err := restoreProject(ctx, wsId, "p1"); err != nil {
		t.Fatal(err)
	}
	ws := workspaceOf(t, ctx, wsId)
	if projectviews.CurrentProjectId(ws.Meta) != "p1" || ws.Meta.GetString(projectviews.LiveProjectMetaKey, "") != notuliaDir || ws.ActiveTabId != a1 {
		t.Fatalf("p1 is current again with its view on screen: %v", ws.Meta)
	}
	if err := restoreProject(ctx, wsId, "p1"); err != nil {
		t.Fatalf("a project already current is left as it is: %v", err)
	}
}

func TestASwitchChangesTheProjectAndTheViewShownTogether(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	wsId := makeProjectWorkspace(t, ctx, notuliaMeta())
	a1 := addProjectTab(t, ctx, wsId, "a1", nil, notuliaDir)
	if err := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Workspace, wsId), projectviews.LiveUpdate(projectviews.Project{Id: "p2", Type: "Website", Dir: notuliaWebsiteDir}), false); err != nil {
		t.Fatal(err)
	}
	b1 := addProjectTab(t, ctx, wsId, "b1", nil, notuliaWebsiteDir)
	if err := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Workspace, wsId), projectviews.LiveUpdate(projectviews.Project{Id: "p1", Type: "Desktop", Dir: notuliaDir}), false); err != nil {
		t.Fatal(err)
	}
	activate(t, ctx, wsId, a1)
	if _, err := switchProject(ctx, projectviews.SwitchRequest{WorkspaceId: wsId, ProjectId: "p2"}); err != nil {
		t.Fatal(err)
	}
	ws := workspaceOf(t, ctx, wsId)
	if projectviews.CurrentProjectId(ws.Meta) != "p2" || ws.ActiveTabId != b1 {
		t.Fatalf("the project and the view on screen are p2's, read in one go: %q, %q", projectviews.CurrentProjectId(ws.Meta), ws.ActiveTabId)
	}
}

func TestSwitchRejectsAWorkspaceWithOneProjectAndAnUnknownProject(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	one := makeProjectWorkspace(t, ctx, waveobj.MetaMapType{projectviews.LiveProjectMetaKey: notuliaDir})
	if _, err := switchProject(ctx, projectviews.SwitchRequest{WorkspaceId: one, ProjectId: "p1"}); err == nil {
		t.Fatal("one project has nothing to switch")
	}
	two := makeProjectWorkspace(t, ctx, notuliaMeta())
	if _, err := switchProject(ctx, projectviews.SwitchRequest{WorkspaceId: two, ProjectId: "p9"}); err == nil {
		t.Fatal("an unknown project is refused")
	}
}

func TestClosingTheActiveViewShowsAViewOfTheSameProject(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	wsId := makeProjectWorkspace(t, ctx, notuliaMeta())
	a1 := addProjectTab(t, ctx, wsId, "a1", nil, "")
	if err := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Workspace, wsId), projectviews.LiveUpdate(projectviews.Project{Id: "p2", Type: "Website", Dir: notuliaWebsiteDir}), false); err != nil {
		t.Fatal(err)
	}
	b1 := addProjectTab(t, ctx, wsId, "b1", nil, "")
	if err := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Workspace, wsId), projectviews.LiveUpdate(projectviews.Project{Id: "p1", Type: "Desktop", Dir: notuliaDir}), false); err != nil {
		t.Fatal(err)
	}
	a2 := addProjectTab(t, ctx, wsId, "a2", nil, "")
	activate(t, ctx, wsId, a1)
	activate(t, ctx, wsId, b1)
	activate(t, ctx, wsId, a2)

	next, err := DeleteTab(ctx, wsId, a2, false)
	if err != nil {
		t.Fatal(err)
	}
	if next != a1 {
		t.Fatalf("the next view is p1's a1, not the neighbour b1 (%s) nor the history's b1: %q", b1, next)
	}
	ws := workspaceOf(t, ctx, wsId)
	if projectviews.CurrentProjectId(ws.Meta) != "p1" {
		t.Fatalf("p1 stays current: %v", ws.Meta)
	}
	if owners := projectviews.ReadTabProjects(ws.Meta); owners[a2] != "" {
		t.Fatalf("the closed view leaves the map: %v", owners)
	}
}

func TestShowingAViewOfAnotherProjectMakesItsProjectCurrent(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	wsId := makeProjectWorkspace(t, ctx, notuliaMeta())
	addProjectTab(t, ctx, wsId, "a1", nil, "")
	if err := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Workspace, wsId), projectviews.LiveUpdate(projectviews.Project{Id: "p2", Type: "Website", Dir: notuliaWebsiteDir}), false); err != nil {
		t.Fatal(err)
	}
	b1 := addProjectTab(t, ctx, wsId, "b1", nil, "")
	if err := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Workspace, wsId), projectviews.LiveUpdate(projectviews.Project{Id: "p1", Type: "Desktop", Dir: notuliaDir}), false); err != nil {
		t.Fatal(err)
	}
	activate(t, ctx, wsId, b1)
	ws := workspaceOf(t, ctx, wsId)
	if projectviews.CurrentProjectId(ws.Meta) != "p2" || ws.Meta.GetString(projectviews.LiveProjectMetaKey, "") != notuliaWebsiteDir {
		t.Fatalf("showing b1 makes p2 current: %v", ws.Meta)
	}
	if got := projectviews.ReadActiveByProject(ws.Meta)["p2"]; got != b1 {
		t.Fatalf("and it is p2's last view: %q", got)
	}
}

func TestTabBarsSendingTheirShownTabsKeepTheOtherProjectsViews(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	wsId := makeProjectWorkspace(t, ctx, notuliaMeta())
	a1 := addProjectTab(t, ctx, wsId, "a1", nil, "")
	a2 := addProjectTab(t, ctx, wsId, "a2", nil, "")
	if err := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Workspace, wsId), projectviews.LiveUpdate(projectviews.Project{Id: "p2", Type: "Website", Dir: notuliaWebsiteDir}), false); err != nil {
		t.Fatal(err)
	}
	b1 := addProjectTab(t, ctx, wsId, "b1", nil, "")
	if err := UpdateWorkspaceTabIds(ctx, wsId, []string{b1}); err != nil {
		t.Fatal(err)
	}
	if got := workspaceOf(t, ctx, wsId).TabIds; !slices.Equal(got, []string{b1, a1, a2}) {
		t.Fatalf("p2's tab bar sent b1 only: %v", got)
	}
}

func TestAStaleTabListNeverRemovesATab(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	wsId := makeProjectWorkspace(t, ctx, notuliaMeta())
	a1 := addProjectTab(t, ctx, wsId, "a1", nil, "")
	a2 := addProjectTab(t, ctx, wsId, "a2", nil, "")
	a3 := addProjectTab(t, ctx, wsId, "a3", nil, "")
	// A list sent before a3 existed (a drag in the sidebar, a tab bar's debounce) and holding a tab that closed since.
	if err := UpdateWorkspaceTabIds(ctx, wsId, []string{a2, "gone", a1}); err != nil {
		t.Fatal(err)
	}
	if got := workspaceOf(t, ctx, wsId).TabIds; !slices.Equal(got, []string{a2, a1, a3}) {
		t.Fatalf("the order asked for, the tab the list left out at the end, the dead id dropped: %v", got)
	}
	// An empty list changes the order of nothing and removes nothing.
	if err := UpdateWorkspaceTabIds(ctx, wsId, nil); err != nil {
		t.Fatal(err)
	}
	if got := workspaceOf(t, ctx, wsId).TabIds; !slices.Equal(got, []string{a2, a1, a3}) {
		t.Fatalf("an empty list removes no tab: %v", got)
	}
}

func TestPinningAndUnpinningAViewMovesItInAndOutOfTheMap(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	wsId := makeProjectWorkspace(t, ctx, notuliaMeta())
	a1 := addProjectTab(t, ctx, wsId, "a1", nil, "")
	oref := waveobj.MakeORef(waveobj.OType_Tab, a1)
	if err := wstore.UpdateObjectMeta(ctx, oref, pinnedTabMeta(), false); err != nil {
		t.Fatal(err)
	}
	MoltenTabMetaChanged(ctx, a1, pinnedTabMeta())
	if _, ok := ownersOf(t, ctx, wsId)[a1]; ok {
		t.Fatal("a view pinned belongs to every project")
	}
	unpin := waveobj.MetaMapType{viewpin.PinMetaKey: nil, viewpin.PinConfigMetaKey: nil}
	if err := wstore.UpdateObjectMeta(ctx, oref, unpin, false); err != nil {
		t.Fatal(err)
	}
	MoltenTabMetaChanged(ctx, a1, unpin)
	if got := ownersOf(t, ctx, wsId)[a1]; got != "p1" {
		t.Fatalf("a view made temporary belongs to the project the developer works in: %q", got)
	}
	MoltenTabMetaChanged(ctx, a1, waveobj.MetaMapType{"molten:viewicon": "x"})
}

func TestRemovingAProjectKeepsEveryViewAndHandsItsViewsOver(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	wsId := makeProjectWorkspace(t, ctx, notuliaMeta())
	a1 := addProjectTab(t, ctx, wsId, "a1", nil, "")
	if err := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Workspace, wsId), projectviews.LiveUpdate(projectviews.Project{Id: "p2", Type: "Website", Dir: notuliaWebsiteDir}), false); err != nil {
		t.Fatal(err)
	}
	b1 := addProjectTab(t, ctx, wsId, "b1", nil, "")
	before := workspaceOf(t, ctx, wsId).TabIds
	if _, err := removeProject(ctx, projectviews.RemoveRequest{WorkspaceId: wsId, ProjectId: "p2"}); err != nil {
		t.Fatal(err)
	}
	ws := workspaceOf(t, ctx, wsId)
	if !slices.Equal(ws.TabIds, before) {
		t.Fatalf("removing a project closes no view: %v, was %v", ws.TabIds, before)
	}
	projects := projectviews.ReadProjects(ws.Meta)
	if len(projects) != 1 || projects[0].Id != "p1" || projectviews.CurrentProjectId(ws.Meta) != "p1" {
		t.Fatalf("p1 is the only project and takes over: %+v", projects)
	}
	if ws.Meta.GetString(projectviews.LiveProjectMetaKey, "") != notuliaDir {
		t.Fatalf("the live keys follow the project that took over: %v", ws.Meta)
	}
	if ws.Meta.HasKey(projectviews.TabProjectsMetaKey) {
		t.Fatalf("one project left maps nothing: %v", ws.Meta)
	}
	_, _ = a1, b1
	if _, err := removeProject(ctx, projectviews.RemoveRequest{WorkspaceId: wsId, ProjectId: "p1"}); err == nil {
		t.Fatal("a workspace keeps one project")
	}
}

func TestRemovingAProjectMovesItsViewsToTheOneThatTakesOver(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	meta := notuliaMeta()
	meta[projectviews.ProjectsMetaKey] = append(meta[projectviews.ProjectsMetaKey].([]any), map[string]any{"id": "p3", "type": "Mobile", "dir": "/x/Notulia-mobile"})
	wsId := makeProjectWorkspace(t, ctx, meta)
	a1 := addProjectTab(t, ctx, wsId, "a1", nil, "")
	if err := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Workspace, wsId), projectviews.LiveUpdate(projectviews.Project{Id: "p2", Type: "Website", Dir: notuliaWebsiteDir}), false); err != nil {
		t.Fatal(err)
	}
	b1 := addProjectTab(t, ctx, wsId, "b1", nil, "")
	if _, err := removeProject(ctx, projectviews.RemoveRequest{WorkspaceId: wsId, ProjectId: "p2"}); err != nil {
		t.Fatal(err)
	}
	ws := workspaceOf(t, ctx, wsId)
	owners := projectviews.ReadTabProjects(ws.Meta)
	if owners[b1] != "p1" || owners[a1] != "p1" {
		t.Fatalf("the views of the project removed go to the first project left: %v", owners)
	}
	if projectviews.CurrentProjectId(ws.Meta) != "p1" {
		t.Fatalf("current %q", projectviews.CurrentProjectId(ws.Meta))
	}
}

// The assignment of a workspace that already holds views: temporary views get the project their panels' folders say,
// pinned views and the Project tab stay every project's, and nothing is closed, moved or rebuilt.
func TestStartupAssignmentGivesTemporaryViewsTheirProjectInMetaOnly(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	wsId := makeProjectWorkspace(t, ctx, waveobj.MetaMapType{projectviews.LiveProjectMetaKey: notuliaDir, projectviews.LiveTypeMetaKey: "Desktop"})
	desktop := addProjectTab(t, ctx, wsId, "Desktop", nil, notuliaDir)
	mobile := addProjectTab(t, ctx, wsId, "Mobile", nil, notuliaDir+"/apps")
	site := addProjectTab(t, ctx, wsId, "site", nil, notuliaWebsiteDir)
	lost := addProjectTab(t, ctx, wsId, "lost", nil, "/tmp/elsewhere")
	tile := addProjectTab(t, ctx, wsId, "Cadrage", pinnedTabMeta(), notuliaWebsiteDir)
	projectTab := addProjectTab(t, ctx, wsId, "Project", waveobj.MetaMapType{mission.ProjectTabMetaKey: true}, "")
	activate(t, ctx, wsId, site)
	if err := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Workspace, wsId), notuliaMeta(), false); err != nil {
		t.Fatal(err)
	}
	if err := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Workspace, wsId), waveobj.MetaMapType{projectviews.CurrentProjectMetaKey: "p1"}, false); err != nil {
		t.Fatal(err)
	}
	before := workspaceOf(t, ctx, wsId)
	tabsBefore := map[string]*waveobj.Tab{}
	for _, id := range before.TabIds {
		tabsBefore[id], _ = wstore.DBGet[*waveobj.Tab](ctx, id)
	}
	blocksBefore := countObjs[*waveobj.Block](t, ctx, waveobj.OType_Block)

	if err := AssignProjectViewsAtStartup(ctx); err != nil {
		t.Fatal(err)
	}
	ws := workspaceOf(t, ctx, wsId)
	owners := projectviews.ReadTabProjects(ws.Meta)
	want := map[string]string{desktop: "p1", mobile: "p1", site: "p2", lost: "p1"}
	for id, project := range want {
		if owners[id] != project {
			t.Errorf("view %s is p%s's, got %q", id, project, owners[id])
		}
	}
	if _, ok := owners[tile]; ok {
		t.Errorf("a pinned view stays every project's")
	}
	if _, ok := owners[projectTab]; ok {
		t.Errorf("the Project tab stays every project's")
	}
	if !ws.Meta.GetBool(projectviews.AssignedMetaKey, false) {
		t.Errorf("the assignment is marked done")
	}
	if projectviews.CurrentProjectId(ws.Meta) != "p2" || ws.ActiveTabId != site {
		t.Errorf("the project shown follows the view shown, nothing changes on screen: current %q, active %q",
			projectviews.CurrentProjectId(ws.Meta), ws.ActiveTabId)
	}
	if !slices.Equal(ws.TabIds, before.TabIds) {
		t.Errorf("no tab closed, added or moved: %v, was %v", ws.TabIds, before.TabIds)
	}
	if got := countObjs[*waveobj.Block](t, ctx, waveobj.OType_Block); got != blocksBefore {
		t.Errorf("no panel closed or rebuilt: %d blocks, was %d", got, blocksBefore)
	}
	for id, was := range tabsBefore {
		now, _ := wstore.DBGet[*waveobj.Tab](ctx, id)
		if !slices.Equal(now.BlockIds, was.BlockIds) || now.LayoutState != was.LayoutState || now.Name != was.Name {
			t.Errorf("tab %s was touched: %+v, was %+v", id, now, was)
		}
		if now.Meta.HasKey(projectviews.ViewProjectHintMetaKey) || len(now.Meta) != len(was.Meta) {
			t.Errorf("a tab's meta is not written by the assignment: %v, was %v", now.Meta, was.Meta)
		}
	}

	// Idempotent: a second start changes nothing, even when the developer moved on meanwhile.
	activate(t, ctx, wsId, desktop)
	snapshot := workspaceOf(t, ctx, wsId)
	if err := AssignProjectViewsAtStartup(ctx); err != nil {
		t.Fatal(err)
	}
	again := workspaceOf(t, ctx, wsId)
	if !slices.Equal(again.TabIds, snapshot.TabIds) || again.ActiveTabId != snapshot.ActiveTabId ||
		projectviews.CurrentProjectId(again.Meta) != projectviews.CurrentProjectId(snapshot.Meta) {
		t.Errorf("a second assignment changed the workspace: %+v, was %+v", again.Meta, snapshot.Meta)
	}
}

// Adding a second project whose folder holds the terminal of the view on screen: that view belongs to the new project,
// so the project shown follows it instead of the view being hidden.
func TestAddingAProjectThatHoldsTheViewOnScreenMakesItCurrent(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	wsId := makeProjectWorkspace(t, ctx, waveobj.MetaMapType{projectviews.LiveProjectMetaKey: notuliaDir, projectviews.LiveTypeMetaKey: "Desktop"})
	other := addProjectTab(t, ctx, wsId, "other", nil, notuliaDir)
	site := addProjectTab(t, ctx, wsId, "site", nil, notuliaWebsiteDir)
	activate(t, ctx, wsId, site)
	// The workspace now lists the website too, as the window writes it, then asks for the assignment.
	if err := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Workspace, wsId), notuliaMeta(), false); err != nil {
		t.Fatal(err)
	}
	if _, err := assignViews(ctx, projectviews.AssignRequest{WorkspaceId: wsId}); err != nil {
		t.Fatal(err)
	}
	ws := workspaceOf(t, ctx, wsId)
	owners := projectviews.ReadTabProjects(ws.Meta)
	if owners[site] != "p2" || owners[other] != "p1" {
		t.Fatalf("owners %v", owners)
	}
	if projectviews.CurrentProjectId(ws.Meta) != "p2" || ws.Meta.GetString(projectviews.LiveProjectMetaKey, "") != notuliaWebsiteDir || ws.ActiveTabId != site {
		t.Fatalf("the project shown follows the view on screen: current %q, active %q", projectviews.CurrentProjectId(ws.Meta), ws.ActiveTabId)
	}
}

func TestStartupAssignmentLeavesASingleProjectWorkspaceAlone(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	wsId := makeProjectWorkspace(t, ctx, waveobj.MetaMapType{projectviews.LiveProjectMetaKey: notuliaDir})
	addProjectTab(t, ctx, wsId, "a", nil, notuliaDir)
	before := workspaceOf(t, ctx, wsId)
	if err := AssignProjectViewsAtStartup(ctx); err != nil {
		t.Fatal(err)
	}
	after := workspaceOf(t, ctx, wsId)
	if len(after.Meta) != len(before.Meta) || after.Meta.HasKey(projectviews.AssignedMetaKey) {
		t.Fatalf("one project: nothing is written, %v was %v", after.Meta, before.Meta)
	}
}

// The bug of the recording (#1760): the Project tab closed on one project was made again on the next switch.
func TestAProjectTabClosedOnOneProjectStaysClosedAcrossSwitches(t *testing.T) {
	initWorkspaceViewStores(t)
	ctx := context.Background()
	meta := notuliaMeta()
	meta[mission.ProjectTabDirMetaKey] = notuliaDir
	wsId := makeProjectWorkspace(t, ctx, meta)
	addProjectTab(t, ctx, wsId, "a1", nil, "")
	oref := waveobj.MakeORef(waveobj.OType_Workspace, wsId)
	tabsBefore := workspaceOf(t, ctx, wsId).TabIds

	for i, project := range []projectviews.Project{
		{Id: "p2", Type: "Website", Dir: notuliaWebsiteDir},
		{Id: "p1", Type: "Desktop", Dir: notuliaDir},
		{Id: "p2", Type: "Website", Dir: notuliaWebsiteDir},
	} {
		if err := wstore.UpdateObjectMeta(ctx, oref, projectviews.LiveUpdate(project), false); err != nil {
			t.Fatal(err)
		}
		res, err := ensureProjectTab(ctx, mission.ProjectTabRequest{WorkspaceId: wsId})
		if err != nil {
			t.Fatalf("switch %d: %v", i, err)
		}
		if !res.Closed || res.Created || res.TabId != "" {
			t.Fatalf("switch %d to %s: the Project tab the user closed stays closed: %+v", i, project.Id, res)
		}
		if got := workspaceOf(t, ctx, wsId).TabIds; !slices.Equal(got, tabsBefore) {
			t.Fatalf("switch %d: a tab was made: %v, was %v", i, got, tabsBefore)
		}
	}
}
