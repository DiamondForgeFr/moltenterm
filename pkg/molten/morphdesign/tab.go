// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package morphdesign

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// The design's tab (FR-MORPH-019), on the Review tab's and the pipeline setup's pattern (DS-REV-012): one tab per mod,
// the agent's terminal on the left and the design panel on the right. A mod whose tab exists has it focused, so the
// design is never open twice.

const (
	// View is the panel's block view; must match frontend/moltenterm-shell/morph-design/morph-design-model.ts.
	View = "molten-morphdesign"
	// TabMetaKey: the tab's mod id, to find it again. PanelMetaKey: the panel's target. TermMetaKey: the terminal the
	// tab opened, so the panel can tell it from one the developer added.
	TabMetaKey   = "molten:morphdesigntab"
	PanelMetaKey = "molten:morphdesign"
	TermMetaKey  = "molten:morphdesignterm"

	// The terminal's and the panel's shares of the tab's width (layout sizes are relative).
	terminalNodeSize = uint(6)
	panelNodeSize    = uint(10)

	maxTabName = 120
	tabTimeout = 10 * time.Second
)

// PanelTarget is what the design panel shows, in its block's meta.
type PanelTarget struct {
	Mod  string `json:"mod"`
	Name string `json:"name,omitempty"`
	Dir  string `json:"dir"`
}

func tabName(req molten.MorphDesignTabRequest) string {
	name := strings.TrimSpace(req.TabName)
	if name != "" && len(name) <= maxTabName {
		return name
	}
	shown := strings.TrimSpace(req.Name)
	if shown == "" {
		shown = req.Mod
	}
	return "Design · " + shown
}

// tabLayout puts the terminal on the left and the panel on the right; the panel has the focus, as the developer's
// first gesture is a click there.
func tabLayout(req molten.MorphDesignTabRequest) wcore.PortableLayout {
	termSize, panelSize := terminalNodeSize, panelNodeSize
	return wcore.PortableLayout{
		{IndexArr: []int{0}, Size: &termSize, BlockDef: &waveobj.BlockDef{Meta: waveobj.MetaMapType{
			waveobj.MetaKey_View:       "term",
			waveobj.MetaKey_Controller: "shell",
			waveobj.MetaKey_CmdCwd:     filepath.Clean(req.Dir),
			TermMetaKey:                req.Mod,
		}}},
		{IndexArr: []int{1}, Size: &panelSize, Focused: true, BlockDef: &waveobj.BlockDef{Meta: waveobj.MetaMapType{
			waveobj.MetaKey_View: View,
			PanelMetaKey:         PanelTarget{Mod: req.Mod, Name: strings.TrimSpace(req.Name), Dir: filepath.Clean(req.Dir)},
		}}},
	}
}

func findTab(ctx context.Context, ws *waveobj.Workspace, mod string) string {
	for _, tabId := range ws.TabIds {
		tab, err := wstore.DBGet[*waveobj.Tab](ctx, tabId)
		if err != nil || tab == nil {
			continue
		}
		if tab.Meta.GetString(TabMetaKey, "") == mod {
			return tabId
		}
	}
	return ""
}

var tabs struct {
	lock sync.Mutex
}

// openTab runs under one lock: two hand-offs at once never make two tabs for a mod.
func openTab(req molten.MorphDesignTabRequest) (molten.MorphDesignTabResult, error) {
	tabs.lock.Lock()
	defer tabs.lock.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), tabTimeout)
	defer cancel()
	return makeTab(ctx, req)
}

func makeTab(ctx context.Context, req molten.MorphDesignTabRequest) (molten.MorphDesignTabResult, error) {
	if req.WorkspaceId == "" {
		return molten.MorphDesignTabResult{}, fmt.Errorf("no workspace given")
	}
	ws, err := wcore.GetWorkspace(ctx, req.WorkspaceId)
	if err != nil {
		return molten.MorphDesignTabResult{}, err
	}
	if tabId := findTab(ctx, ws, req.Mod); tabId != "" {
		return molten.MorphDesignTabResult{TabId: tabId}, nil
	}
	ctx = waveobj.ContextWithUpdates(ctx)
	tabId, err := wcore.CreateTab(ctx, req.WorkspaceId, tabName(req), false, true)
	if err != nil {
		return molten.MorphDesignTabResult{}, err
	}
	tabORef := waveobj.MakeORef(waveobj.OType_Tab, tabId)
	if err := wstore.UpdateObjectMeta(ctx, tabORef, waveobj.MetaMapType{TabMetaKey: req.Mod}, false); err != nil {
		return molten.MorphDesignTabResult{}, err
	}
	if err := wcore.ApplyPortableLayout(ctx, tabId, tabLayout(req), true); err != nil {
		if _, delErr := wcore.DeleteTab(ctx, req.WorkspaceId, tabId, false); delErr != nil {
			return molten.MorphDesignTabResult{}, fmt.Errorf("placing the design panel: %w (and the tab stays: %v)", err, delErr)
		}
		return molten.MorphDesignTabResult{}, fmt.Errorf("placing the design panel: %w", err)
	}
	wps.Broker.SendUpdateEvents(waveobj.ContextGetUpdatesRtn(ctx))
	wcore.SendWaveObjUpdate(tabORef)
	return molten.MorphDesignTabResult{TabId: tabId, Created: true}, nil
}
