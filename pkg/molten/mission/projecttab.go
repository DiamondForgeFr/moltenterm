// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"fmt"
	"sync"
)

// The Project tab (FR-SHELL-015, DS-SHELL-015): a workspace linked to a project gets one tab, first in the strip,
// holding the project view. wavesrv decides whether to make it, under one lock, so the windows asking at the same time
// (startup, a link from molten, a second window) never get two. A tab the user closed is not made again until they
// ask: the workspace records the project the tab was made for, and a recorded project without its tab is a choice.

const (
	ProjectTabCommand = "moltenmissionprojecttab"
	// Tab meta: this tab is the workspace's Project tab.
	ProjectTabMetaKey = "molten:projecttab"
	// Workspace meta: the project folder the Project tab was last made for.
	ProjectTabDirMetaKey = "molten:projecttabdir"
	ProjectTabName       = "Project"
	// must match MoltentermProjectView in frontend/moltenterm-shell/project/project-model.ts
	ProjectView = "molten-project"
)

const (
	ProjectTabKeep    = "keep"
	ProjectTabCreate  = "create"
	ProjectTabNone    = "none"
	ProjectTabClear   = "clear"
	ProjectTabClosed  = "closed"
	ProjectTabRestore = "restore"
)

type ProjectTabRequest struct {
	WorkspaceId string `json:"workspaceid"`
	// The user asked for it (palette, rail): made again even after a close.
	Open bool `json:"open,omitempty"`
	// Makes it the workspace's active tab, for a window about to show the workspace.
	Activate bool `json:"activate,omitempty"`
}

type ProjectTabResult struct {
	TabId   string `json:"tabid,omitempty"`
	Created bool   `json:"created,omitempty"`
	// The user closed it for this project: nothing is made until they ask.
	Closed bool `json:"closed,omitempty"`
	// The tab still holds the project view (the user may have replaced its pane).
	HasView bool `json:"hasview,omitempty"`
}

// ProjectTabFacts is what the decision reads from the workspace.
type ProjectTabFacts struct {
	Dir         string
	RecordedDir string
	// The marked tab, when the workspace has one.
	TabId string
	// The marked tab holds a project view.
	HasView bool
}

// DecideProjectTab says what to do for a workspace, from what it holds and whether the user asked.
func DecideProjectTab(facts ProjectTabFacts, open bool) string {
	if facts.TabId != "" {
		if open && !facts.HasView {
			return ProjectTabRestore
		}
		return ProjectTabKeep
	}
	if open {
		return ProjectTabCreate
	}
	if facts.Dir == "" {
		if facts.RecordedDir != "" {
			return ProjectTabClear
		}
		return ProjectTabNone
	}
	if facts.RecordedDir == facts.Dir {
		return ProjectTabClosed
	}
	return ProjectTabCreate
}

var projectTabs struct {
	lock   sync.Mutex
	ensure func(ctx context.Context, req ProjectTabRequest) (ProjectTabResult, error)
}

// UseProjectTabs lets wcore, which owns the tabs and cannot be imported from here, carry the Project tab out.
func UseProjectTabs(ensure func(ctx context.Context, req ProjectTabRequest) (ProjectTabResult, error)) {
	projectTabs.lock.Lock()
	defer projectTabs.lock.Unlock()
	projectTabs.ensure = ensure
}

func ensureProjectTab(req ProjectTabRequest) (ProjectTabResult, error) {
	projectTabs.lock.Lock()
	defer projectTabs.lock.Unlock()
	if projectTabs.ensure == nil {
		return ProjectTabResult{}, fmt.Errorf("the Project tab is not available")
	}
	if req.WorkspaceId == "" {
		return ProjectTabResult{}, fmt.Errorf("no workspace given")
	}
	ctx, cancel := context.WithTimeout(context.Background(), worktreeTimeout)
	defer cancel()
	return projectTabs.ensure(ctx, req)
}
