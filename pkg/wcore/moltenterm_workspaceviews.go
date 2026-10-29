// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"log"

	"github.com/wavetermdev/waveterm/pkg/molten/viewpin"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

// A workspace the developer creates starts with the views of the app:newworkspaceviews template (FR-SHELL-092,
// #1305): pinned in that workspace, made without panels so creating a workspace stays as fast, and opened from their
// configuration the first time a window shows them (frontend/moltenterm-shell/sidebar/pinned-empty-view.tsx). Their
// names are dictionary keys the windows show in the interface language, so wavesrv writes them with the workspace;
// a fresh install's default top row (#1296) needed the language at write time and went through the window instead.

const (
	// must match the panel kinds of frontend/moltenterm-shell/workspace-views/workspace-views-model.ts
	ViewPanelAgent       = "agent"
	ViewPanelTerminal    = "terminal"
	ViewPanelBrowser     = "browser"
	ViewPanelFiles       = "files"
	ViewPanelProject     = "project"
	ViewPanelIntegration = "integration"
	ViewPanelCicd        = "cicd"
	ViewPanelLineMap     = "linemap"

	// must match frontend/moltenterm-shell/workspace-views/workspace-views-model.ts
	ViewPendingMetaKey = "molten:viewpending"
	ViewNameKeyMetaKey = "molten:viewnamekey"
	// A template view with neither a name nor a key.
	DefaultViewNameKey = "workspaceViews.names.view"
)

// What each panel kind opens, on the workspace's project when the view is first shown (viewpin.ResolvePane).
func viewPanelMeta(kind string) waveobj.MetaMapType {
	switch kind {
	case ViewPanelAgent:
		return waveobj.MetaMapType{waveobj.MetaKey_View: "term", waveobj.MetaKey_Controller: "shell", viewpin.AgentSlotMetaKey: true}
	case ViewPanelTerminal:
		return waveobj.MetaMapType{waveobj.MetaKey_View: "term", waveobj.MetaKey_Controller: "shell"}
	case ViewPanelBrowser:
		return waveobj.MetaMapType{waveobj.MetaKey_View: "molten-browser", waveobj.MetaKey_Url: viewpin.RepoToken}
	case ViewPanelFiles:
		return waveobj.MetaMapType{waveobj.MetaKey_View: "preview", waveobj.MetaKey_File: viewpin.ProjectToken}
	case ViewPanelProject:
		return waveobj.MetaMapType{waveobj.MetaKey_View: "molten-project"}
	case ViewPanelIntegration:
		return waveobj.MetaMapType{waveobj.MetaKey_View: "molten-reviews"}
	case ViewPanelCicd:
		return waveobj.MetaMapType{waveobj.MetaKey_View: "molten-cicd"}
	case ViewPanelLineMap:
		return waveobj.MetaMapType{waveobj.MetaKey_View: "molten-linemap"}
	}
	return nil
}

func paneLeaf(idx int) viewpin.Node {
	return viewpin.Node{Pane: &idx}
}

// group puts panels in one node: one panel as itself, several side by side (row) or stacked (column).
func group(idxs []int, dir string) viewpin.Node {
	if len(idxs) == 1 {
		return paneLeaf(idxs[0])
	}
	rtn := viewpin.Node{Dir: dir}
	for _, i := range idxs {
		rtn.Children = append(rtn.Children, paneLeaf(i))
	}
	return rtn
}

// WorkspaceViewConfig is a template view's configuration: agent slots on the left, the other panels stacked on the
// right (DS-REV-012); without an agent, the panels side by side. ok is false when no panel kind is known.
func WorkspaceViewConfig(panels []string) (viewpin.Config, bool) {
	cfg := viewpin.Config{Panes: []waveobj.MetaMapType{}}
	var agents, others []int
	for _, kind := range panels {
		meta := viewPanelMeta(kind)
		if meta == nil {
			continue
		}
		idx := len(cfg.Panes)
		cfg.Panes = append(cfg.Panes, meta)
		if kind == ViewPanelAgent {
			agents = append(agents, idx)
		} else {
			others = append(others, idx)
		}
	}
	switch {
	case len(cfg.Panes) == 0:
		return cfg, false
	case len(agents) == 0:
		cfg.Tree = group(others, "row")
	case len(others) == 0:
		cfg.Tree = group(agents, "row")
	default:
		cfg.Tree = viewpin.Node{Dir: "row", Children: []viewpin.Node{group(agents, "column"), group(others, "column")}}
	}
	return cfg, true
}

type workspaceViewTab struct {
	Name string
	Meta waveobj.MetaMapType
}

// workspaceViewTabs gives the tabs of the template's views: a name the developer typed is kept as typed, otherwise
// the name is the dictionary key, marked as such so the windows translate it until the view is renamed.
func workspaceViewTabs(views []wconfig.NewWorkspaceViewType) []workspaceViewTab {
	var rtn []workspaceViewTab
	for _, v := range views {
		cfg, ok := WorkspaceViewConfig(v.Panels)
		if !ok {
			continue
		}
		var cfgMeta map[string]any
		if err := utilfn.ReUnmarshal(&cfgMeta, cfg); err != nil {
			continue
		}
		meta := waveobj.MetaMapType{
			viewpin.PinMetaKey:       viewpin.PinWorkspace,
			viewpin.PinConfigMetaKey: cfgMeta,
			ViewPendingMetaKey:       true,
		}
		name := v.Name
		if name == "" {
			name = v.NameKey
			if name == "" {
				name = DefaultViewNameKey
			}
			meta[ViewNameKeyMetaKey] = name
		}
		rtn = append(rtn, workspaceViewTab{Name: name, Meta: meta})
	}
	return rtn
}

// addWorkspaceViews appends the template's views to a new workspace, after its first view, without making them
// active.
func addWorkspaceViews(ctx context.Context, workspaceId string, views []wconfig.NewWorkspaceViewType) {
	for _, tab := range workspaceViewTabs(views) {
		if _, err := createTabObj(ctx, workspaceId, tab.Name, tab.Meta); err != nil {
			log.Printf("molten: adding a new workspace's view: %v\n", err)
		}
	}
}

func newWorkspaceViews() []wconfig.NewWorkspaceViewType {
	return wconfig.GetWatcher().GetFullConfig().Settings.AppNewWorkspaceViews
}
