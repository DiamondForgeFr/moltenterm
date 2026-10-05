// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// Mission Control's overview is the Project view (FR-MC-020): it absorbed the Timeline (#233). A saved layout or a
// stale block definition holding a Timeline block opens the Project view in its place.

const (
	// must match MoltentermProjectView in frontend/moltenterm-shell/project/project-model.ts and ProjectView in
	// pkg/molten/mission/projecttab.go
	ProjectOverviewView = "molten-project"
	// must match LegacyTimelineView in frontend/moltenterm-shell/project/project-model.ts
	LegacyTimelineView = "molten-timeline"
)

// ProjectOverviewBlockMeta returns the meta of a block that held the Timeline, switched to the Project view, and whether
// it differs from blockMeta (which is never modified). The Timeline kept nothing of its own in the meta, so every other
// key is kept as is.
func ProjectOverviewBlockMeta(blockMeta waveobj.MetaMapType) (waveobj.MetaMapType, bool) {
	if blockMeta == nil || blockMeta.GetString(waveobj.MetaKey_View, "") != LegacyTimelineView {
		return blockMeta, false
	}
	rtn := make(waveobj.MetaMapType, len(blockMeta))
	for k, v := range blockMeta {
		rtn[k] = v
	}
	rtn[waveobj.MetaKey_View] = ProjectOverviewView
	return rtn, true
}
