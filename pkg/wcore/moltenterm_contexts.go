// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wcore

import (
	"context"
	"fmt"
	"slices"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/molten/contexts"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// The contexts (FR-SHELL-158, DS-SHELL-157, #2476) are the client meta "molten:contexts" and each workspace's meta
// "molten:context". Their rules are pkg/molten/contexts'; this file reads them and writes a change with the metas of
// the workspaces it moved, in one transaction, so a list and its membership never diverge.

// One writer at a time: two windows changing contexts at once would each write a list read before the other's change.
var contextsLock sync.Mutex

func withContextsLock(fn func() error) error {
	contextsLock.Lock()
	defer contextsLock.Unlock()
	return fn()
}

func readContextsState(ctx context.Context) (*waveobj.Client, map[string]*waveobj.Workspace, contexts.State, error) {
	client, err := wstore.DBGetSingleton[*waveobj.Client](ctx)
	if err != nil {
		return nil, nil, contexts.State{}, fmt.Errorf("reading the client: %w", err)
	}
	if client == nil {
		return nil, nil, contexts.State{}, fmt.Errorf("reading the client: none")
	}
	all, err := wstore.DBGetAllObjsByType[*waveobj.Workspace](ctx, waveobj.OType_Workspace)
	if err != nil {
		return nil, nil, contexts.State{}, fmt.Errorf("reading the workspaces: %w", err)
	}
	byId := make(map[string]*waveobj.Workspace, len(all))
	metas := make(map[string]waveobj.MetaMapType, len(all))
	for _, ws := range all {
		byId[ws.OID] = ws
		metas[ws.OID] = ws.Meta
	}
	return client, byId, contexts.MakeState(client.Meta, metas), nil
}

// ReadContexts is the contexts and the context of every workspace, as the next write would see them.
func ReadContexts(ctx context.Context) (contexts.State, error) {
	_, _, state, err := readContextsState(ctx)
	return state, err
}

// ApplyContexts runs a change on the contexts and writes the list, when it changed, and the metas of the workspaces the
// change moved. The windows are told, so none keeps the old list or the old membership.
func ApplyContexts(ctx context.Context, change contexts.Change) (contexts.State, error) {
	var written contexts.State
	var clientId string
	var listChanged bool
	var movedIds []string
	err := withContextsLock(func() error {
		return wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
			tctx := tx.Context()
			client, byId, state, err := readContextsState(tctx)
			if err != nil {
				return err
			}
			next, moved, err := change(state)
			if err != nil {
				return err
			}
			written = next
			listChanged = !contexts.SameContexts(next.Contexts, state.Contexts)
			movedIds = slices.Clone(moved)
			if !listChanged && len(moved) == 0 {
				return nil
			}
			for _, id := range moved {
				ws := byId[id]
				if ws == nil {
					return fmt.Errorf("workspace %q does not exist", id)
				}
				if ws.Meta == nil {
					ws.Meta = make(waveobj.MetaMapType)
				}
				ws.Meta[contexts.WorkspaceMetaKey] = next.Of[id]
				if err := wstore.DBUpdate(tctx, ws); err != nil {
					return fmt.Errorf("writing the context of workspace %q: %w", id, err)
				}
			}
			if !listChanged {
				return nil
			}
			if client.Meta == nil {
				client.Meta = make(waveobj.MetaMapType)
			}
			client.Meta[contexts.ClientMetaKey] = contexts.MetaValue(next.Contexts)
			clientId = client.OID
			return wstore.DBUpdate(tctx, client)
		})
	})
	if err != nil {
		return contexts.State{}, err
	}
	if listChanged {
		SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Client, clientId))
	}
	for _, id := range movedIds {
		SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Workspace, id))
	}
	if listChanged || len(movedIds) > 0 {
		wps.Broker.Publish(wps.WaveEvent{Event: wps.Event_WorkspaceUpdate})
	}
	return written, nil
}

// ContextOfWorkspace is the id of the context a workspace is in; "" when it cannot be read.
func ContextOfWorkspace(ctx context.Context, workspaceId string) string {
	_, _, state, err := readContextsState(ctx)
	if err != nil {
		return ""
	}
	return state.Of[workspaceId]
}

// sameContextLanding is the workspace a window lands on when the one it shows is deleted, when another workspace of the
// same context is not shown by a window: the first one after the deleted workspace in the rail, else the first one
// before it. "" when there is none, and Wave's own choice stands.
func sameContextLanding(state contexts.State, deleted string, list waveobj.WorkspaceList) string {
	context := state.Of[deleted]
	at := slices.IndexFunc(list, func(entry *waveobj.WorkspaceListEntry) bool { return entry.WorkspaceId == deleted })
	if context == "" || at < 0 {
		return ""
	}
	ordered := append(slices.Clone(list[at+1:]), list[:at]...)
	for _, entry := range ordered {
		if entry.WindowId == "" && state.Of[entry.WorkspaceId] == context {
			return entry.WorkspaceId
		}
	}
	return ""
}

// moltenContextLanding reads the contexts for DeleteWorkspace; "" when they cannot be read.
func moltenContextLanding(ctx context.Context, deleted string, list waveobj.WorkspaceList) string {
	state, err := ReadContexts(ctx)
	if err != nil {
		return ""
	}
	return sameContextLanding(state, deleted, list)
}

// StartContextsRoute lets the windows and Electron main change the contexts; wavesrv calls it once.
func StartContextsRoute() {
	contexts.StartRoute(contexts.Store{Read: ReadContexts, Apply: ApplyContexts})
}
