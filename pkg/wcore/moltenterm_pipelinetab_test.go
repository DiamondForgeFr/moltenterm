// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// The tab opens on the setup panel alone: no terminal until the developer asks for help.
func TestPipelineTabLayout(t *testing.T) {
	layout := pipelineTabLayout(mission.PipelineTabRequest{WorkspaceId: "ws", Dir: "/work/app/", Project: "App", OpenAt: "understand"})
	if len(layout) != 1 {
		t.Fatalf("got %d panels, want the setup panel alone", len(layout))
	}
	panel := layout[0]
	if panel.BlockDef.Meta.GetString(waveobj.MetaKey_View, "") != mission.PipelineView || !panel.Focused || *panel.Size != 10 {
		t.Errorf("setup panel: %+v", panel)
	}
	target, ok := panel.BlockDef.Meta[mission.PipelinePanelMetaKey].(mission.PipelineTabTarget)
	if !ok || target.Dir != "/work/app" || target.Project != "App" || target.OpenAt != "understand" {
		t.Errorf("setup panel's target: %+v", panel.BlockDef.Meta[mission.PipelinePanelMetaKey])
	}
}
