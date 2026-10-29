// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/railorder"
	"github.com/wavetermdev/waveterm/pkg/molten/reopen"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// Undoing a workspace reset or delete (FR-SHELL-095): Electron keeps a snapshot here just before either runs, and the
// window offers Undo for WorkspaceUndoWindow. The snapshot is the workspace's identity, its meta (the project links),
// its imported icon and its views with their panes and layout; undo puts them back under the same workspace id, so the
// sidebar order and everything keyed by the id follow. What ran does not: a terminal comes back with a new shell, and
// an agent or a command is not started again.

const (
	WorkspaceUndoKindReset  = "reset"
	WorkspaceUndoKindDelete = "delete"

	WorkspaceUndoWindow = 10 * time.Second
	// A click on Undo in the last instant still counts: the toast and wavesrv do not share a clock.
	workspaceUndoGrace = 2 * time.Second
)

type WorkspaceUndoOffer struct {
	UndoId      string `json:"undoid"`
	Kind        string `json:"kind"`
	WorkspaceId string `json:"workspaceid"`
	Name        string `json:"name"`
	RemainingMs int64  `json:"remainingms"`
}

type WorkspaceUndoResult struct {
	Kind         string   `json:"kind"`
	WorkspaceId  string   `json:"workspaceid"`
	ActiveTabId  string   `json:"activetabid,omitempty"`
	ClosedTabIds []string `json:"closedtabids,omitempty"`
}

type workspaceUndoIcon struct {
	name string
	data []byte
}

type workspaceUndoEntry struct {
	id          string
	kind        string
	windowId    string
	at          time.Time
	workspaceId string
	name        string
	icon        string
	color       string
	meta        waveobj.MetaMapType
	tabs        []reopen.Tab
	activeIndex int
	iconFiles   []workspaceUndoIcon
	railIndex   int
	railNext    string
}

type workspaceUndoStore struct {
	lock    sync.Mutex
	entries map[string]*workspaceUndoEntry
}

var workspaceUndos = &workspaceUndoStore{entries: map[string]*workspaceUndoEntry{}}

// The tests set the clock: an undo window must not depend on how fast a loaded machine runs them.
var workspaceUndoNow = time.Now

func (s *workspaceUndoStore) prune(now time.Time) {
	for id, e := range s.entries {
		if now.Sub(e.at) > WorkspaceUndoWindow+workspaceUndoGrace {
			delete(s.entries, id)
		}
	}
}

// put keeps one offer per window: a new reset or delete replaces the one before.
func (s *workspaceUndoStore) put(e *workspaceUndoEntry) {
	s.lock.Lock()
	defer s.lock.Unlock()
	s.prune(e.at)
	for id, old := range s.entries {
		if old.windowId == e.windowId || old.workspaceId == e.workspaceId {
			delete(s.entries, id)
		}
	}
	s.entries[e.id] = e
}

func (s *workspaceUndoStore) pending(windowId string, now time.Time) *workspaceUndoEntry {
	s.lock.Lock()
	defer s.lock.Unlock()
	s.prune(now)
	for _, e := range s.entries {
		if e.windowId == windowId && now.Sub(e.at) < WorkspaceUndoWindow {
			return e
		}
	}
	return nil
}

func (s *workspaceUndoStore) take(id string, now time.Time) *workspaceUndoEntry {
	s.lock.Lock()
	defer s.lock.Unlock()
	s.prune(now)
	e := s.entries[id]
	delete(s.entries, id)
	return e
}

// undoPaneMeta is a pane's meta as undo makes it again: nothing that would start what the reset or delete stopped.
func undoPaneMeta(meta map[string]any) waveobj.MetaMapType {
	rtn := reopen.CleanMeta(meta)
	delete(rtn, reopen.ResumeAgentMetaKey)
	if rtn.GetString(waveobj.MetaKey_Controller, "") == "cmd" {
		rtn[waveobj.MetaKey_CmdRunOnStart] = false
	}
	return rtn
}

func captureUndoTab(ctx context.Context, tabId string) (reopen.Tab, bool) {
	tab, _ := wstore.DBGet[*waveobj.Tab](ctx, tabId)
	if tab == nil {
		return reopen.Tab{}, false
	}
	var root any
	focused := ""
	if layout, _ := wstore.DBGet[*waveobj.LayoutState](ctx, tab.LayoutState); layout != nil {
		root, focused = layout.RootNode, layout.FocusedNodeId
	}
	metaOf := func(blockId string) (map[string]any, bool) {
		if !slices.Contains(tab.BlockIds, blockId) {
			return nil, false
		}
		block, _ := wstore.DBGet[*waveobj.Block](ctx, blockId)
		if block == nil {
			return nil, false
		}
		return undoPaneMeta(block.Meta), true
	}
	return reopen.Tab{Name: tab.Name, Meta: reopen.CleanMeta(tab.Meta), Leaves: reopen.LayoutLeaves(root, focused, metaOf)}, true
}

func captureUndoIconFiles(workspaceId string) []workspaceUndoIcon {
	dir := molten.WorkspaceIconsDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var rtn []workspaceUndoIcon
	for _, entry := range entries {
		if !entry.Type().IsRegular() || !molten.CheckWorkspaceIconOwner(entry.Name(), workspaceId) {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			continue
		}
		rtn = append(rtn, workspaceUndoIcon{name: entry.Name(), data: data})
	}
	return rtn
}

// CaptureWorkspaceUndo keeps what undo needs, for the window that asked; Electron calls it right before the reset or
// the delete runs.
func CaptureWorkspaceUndo(ctx context.Context, workspaceId string, kind string, windowId string) (string, error) {
	if kind != WorkspaceUndoKindReset && kind != WorkspaceUndoKindDelete {
		return "", fmt.Errorf("unknown undo kind %q", kind)
	}
	ws, err := GetWorkspace(ctx, workspaceId)
	if err != nil {
		return "", err
	}
	e := &workspaceUndoEntry{
		id:          uuid.NewString(),
		kind:        kind,
		windowId:    windowId,
		at:          workspaceUndoNow(),
		workspaceId: ws.OID,
		name:        ws.Name,
		icon:        ws.Icon,
		color:       ws.Color,
		meta:        reopen.CleanMeta(ws.Meta),
		railIndex:   -1,
	}
	for _, tabId := range ws.TabIds {
		tab, ok := captureUndoTab(ctx, tabId)
		if !ok {
			continue
		}
		if tabId == ws.ActiveTabId {
			e.activeIndex = len(e.tabs)
		}
		e.tabs = append(e.tabs, tab)
	}
	if workspaceIconName(ws) != "" {
		e.iconFiles, _ = withWorkspaceIconLock(func() ([]workspaceUndoIcon, error) {
			return captureUndoIconFiles(ws.OID), nil
		})
	}
	if rail, err := ReadRail(ctx); err == nil {
		e.railIndex = slices.Index(rail.Order, ws.OID)
		if e.railIndex >= 0 && e.railIndex+1 < len(rail.Order) {
			e.railNext = rail.Order[e.railIndex+1]
		}
	}
	workspaceUndos.put(e)
	return e.id, nil
}

// restoreUndoRailPlace puts a workspace made again back at its place in the sidebar: before the workspace that
// followed it, else at its old index. Its local group, if it had one, is not restored.
func restoreUndoRailPlace(ctx context.Context, e *workspaceUndoEntry) {
	if e.railIndex < 0 {
		return
	}
	_, err := ApplyRail(ctx, func(r railorder.Rail) (railorder.Rail, error) {
		ids := slices.DeleteFunc(slices.Clone(r.Order), func(id string) bool { return id == e.workspaceId })
		pos := slices.Index(ids, e.railNext)
		if pos < 0 {
			pos = min(e.railIndex, len(ids))
		}
		r.Order = slices.Insert(ids, pos, e.workspaceId)
		return r, nil
	})
	if err != nil {
		log.Printf("molten: undo, putting workspace %q back at its place: %v\n", e.workspaceId, err)
	}
}

func PendingWorkspaceUndo(windowId string) *WorkspaceUndoOffer {
	now := workspaceUndoNow()
	e := workspaceUndos.pending(windowId, now)
	if e == nil {
		return nil
	}
	return &WorkspaceUndoOffer{
		UndoId:      e.id,
		Kind:        e.kind,
		WorkspaceId: e.workspaceId,
		Name:        e.name,
		RemainingMs: (WorkspaceUndoWindow - now.Sub(e.at)).Milliseconds(),
	}
}

func restoreUndoIconFiles(files []workspaceUndoIcon) {
	if len(files) == 0 {
		return
	}
	withWorkspaceIconLock(func() (bool, error) {
		dir := molten.WorkspaceIconsDir()
		if err := os.MkdirAll(dir, 0700); err != nil {
			return false, err
		}
		for _, f := range files {
			path := filepath.Join(dir, f.name)
			if _, err := os.Stat(path); err == nil {
				continue
			}
			if err := os.WriteFile(path, f.data, 0600); err != nil {
				log.Printf("molten: restoring the icon %q: %v\n", f.name, err)
			}
		}
		return true, nil
	})
}

// restoreUndoTab makes a view again at the end of the workspace, its panes by splits (as restoreTab does for #512). A
// view that had no panes (one not built yet) comes back empty with its meta.
func restoreUndoTab(ctx context.Context, workspaceId string, t reopen.Tab) (string, error) {
	tab, err := createTabObj(ctx, workspaceId, t.Name, t.Meta)
	if err != nil {
		return "", err
	}
	if len(t.Leaves) == 0 {
		return tab.OID, nil
	}
	actions := []waveobj.LayoutActionData{{ActionType: LayoutActionDataType_ClearTree}}
	blockIds := make([]string, len(t.Leaves))
	for i, leaf := range t.Leaves {
		block, err := CreateBlockWithTelemetry(ctx, tab.OID, &waveobj.BlockDef{Meta: leaf.Meta}, &waveobj.RuntimeOpts{}, false)
		if err != nil {
			log.Printf("molten: undo, making a pane of view %q again: %v\n", t.Name, err)
			continue
		}
		blockIds[i] = block.OID
		actions = append(actions, tabLeafAction(leaf, block.OID, blockIds))
	}
	return tab.OID, QueueLayoutActionForTab(ctx, tab.OID, actions...)
}

// RestoreWorkspaceUndo puts the workspace back. A deleted one is made again under its id, without a window: the
// caller switches a window to it. A reset one gets its views back and loses the fresh view the reset gave it, whose
// ids are returned for the window to drop their views.
func RestoreWorkspaceUndo(ctx context.Context, undoId string) (*WorkspaceUndoResult, error) {
	e := workspaceUndos.take(undoId, workspaceUndoNow())
	if e == nil {
		return nil, fmt.Errorf("nothing to undo: the offer is over")
	}
	rtn := &WorkspaceUndoResult{Kind: e.kind, WorkspaceId: e.workspaceId}
	existing, _ := wstore.DBGet[*waveobj.Workspace](ctx, e.workspaceId)
	if existing == nil {
		ws := &waveobj.Workspace{OID: e.workspaceId, TabIds: []string{}, Name: e.name, Icon: e.icon, Color: e.color, Meta: e.meta}
		if err := wstore.DBInsert(ctx, ws); err != nil {
			return nil, fmt.Errorf("making the workspace again: %w", err)
		}
		restoreUndoIconFiles(e.iconFiles)
		restoreUndoRailPlace(ctx, e)
	} else {
		rtn.ClosedTabIds = slices.Clone(existing.TabIds)
	}
	var tabIds []string
	for _, t := range e.tabs {
		tabId, err := restoreUndoTab(ctx, e.workspaceId, t)
		if err != nil {
			log.Printf("molten: undo, making view %q again: %v\n", t.Name, err)
		}
		if tabId != "" {
			tabIds = append(tabIds, tabId)
		}
	}
	if len(tabIds) == 0 {
		tabId, err := CreateTab(ctx, e.workspaceId, "", false, false)
		if err != nil {
			return nil, fmt.Errorf("making a view: %w", err)
		}
		tabIds = append(tabIds, tabId)
	}
	rtn.ActiveTabId = tabIds[min(e.activeIndex, len(tabIds)-1)]
	if err := SetActiveTab(ctx, e.workspaceId, rtn.ActiveTabId); err != nil {
		return nil, err
	}
	for _, tabId := range rtn.ClosedTabIds {
		if _, err := DeleteTab(ctx, e.workspaceId, tabId, false); err != nil {
			log.Printf("molten: undo, closing the view %q the reset made: %v\n", tabId, err)
		}
	}
	wps.Broker.Publish(wps.WaveEvent{Event: wps.Event_WorkspaceUpdate})
	return rtn, nil
}
