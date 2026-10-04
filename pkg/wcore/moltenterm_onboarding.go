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

// FirstRunLayout docks the first-run panel on the left of a shell terminal, about 40% of the width: the panes its steps
// open land on its right.
func FirstRunLayout() PortableLayout {
	panelSize := uint(7)
	termSize := uint(10)
	return PortableLayout{
		{IndexArr: []int{0}, Size: &panelSize, BlockDef: &waveobj.BlockDef{
			Meta: waveobj.MetaMapType{waveobj.MetaKey_View: onboarding.ViewType},
		}, Focused: true},
		{IndexArr: []int{1}, Size: &termSize, BlockDef: &waveobj.BlockDef{
			Meta: waveobj.MetaMapType{
				waveobj.MetaKey_View:       "term",
				waveobj.MetaKey_Controller: "shell",
			},
		}},
	}
}

// firstWindowTab is the active tab of the first window, the one a first start shows, and whether it is still empty.
func firstWindowTab(ctx context.Context) (string, bool, error) {
	client, err := wstore.DBGetSingleton[*waveobj.Client](ctx)
	if err != nil {
		return "", false, fmt.Errorf("reading the client: %w", err)
	}
	if len(client.WindowIds) == 0 {
		return "", false, nil
	}
	window, err := wstore.DBMustGet[*waveobj.Window](ctx, client.WindowIds[0])
	if err != nil {
		return "", false, fmt.Errorf("reading the window: %w", err)
	}
	ws, err := wstore.DBMustGet[*waveobj.Workspace](ctx, window.WorkspaceId)
	if err != nil {
		return "", false, fmt.Errorf("reading the workspace: %w", err)
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, ws.ActiveTabId)
	if err != nil {
		return "", false, fmt.Errorf("reading the tab: %w", err)
	}
	return tab.OID, len(tab.BlockIds) == 0, nil
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
	tabId, tabEmpty, err := firstWindowTab(ctx)
	if err != nil {
		log.Printf("molten: first run: %v\n", err)
	}
	outcome, err := onboarding.StartFirstRun(ctx, tabId != "" && tabEmpty)
	if err != nil {
		log.Printf("molten: first run not started: %v\n", err)
		return
	}
	if outcome.Write {
		log.Printf("molten: first run done=%v by=%q layout=%q\n", outcome.State.Done, outcome.State.By, outcome.Layout)
	}
	layout := startLayout(outcome.Layout)
	if layout == nil {
		return
	}
	if err := ApplyPortableLayout(ctx, tabId, layout, false); err != nil {
		log.Printf("molten: first run layout: %v\n", err)
	}
}
