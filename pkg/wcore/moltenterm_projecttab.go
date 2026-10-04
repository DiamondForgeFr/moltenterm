// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"fmt"
	"slices"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// The Project tab (FR-SHELL-015) is made here, where the tabs live; pkg/molten/mission decides when, under its lock.

func init() {
	mission.UseProjectTabs(ensureProjectTab)
}

func projectTabBlockDef() *waveobj.BlockDef {
	return &waveobj.BlockDef{Meta: waveobj.MetaMapType{waveobj.MetaKey_View: mission.ProjectView}}
}

// readProjectTabFacts finds the workspace's marked tab and whether it still holds a project view.
func readProjectTabFacts(ctx context.Context, ws *waveobj.Workspace) mission.ProjectTabFacts {
	facts := mission.ProjectTabFacts{
		Dir:         ws.Meta.GetString(molten.ProjectMetaKey, ""),
		RecordedDir: ws.Meta.GetString(mission.ProjectTabDirMetaKey, ""),
	}
	for _, tabId := range ws.TabIds {
		tab, _ := wstore.DBGet[*waveobj.Tab](ctx, tabId)
		if tab == nil || !tab.Meta.GetBool(mission.ProjectTabMetaKey, false) {
			continue
		}
		facts.TabId = tabId
		for _, blockId := range tab.BlockIds {
			block, _ := wstore.DBGet[*waveobj.Block](ctx, blockId)
			if block != nil && block.Meta.GetString(waveobj.MetaKey_View, "") == mission.ProjectView {
				facts.HasView = true
				break
			}
		}
		return facts
	}
	return facts
}

// createProjectTab makes the tab with its project view, first in the strip, and records the project it was made for.
func createProjectTab(ctx context.Context, wsId string, dir string) (string, error) {
	// An initial-launch tab gets no default terminal: the project view is its only pane.
	tabId, err := CreateTab(ctx, wsId, mission.ProjectTabName, false, true)
	if err != nil {
		return "", err
	}
	tabORef := waveobj.MakeORef(waveobj.OType_Tab, tabId)
	if err := wstore.UpdateObjectMeta(ctx, tabORef, waveobj.MetaMapType{mission.ProjectTabMetaKey: true}, false); err != nil {
		return "", fmt.Errorf("marking the Project tab: %w", err)
	}
	layout := PortableLayout{{IndexArr: []int{0}, BlockDef: projectTabBlockDef(), Focused: true}}
	if err := ApplyPortableLayout(ctx, tabId, layout, false); err != nil {
		return "", fmt.Errorf("placing the project view: %w", err)
	}
	ws, err := GetWorkspace(ctx, wsId)
	if err != nil {
		return "", err
	}
	ws.TabIds = append([]string{tabId}, slices.DeleteFunc(slices.Clone(ws.TabIds), func(id string) bool { return id == tabId })...)
	if dir != "" {
		if ws.Meta == nil {
			ws.Meta = waveobj.MetaMapType{}
		}
		ws.Meta[mission.ProjectTabDirMetaKey] = dir
	}
	if err := wstore.DBUpdate(ctx, ws); err != nil {
		return "", fmt.Errorf("placing the Project tab first: %w", err)
	}
	return tabId, nil
}

// restoreProjectView puts a project view back in a marked tab whose pane was replaced, when the user asks for it.
func restoreProjectView(ctx context.Context, tabId string) error {
	block, err := CreateBlockWithTelemetry(ctx, tabId, projectTabBlockDef(), &waveobj.RuntimeOpts{}, false)
	if err != nil {
		return err
	}
	return QueueLayoutActionForTab(ctx, tabId, waveobj.LayoutActionData{
		ActionType: LayoutActionDataType_Insert,
		BlockId:    block.OID,
		Focused:    true,
	})
}

func setProjectTabDir(ctx context.Context, wsId string, dir string) error {
	var value any = dir
	if dir == "" {
		value = nil
	}
	oref := waveobj.MakeORef(waveobj.OType_Workspace, wsId)
	return wstore.UpdateObjectMeta(ctx, oref, waveobj.MetaMapType{mission.ProjectTabDirMetaKey: value}, false)
}

func ensureProjectTab(ctx context.Context, req mission.ProjectTabRequest) (mission.ProjectTabResult, error) {
	ctx = waveobj.ContextWithUpdates(ctx)
	defer func() {
		updates := waveobj.ContextGetUpdatesRtn(ctx)
		if len(updates) == 0 {
			return
		}
		go func() {
			defer func() {
				panichandler.PanicHandler("ensureProjectTab:SendUpdateEvents", recover())
			}()
			wps.Broker.SendUpdateEvents(updates)
		}()
	}()
	ws, err := GetWorkspace(ctx, req.WorkspaceId)
	if err != nil {
		return mission.ProjectTabResult{}, err
	}
	facts := readProjectTabFacts(ctx, ws)
	var result mission.ProjectTabResult
	switch mission.DecideProjectTab(facts, req.Open) {
	case mission.ProjectTabNone:
		return result, nil
	case mission.ProjectTabClosed:
		return mission.ProjectTabResult{Closed: true}, nil
	case mission.ProjectTabClear:
		return result, setProjectTabDir(ctx, ws.OID, "")
	case mission.ProjectTabKeep, mission.ProjectTabRestore:
		result.TabId = facts.TabId
		if mission.DecideProjectTab(facts, req.Open) == mission.ProjectTabRestore {
			if err := restoreProjectView(ctx, facts.TabId); err != nil {
				return result, fmt.Errorf("restoring the project view: %w", err)
			}
		}
		if facts.Dir != "" && facts.RecordedDir != facts.Dir {
			if err := setProjectTabDir(ctx, ws.OID, facts.Dir); err != nil {
				return result, err
			}
		}
	case mission.ProjectTabCreate:
		tabId, err := createProjectTab(ctx, ws.OID, facts.Dir)
		if err != nil {
			return result, err
		}
		result.TabId = tabId
		result.Created = true
	}
	if req.Activate && result.TabId != "" {
		if err := SetActiveTab(ctx, ws.OID, result.TabId); err != nil {
			return result, err
		}
	}
	return result, nil
}
