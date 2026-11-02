// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/molten/viewpin"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// The template's views in a workspace that already exists (FR-SHELL-110, #1347): any workspace whose empty state the
// developer answers with "Add my template views", when they saved one in Preferences. They are made as a new
// workspace's are (moltenterm_workspaceviews.go): pinned there, pending, opened on the workspace's project the first
// time a window shows them. Since #1709 the starter workspace no longer gets them when its first run ends: it holds
// the view the user built in the first launch, or nothing.

func currentTemplate() []wconfig.NewWorkspaceViewType {
	return wconfig.GetWatcher().GetFullConfig().Settings.AppNewWorkspaceViews
}

func setTemplateMark(ctx context.Context, wsId string) error {
	oref := waveobj.MakeORef(waveobj.OType_Workspace, wsId)
	return wstore.UpdateObjectMeta(ctx, oref, waveobj.MetaMapType{mission.TemplateViewsMetaKey: true}, false)
}

// markTemplateWorkspace marks the starter workspace when its first run starts, so linking a project during the first
// launch adds no Project tab (#1315, #1709): the user composes its views.
func markTemplateWorkspace(ctx context.Context, wsId string) error {
	return setTemplateMark(ctx, wsId)
}

// heldViewTab finds a view of the template the workspace already pins: the same name key, or the same typed name.
func heldViewTab(tabs []*waveobj.Tab, view workspaceViewTab) string {
	key := view.Meta.GetString(ViewNameKeyMetaKey, "")
	for _, tab := range tabs {
		if tab == nil || tab.Meta.GetString(viewpin.PinMetaKey, "") != viewpin.PinWorkspace {
			continue
		}
		if key != "" && tab.Meta.GetString(ViewNameKeyMetaKey, "") == key {
			return tab.OID
		}
		if key == "" && tab.Name == view.Name {
			return tab.OID
		}
	}
	return ""
}

// addWorkspaceViews adds the template's views the workspace does not pin yet, after its views, in one transaction,
// and marks the workspace as made from the template. The active view stays. It returns the tab of the template's first
// view (added now or already there); empty when the template has no valid view.
func addWorkspaceViews(ctx context.Context, wsId string, views []wconfig.NewWorkspaceViewType) (string, error) {
	viewTabs := workspaceViewTabs(views)
	if len(viewTabs) == 0 {
		return "", nil
	}
	return wstore.WithTxRtn(ctx, func(tx *wstore.TxWrap) (string, error) {
		tctx := tx.Context()
		ws, err := GetWorkspace(tctx, wsId)
		if err != nil {
			return "", err
		}
		tabs, err := wstore.DBSelectORefs(tctx, workspaceTabORefs(ws))
		if err != nil {
			return "", fmt.Errorf("reading the workspace's views: %w", err)
		}
		held := make([]*waveobj.Tab, 0, len(tabs))
		for _, obj := range tabs {
			if tab, ok := obj.(*waveobj.Tab); ok {
				held = append(held, tab)
			}
		}
		firstTabId := ""
		for _, view := range viewTabs {
			tabId := heldViewTab(held, view)
			if tabId == "" {
				tab, err := createTabObj(tctx, wsId, view.Name, view.Meta)
				if err != nil {
					return "", err
				}
				tabId = tab.OID
			}
			if firstTabId == "" {
				firstTabId = tabId
			}
		}
		if err := setTemplateMark(tctx, wsId); err != nil {
			return "", err
		}
		return firstTabId, nil
	})
}

func workspaceTabORefs(ws *waveobj.Workspace) []waveobj.ORef {
	orefs := make([]waveobj.ORef, 0, len(ws.TabIds))
	for _, tabId := range ws.TabIds {
		orefs = append(orefs, waveobj.MakeORef(waveobj.OType_Tab, tabId))
	}
	return orefs
}

// AddWorkspaceViews adds the current template's views to a workspace; the caller sends the updates its context
// gathered.
func AddWorkspaceViews(ctx context.Context, wsId string) (string, error) {
	tabId, err := addWorkspaceViews(ctx, wsId, currentTemplate())
	if err != nil {
		return "", fmt.Errorf("adding the default views: %w", err)
	}
	return tabId, nil
}
