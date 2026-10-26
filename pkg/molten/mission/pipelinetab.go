// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/pipelinesetup"
)

// The pipeline setup's tab (FR-MC-038, #1150), on the Review tab's pattern (DS-REV-012): one tab per project, holding
// the setup panel; the agent's terminal opens on its left when the developer asks for help (agent left, graphics
// right). An entry whose tab exists focuses it, so the setup is never open twice. wcore makes the tab (it owns tabs
// and layouts); this file holds what it is made of.

const (
	PipelineTabCommand = "moltenmissionpipelinetab"
	// Tab meta: the project folder the tab sets up, its key.
	PipelineTabMetaKey = "molten:pipelinetab"
	// Block meta of the setup panel: its PipelineTabTarget.
	PipelinePanelMetaKey = "molten:pipeline"
	// must match MoltentermPipelineView in frontend/moltenterm-shell/mission/pipeline-tab-model.ts
	PipelineView = "molten-pipeline"
	// The setup panel's share of the tab's width; the terminal the window opens beside it takes 6 (sizes are relative).
	PipelinePanelNodeSize = uint(10)
	pipelineTabTimeout    = 10 * time.Second
	maxPipelineTabName    = 120
)

type PipelineTabRequest struct {
	WorkspaceId string `json:"workspaceid"`
	Dir         string `json:"dir"`
	Project     string `json:"project,omitempty"`
	// TabName: the tab's name in the interface language; "Pipeline · <project>" when empty.
	TabName string `json:"tabname,omitempty"`
	// OpenAt: the step a new tab opens at instead of the saved one (the update opens at step 2, #1102).
	OpenAt string `json:"openat,omitempty"`
}

type PipelineTabResult struct {
	TabId   string `json:"tabid"`
	Created bool   `json:"created,omitempty"`
}

// PipelineTabTarget is what the setup panel shows.
type PipelineTabTarget struct {
	Dir     string `json:"dir"`
	Project string `json:"project,omitempty"`
	OpenAt  string `json:"openat,omitempty"`
}

// PipelineTabKey is the tab's key for a project folder: the cleaned absolute path.
func PipelineTabKey(dir string) string {
	return filepath.Clean(dir)
}

// PipelineTabName is the tab's name: the window's when it sent one, else "Pipeline · <project>".
func PipelineTabName(req PipelineTabRequest) string {
	name := strings.TrimSpace(req.TabName)
	if name != "" && len(name) <= maxPipelineTabName {
		return name
	}
	project := strings.TrimSpace(req.Project)
	if project == "" {
		project = filepath.Base(PipelineTabKey(req.Dir))
	}
	return "Pipeline · " + project
}

// PipelineTarget is the setup panel's meta for the request.
func PipelineTarget(req PipelineTabRequest) PipelineTabTarget {
	return PipelineTabTarget{Dir: PipelineTabKey(req.Dir), Project: strings.TrimSpace(req.Project), OpenAt: req.OpenAt}
}

// FindPipelineTab returns the first tab whose key is the project's, "" when none is.
func FindPipelineTab(tabKeys []string, tabIds []string, key string) string {
	for i, tabKey := range tabKeys {
		if i < len(tabIds) && tabKey != "" && tabKey == key {
			return tabIds[i]
		}
	}
	return ""
}

func checkPipelineTabRequest(req PipelineTabRequest) error {
	if req.WorkspaceId == "" {
		return fmt.Errorf("no workspace given")
	}
	if req.Dir == "" || !filepath.IsAbs(req.Dir) {
		return fmt.Errorf("the project folder must be an absolute path")
	}
	switch req.OpenAt {
	case "", pipelinesetup.StepDetect, pipelinesetup.StepUnderstand, pipelinesetup.StepPrepare, pipelinesetup.StepTemplate:
	default:
		return fmt.Errorf("unknown setup step %q", req.OpenAt)
	}
	return nil
}

var pipelineTabs struct {
	lock sync.Mutex
	open func(ctx context.Context, req PipelineTabRequest) (PipelineTabResult, error)
}

// UsePipelineTabs lets wcore, which owns the tabs and cannot be imported from here, make the tab.
func UsePipelineTabs(open func(ctx context.Context, req PipelineTabRequest) (PipelineTabResult, error)) {
	pipelineTabs.lock.Lock()
	defer pipelineTabs.lock.Unlock()
	pipelineTabs.open = open
}

// openPipelineTab runs under one lock: two clicks at once never make two tabs for a project.
func openPipelineTab(req PipelineTabRequest) (PipelineTabResult, error) {
	if err := checkPipelineTabRequest(req); err != nil {
		return PipelineTabResult{}, err
	}
	pipelineTabs.lock.Lock()
	defer pipelineTabs.lock.Unlock()
	if pipelineTabs.open == nil {
		return PipelineTabResult{}, fmt.Errorf("the pipeline setup's tab is not available")
	}
	ctx, cancel := context.WithTimeout(context.Background(), pipelineTabTimeout)
	defer cancel()
	return pipelineTabs.open(ctx, req)
}
