// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// The pipeline setup's tab (FR-MC-038, #1150) is made here, where the tabs live; pkg/molten/mission holds its key,
// its name and its lock.

func init() {
	mission.UsePipelineTabs(openPipelineTab)
}

// pipelineTabLayout: the setup panel alone; the agent's terminal opens on its left when the developer asks for help.
func pipelineTabLayout(req mission.PipelineTabRequest) PortableLayout {
	panelSize := mission.PipelinePanelNodeSize
	return PortableLayout{
		{IndexArr: []int{0}, Size: &panelSize, Focused: true, BlockDef: &waveobj.BlockDef{Meta: waveobj.MetaMapType{
			waveobj.MetaKey_View:         mission.PipelineView,
			mission.PipelinePanelMetaKey: mission.PipelineTarget(req),
		}}},
	}
}

func findPipelineTab(ctx context.Context, ws *waveobj.Workspace, key string) string {
	keys := make([]string, len(ws.TabIds))
	for i, tabId := range ws.TabIds {
		tab, err := wstore.DBGet[*waveobj.Tab](ctx, tabId)
		if err != nil || tab == nil {
			continue
		}
		keys[i] = tab.Meta.GetString(mission.PipelineTabMetaKey, "")
	}
	return mission.FindPipelineTab(keys, ws.TabIds, key)
}

func openPipelineTab(ctx context.Context, req mission.PipelineTabRequest) (mission.PipelineTabResult, error) {
	ws, err := GetWorkspace(ctx, req.WorkspaceId)
	if err != nil {
		return mission.PipelineTabResult{}, err
	}
	key := mission.PipelineTabKey(req.Dir)
	if tabId := findPipelineTab(ctx, ws, key); tabId != "" {
		return mission.PipelineTabResult{TabId: tabId}, nil
	}
	ctx = waveobj.ContextWithUpdates(ctx)
	tabId, err := CreateTab(ctx, req.WorkspaceId, mission.PipelineTabName(req), false, true)
	if err != nil {
		return mission.PipelineTabResult{}, err
	}
	tabORef := waveobj.MakeORef(waveobj.OType_Tab, tabId)
	if err := wstore.UpdateObjectMeta(ctx, tabORef, waveobj.MetaMapType{mission.PipelineTabMetaKey: key}, false); err != nil {
		return mission.PipelineTabResult{}, err
	}
	if err := ApplyPortableLayout(ctx, tabId, pipelineTabLayout(req), true); err != nil {
		if _, delErr := DeleteTab(ctx, req.WorkspaceId, tabId, false); delErr != nil {
			return mission.PipelineTabResult{}, fmt.Errorf("placing the setup panel: %w (and the tab stays: %v)", err, delErr)
		}
		return mission.PipelineTabResult{}, fmt.Errorf("placing the setup panel: %w", err)
	}
	wps.Broker.SendUpdateEvents(waveobj.ContextGetUpdatesRtn(ctx))
	SendWaveObjUpdate(tabORef)
	return mission.PipelineTabResult{TabId: tabId, Created: true}, nil
}
