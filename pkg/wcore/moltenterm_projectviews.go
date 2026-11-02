// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"fmt"
	"log"
	"maps"
	"slices"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/molten/projectviews"
	"github.com/wavetermdev/waveterm/pkg/molten/viewpin"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// The views of a workspace with two projects or more belong to its projects (FR-SHELL-087, #1760). A temporary view
// belongs to the project it was opened in: the workspace's meta maps each such tab to a project, the tab bars, the
// sidebar and the next active tab show a project's own views, and a project switch lands on the view last shown in
// the project. A view pinned in the workspace or everywhere, and the Project tab, belong to every project. Nothing here
// closes, moves or rebuilds a tab or a panel: the other projects' views are filtered out of sight, and their terminals
// and agents keep running. The rules are pure, in pkg/molten/projectviews.

var projectViewsLock sync.Mutex

// sharedTabMeta says a tab belongs to every project: the Project tab, and a view pinned in the workspace or everywhere
// (a template's view not opened yet is one).
func sharedTabMeta(meta waveobj.MetaMapType) bool {
	if meta.GetBool(mission.ProjectTabMetaKey, false) || meta.GetBool(ViewPendingMetaKey, false) {
		return true
	}
	if meta.GetString(viewpin.PinMetaKey, "") == viewpin.PinWorkspace && meta[viewpin.PinConfigMetaKey] != nil {
		return true
	}
	return meta.GetString(viewpin.GlobalPinMetaKey, "") != ""
}

// moltenStampTabProject gives a tab made in a workspace with two projects or more its project (createTabObj): the
// project the caller named in the tab's hint (a reopened view goes back to its own project), else the current one. The
// hint never stays on the tab. A view that is shared stays out of the map.
func moltenStampTabProject(ws *waveobj.Workspace, tab *waveobj.Tab) {
	hint := tab.Meta.GetString(projectviews.ViewProjectHintMetaKey, "")
	if tab.Meta.HasKey(projectviews.ViewProjectHintMetaKey) {
		meta := maps.Clone(tab.Meta)
		delete(meta, projectviews.ViewProjectHintMetaKey)
		tab.Meta = meta
	}
	if !projectviews.Multi(ws.Meta) || sharedTabMeta(tab.Meta) {
		return
	}
	projects := projectviews.ReadProjects(ws.Meta)
	id := hint
	if _, ok := projectviews.FindProject(projects, id); !ok {
		id = projectviews.CurrentProjectId(ws.Meta)
	}
	owners := projectviews.ReadTabProjects(ws.Meta)
	owners[tab.OID] = id
	writeTabProjects(ws, owners)
}

func writeTabProjects(ws *waveobj.Workspace, owners map[string]string) {
	if ws.Meta == nil {
		ws.Meta = waveobj.MetaMapType{}
	}
	if value := projectviews.MapValue(owners); value != nil {
		ws.Meta[projectviews.TabProjectsMetaKey] = value
		return
	}
	delete(ws.Meta, projectviews.TabProjectsMetaKey)
}

func writeActiveByProject(ws *waveobj.Workspace, active map[string]string) {
	if ws.Meta == nil {
		ws.Meta = waveobj.MetaMapType{}
	}
	if value := projectviews.MapValue(active); value != nil {
		ws.Meta[projectviews.ActiveByProjectMetaKey] = value
		return
	}
	delete(ws.Meta, projectviews.ActiveByProjectMetaKey)
}

// moltenTabMetaWithProject adds the project hint to the meta a closed view is recorded with, so reopening it goes
// back to its own project.
func moltenTabMetaWithProject(ws *waveobj.Workspace, tabId string, meta waveobj.MetaMapType) waveobj.MetaMapType {
	if ws == nil || meta == nil || !projectviews.Multi(ws.Meta) {
		return meta
	}
	if id := projectviews.ReadTabProjects(ws.Meta)[tabId]; id != "" {
		meta[projectviews.ViewProjectHintMetaKey] = id
	}
	return meta
}

// moltenFollowTabProject makes the project of the tab that is now shown the current one, and remembers the tab as the
// last view of its project. A tab no project owns changes nothing: it shows whichever project is current (the caller
// saves the workspace).
func moltenFollowTabProject(ws *waveobj.Workspace, tabId string) {
	if !projectviews.Multi(ws.Meta) {
		return
	}
	owner := projectviews.ReadTabProjects(ws.Meta)[tabId]
	if owner == "" {
		return
	}
	if update, ok := projectviews.SwitchMeta(ws.Meta, owner); ok {
		ws.Meta = waveobj.MergeMeta(ws.Meta, update, false)
	}
	active := projectviews.ReadActiveByProject(ws.Meta)
	if active[owner] != tabId {
		active[owner] = tabId
		writeActiveByProject(ws, active)
	}
}

// moltenOtherProjectTabs lists the tabs the project does not show, which the next active tab and the tab history skip.
func moltenOtherProjectTabs(ws *waveobj.Workspace, projectId string) []string {
	if !projectviews.Multi(ws.Meta) {
		return nil
	}
	return projectviews.OtherProjectTabs(ws.TabIds, projectviews.ReadTabProjects(ws.Meta), projectviews.ReadProjects(ws.Meta), projectId)
}

// moltenCurrentProjectOfTab is the project a tab is shown in: its own, else the current one.
func moltenProjectOfTab(ws *waveobj.Workspace, tabId string) string {
	if id := projectviews.ReadTabProjects(ws.Meta)[tabId]; id != "" {
		return id
	}
	return projectviews.CurrentProjectId(ws.Meta)
}

// moltenPruneProjectMaps drops the closed tabs from the maps (the tab list is already without them).
func moltenPruneProjectMaps(ws *waveobj.Workspace) {
	_, hasOwners := ws.Meta[projectviews.TabProjectsMetaKey]
	_, hasActive := ws.Meta[projectviews.ActiveByProjectMetaKey]
	if !hasOwners && !hasActive {
		return
	}
	projects := projectviews.ReadProjects(ws.Meta)
	owners, active := projectviews.Prune(ws.TabIds, projects, projectviews.ReadTabProjects(ws.Meta), projectviews.ReadActiveByProject(ws.Meta))
	writeTabProjects(ws, owners)
	writeActiveByProject(ws, active)
}

// moltenKeepOtherProjectTabs puts back at the end the tabs a tab bar did not send because another project owns them.
func moltenKeepOtherProjectTabs(ws *waveobj.Workspace, tabIds []string) []string {
	rtn := slices.Clone(tabIds)
	for _, id := range moltenOtherProjectTabs(ws, projectviews.CurrentProjectId(ws.Meta)) {
		if !slices.Contains(rtn, id) {
			rtn = append(rtn, id)
		}
	}
	return rtn
}

func agentBlockSet() map[string]bool {
	rtn := map[string]bool{}
	for _, info := range attention.AgentStatesSnapshot() {
		rtn[info.BlockId] = true
	}
	return rtn
}

// readTabFacts reads where a view's panels are: the folder of each terminal and file panel, and which terminal holds an
// agent (one the agent states know, or one that kept an agent's first name in its meta across a restart).
func readTabFacts(ctx context.Context, tab *waveobj.Tab, agents map[string]bool) projectviews.TabFacts {
	facts := projectviews.TabFacts{Id: tab.OID, ProjectTab: tab.Meta.GetBool(mission.ProjectTabMetaKey, false)}
	for _, blockId := range tab.BlockIds {
		block, _ := wstore.DBGet[*waveobj.Block](ctx, blockId)
		if block == nil {
			continue
		}
		switch block.Meta.GetString(waveobj.MetaKey_View, "") {
		case "term":
			facts.Panes = append(facts.Panes, projectviews.PaneFact{
				Dir:   block.Meta.GetString(waveobj.MetaKey_CmdCwd, ""),
				Agent: agents[blockId] || block.Meta.GetString(molten.AgentFirstNameMetaKey, "") != "",
			})
		case "preview":
			facts.Panes = append(facts.Panes, projectviews.PaneFact{Dir: block.Meta.GetString(waveobj.MetaKey_File, "")})
		}
	}
	return facts
}

// assignProjectViews gives every temporary view that no project owns its project (the first agent panel's folder, then
// the folders most panels are in, else the fallback), and takes a view that is pinned out of the map. It writes the
// workspace's meta in ws and returns what it mapped, tab by tab.
func assignProjectViews(ctx context.Context, ws *waveobj.Workspace, fallback string) (map[string]string, error) {
	if !projectviews.Multi(ws.Meta) {
		return nil, nil
	}
	projects := projectviews.ReadProjects(ws.Meta)
	owners := projectviews.ReadTabProjects(ws.Meta)
	agents := agentBlockSet()
	var unmapped []projectviews.TabFacts
	changed := false
	for _, tabId := range ws.TabIds {
		tab, _ := wstore.DBGet[*waveobj.Tab](ctx, tabId)
		if tab == nil {
			continue
		}
		if sharedTabMeta(tab.Meta) {
			if owners[tabId] != "" {
				delete(owners, tabId)
				changed = true
			}
			continue
		}
		if _, known := projectviews.FindProject(projects, owners[tabId]); known {
			continue
		}
		unmapped = append(unmapped, readTabFacts(ctx, tab, agents))
	}
	added := projectviews.Assign(projects, owners, unmapped, fallback)
	maps.Copy(owners, added)
	if changed || len(added) > 0 {
		writeTabProjects(ws, owners)
	}
	return added, nil
}

// MoltenTabMetaChanged keeps the map right when a view is pinned or made temporary: a view pinned is every project's,
// and one made temporary belongs to the project the developer is working in. wshserver calls it after a tab's meta
// was set; only a patch that touches a pin key does anything.
func MoltenTabMetaChanged(ctx context.Context, tabId string, patch waveobj.MetaMapType) {
	if !patch.HasKey(viewpin.PinMetaKey) && !patch.HasKey(viewpin.PinConfigMetaKey) && !patch.HasKey(viewpin.GlobalPinMetaKey) {
		return
	}
	wsId, err := wstore.DBFindWorkspaceForTabId(ctx, tabId)
	if err != nil || wsId == "" {
		return
	}
	projectViewsLock.Lock()
	defer projectViewsLock.Unlock()
	changed, err := wstore.WithTxRtn(ctx, func(tx *wstore.TxWrap) (bool, error) {
		tctx := tx.Context()
		ws, err := GetWorkspace(tctx, wsId)
		if err != nil || !projectviews.Multi(ws.Meta) {
			return false, err
		}
		tab, _ := wstore.DBGet[*waveobj.Tab](tctx, tabId)
		if tab == nil || tab.Meta.GetBool(mission.ProjectTabMetaKey, false) {
			return false, nil
		}
		owners := projectviews.ReadTabProjects(ws.Meta)
		_, mapped := owners[tabId]
		switch {
		case sharedTabMeta(tab.Meta) && mapped:
			delete(owners, tabId)
		case !sharedTabMeta(tab.Meta) && !mapped:
			owners[tabId] = projectviews.CurrentProjectId(ws.Meta)
		default:
			return false, nil
		}
		writeTabProjects(ws, owners)
		return true, wstore.DBUpdate(tctx, ws)
	})
	if err != nil {
		log.Printf("molten: project of view %s after a pin change: %v\n", tabId, err)
		return
	}
	if changed {
		SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Workspace, wsId))
	}
}

func tabInfosOf(ctx context.Context, ws *waveobj.Workspace) []projectviews.TabInfo {
	owners := projectviews.ReadTabProjects(ws.Meta)
	hidden := molten.HiddenTabIds(ws)
	rtn := make([]projectviews.TabInfo, 0, len(ws.TabIds))
	for _, id := range ws.TabIds {
		info := projectviews.TabInfo{Id: id, Project: owners[id], Hidden: slices.Contains(hidden, id)}
		if tab, _ := wstore.DBGet[*waveobj.Tab](ctx, id); tab != nil {
			info.ProjectTab = tab.Meta.GetBool(mission.ProjectTabMetaKey, false)
			if sharedTabMeta(tab.Meta) {
				info.Project = ""
			}
		}
		rtn = append(rtn, info)
	}
	return rtn
}

func sendProjectViewUpdates(ctx context.Context) {
	updates := waveobj.ContextGetUpdatesRtn(ctx)
	if len(updates) == 0 {
		return
	}
	go func() {
		defer func() {
			panichandler.PanicHandler("projectviews:SendUpdateEvents", recover())
		}()
		wps.Broker.SendUpdateEvents(updates)
	}()
}

// switchProject makes another project of the workspace current and shows the view the plan lands on, in one call under
// one lock. The views of the project left are not touched: they are filtered out of sight, their terminals and agents
// keep running.
func switchProject(ctx context.Context, req projectviews.SwitchRequest) (projectviews.Result, error) {
	projectViewsLock.Lock()
	defer projectViewsLock.Unlock()
	ctx = waveobj.ContextWithUpdates(ctx)
	defer sendProjectViewUpdates(ctx)
	var plan projectviews.SwitchPlan
	err := wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
		tctx := tx.Context()
		ws, err := GetWorkspace(tctx, req.WorkspaceId)
		if err != nil {
			return err
		}
		projects := projectviews.ReadProjects(ws.Meta)
		if _, ok := projectviews.FindProject(projects, req.ProjectId); !ok {
			return fmt.Errorf("the workspace has no project %q", req.ProjectId)
		}
		if !projectviews.Multi(ws.Meta) {
			return fmt.Errorf("a workspace with one project has nothing to switch")
		}
		leaving := projectviews.CurrentProjectId(ws.Meta)
		if _, err := assignProjectViews(tctx, ws, leaving); err != nil {
			return err
		}
		update, ok := projectviews.SwitchMeta(ws.Meta, req.ProjectId)
		if !ok {
			plan = projectviews.SwitchPlan{Show: ws.ActiveTabId, ShowMade: -1}
			return wstore.DBUpdate(tctx, ws)
		}
		ws.Meta = waveobj.MergeMeta(ws.Meta, update, false)
		plan = projectviews.PlanSwitch(projectviews.SwitchInput{
			Tabs:       tabInfosOf(tctx, ws),
			Projects:   projectviews.ReadProjects(ws.Meta),
			To:         req.ProjectId,
			Active:     ws.ActiveTabId,
			Remembered: projectviews.ReadActiveByProject(ws.Meta),
		})
		return wstore.DBUpdate(tctx, ws)
	})
	if err != nil {
		return projectviews.Result{}, err
	}
	tabId := plan.Show
	if plan.NewView {
		newId, err := CreateTab(ctx, req.WorkspaceId, "", true, false)
		if err != nil {
			return projectviews.Result{}, err
		}
		tabId = newId
	} else if tabId != "" {
		if err := SetActiveTab(ctx, req.WorkspaceId, tabId); err != nil {
			return projectviews.Result{}, err
		}
	}
	if tabId != "" {
		SendActiveTabUpdate(ctx, req.WorkspaceId, tabId)
	}
	return projectviews.Result{TabId: tabId}, nil
}

// removeProject takes a project out of the workspace: its views go to the project that takes over and none closes.
func removeProject(ctx context.Context, req projectviews.RemoveRequest) (projectviews.Result, error) {
	projectViewsLock.Lock()
	defer projectViewsLock.Unlock()
	ctx = waveobj.ContextWithUpdates(ctx)
	defer sendProjectViewUpdates(ctx)
	err := wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
		tctx := tx.Context()
		ws, err := GetWorkspace(tctx, req.WorkspaceId)
		if err != nil {
			return err
		}
		projects := projectviews.ReadProjects(ws.Meta)
		if len(projects) < 2 {
			return fmt.Errorf("a workspace keeps at least one project")
		}
		if _, ok := projectviews.FindProject(projects, req.ProjectId); !ok {
			return fmt.Errorf("the workspace has no project %q", req.ProjectId)
		}
		if _, err := assignProjectViews(tctx, ws, projectviews.CurrentProjectId(ws.Meta)); err != nil {
			return err
		}
		current := projectviews.CurrentProjectId(ws.Meta)
		var next []projectviews.Project
		for _, p := range projects {
			if p.Id != req.ProjectId {
				next = append(next, p)
			}
		}
		takeover := current
		if current == req.ProjectId {
			takeover = next[0].Id
		}
		plan := projectviews.PlanRemove(projectviews.RemoveInput{Tabs: tabInfosOf(tctx, ws), Removed: req.ProjectId, NewCurrent: takeover})
		owners := projectviews.ReadTabProjects(ws.Meta)
		maps.Copy(owners, plan.Move)
		meta := waveobj.MetaMapType{projectviews.ProjectsMetaKey: projectviews.ListValue(next)}
		if current == req.ProjectId {
			maps.Copy(meta, projectviews.LiveUpdate(next[0]))
		}
		ws.Meta = waveobj.MergeMeta(ws.Meta, meta, false)
		if len(next) < 2 {
			delete(ws.Meta, projectviews.TabProjectsMetaKey)
			delete(ws.Meta, projectviews.ActiveByProjectMetaKey)
		} else {
			active := projectviews.ReadActiveByProject(ws.Meta)
			delete(active, req.ProjectId)
			writeTabProjects(ws, owners)
			writeActiveByProject(ws, active)
		}
		return wstore.DBUpdate(tctx, ws)
	})
	return projectviews.Result{}, err
}

// assignViews gives the views a workspace has their projects, once a project was added. Views stay with the first
// project unless their panels' folders say another.
func assignViews(ctx context.Context, req projectviews.AssignRequest) (projectviews.Result, error) {
	projectViewsLock.Lock()
	defer projectViewsLock.Unlock()
	ctx = waveobj.ContextWithUpdates(ctx)
	defer sendProjectViewUpdates(ctx)
	err := wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
		tctx := tx.Context()
		ws, err := GetWorkspace(tctx, req.WorkspaceId)
		if err != nil || !projectviews.Multi(ws.Meta) {
			return err
		}
		projects := projectviews.ReadProjects(ws.Meta)
		if _, err := assignProjectViews(tctx, ws, projects[0].Id); err != nil {
			return err
		}
		return wstore.DBUpdate(tctx, ws)
	})
	return projectviews.Result{}, err
}

// AssignProjectViewsAtStartup gives the views of every workspace with two projects or more their projects, once. It
// writes workspace meta only: no tab or panel is closed, moved or rebuilt, and the project shown follows the view
// shown, so nothing changes on screen.
func AssignProjectViewsAtStartup(ctx context.Context) error {
	projectViewsLock.Lock()
	defer projectViewsLock.Unlock()
	all, err := wstore.DBGetAllObjsByType[*waveobj.Workspace](ctx, waveobj.OType_Workspace)
	if err != nil {
		return err
	}
	for _, listed := range all {
		if err := assignWorkspaceAtStartup(ctx, listed.OID); err != nil {
			log.Printf("molten: giving the views of workspace %s their projects: %v\n", listed.OID, err)
		}
	}
	return nil
}

func assignWorkspaceAtStartup(ctx context.Context, wsId string) error {
	return wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
		tctx := tx.Context()
		ws, err := GetWorkspace(tctx, wsId)
		if err != nil || !projectviews.Multi(ws.Meta) || ws.Meta.GetBool(projectviews.AssignedMetaKey, false) {
			return err
		}
		added, err := assignProjectViews(tctx, ws, projectviews.CurrentProjectId(ws.Meta))
		if err != nil {
			return err
		}
		moltenFollowTabProject(ws, ws.ActiveTabId)
		ws.Meta[projectviews.AssignedMetaKey] = true
		log.Printf("molten: workspace %s: %d views given a project (meta only)\n", wsId, len(added))
		return wstore.DBUpdate(tctx, ws)
	})
}

// StartProjectViewsRoute lets the windows switch, add and remove projects; wavesrv calls it once.
func StartProjectViewsRoute() {
	projectviews.StartRoute(projectviews.Store{Switch: switchProject, Remove: removeProject, Assign: assignViews})
}
