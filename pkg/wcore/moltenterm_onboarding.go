// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/onboarding"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// MoltenTerm's first run (FR-ONB-001, DS-ONB-001) starts here, where the tabs and layouts live; the record and its
// rules are pkg/molten/onboarding's. Wave's onboarding dialogs are no longer mounted (frontend/app/modals/
// modalsrenderer.tsx), so Wave's starter layout, which they applied once the terms were accepted, is applied here when
// the first run is skipped.

const firstRunStartTimeout = 5 * time.Second

// FirstRunLayout is the first-run panel alone, filling the view (FR-SHELL-110): the welcome is full frame, and the
// panes its steps open land on its right.
func FirstRunLayout() PortableLayout {
	return PortableLayout{
		{IndexArr: []int{0}, BlockDef: &waveobj.BlockDef{
			Meta: waveobj.MetaMapType{waveobj.MetaKey_View: onboarding.ViewType},
		}, Focused: true},
	}
}

type firstTab struct {
	TabId       string
	WorkspaceId string
	Empty       bool
}

// firstWindowTab is the active tab of the first window, the one a first start shows, its workspace and whether the
// tab is still empty.
func firstWindowTab(ctx context.Context) (firstTab, error) {
	client, err := wstore.DBGetSingleton[*waveobj.Client](ctx)
	if err != nil {
		return firstTab{}, fmt.Errorf("reading the client: %w", err)
	}
	if len(client.WindowIds) == 0 {
		return firstTab{}, nil
	}
	window, err := wstore.DBMustGet[*waveobj.Window](ctx, client.WindowIds[0])
	if err != nil {
		return firstTab{}, fmt.Errorf("reading the window: %w", err)
	}
	ws, err := wstore.DBMustGet[*waveobj.Workspace](ctx, window.WorkspaceId)
	if err != nil {
		return firstTab{}, fmt.Errorf("reading the workspace: %w", err)
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, ws.ActiveTabId)
	if err != nil {
		return firstTab{}, fmt.Errorf("reading the tab: %w", err)
	}
	return firstTab{TabId: tab.OID, WorkspaceId: ws.OID, Empty: len(tab.BlockIds) == 0}, nil
}

func startLayout(kind string) PortableLayout {
	switch kind {
	case onboarding.LayoutFirstRun:
		return FirstRunLayout()
	case onboarding.LayoutStarter:
		return GetStarterLayout()
	}
	return nil
}

// StartMoltenFirstRun applies the first run's start rules before any window loads, lays out the first tab when they
// say so, and starts the first run's route.
func StartMoltenFirstRun() {
	defer onboarding.StartRoute()
	ctx, cancel := context.WithTimeout(context.Background(), firstRunStartTimeout)
	defer cancel()
	first, err := firstWindowTab(ctx)
	if err != nil {
		log.Printf("molten: first run: %v\n", err)
	}
	outcome, err := onboarding.StartFirstRun(ctx, first.TabId != "" && first.Empty, first.WorkspaceId)
	if err != nil {
		log.Printf("molten: first run not started: %v\n", err)
		return
	}
	if outcome.Write {
		log.Printf("molten: first run done=%v by=%q layout=%q\n", outcome.State.Done, outcome.State.By, outcome.Layout)
	}
	if outcome.State.StarterWs != "" {
		if err := markTemplateWorkspace(ctx, outcome.State.StarterWs); err != nil {
			log.Printf("molten: first run: marking the starter workspace: %v\n", err)
		}
	}
	layout := startLayout(outcome.Layout)
	if layout == nil {
		return
	}
	if err := ApplyPortableLayout(ctx, first.TabId, layout, false); err != nil {
		log.Printf("molten: first run layout: %v\n", err)
	}
}
