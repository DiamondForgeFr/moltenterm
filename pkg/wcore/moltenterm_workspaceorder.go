// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"fmt"
	"log"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/molten/railorder"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// The rail order (FR-MC-031, DS-MC-024) sorts Wave's workspace list, so the rail, the app menu and the command palette
// show one order. Its rules are pkg/molten/railorder's; this file reads and writes it.

// One writer at a time: two windows moving at once would each write an order read before the other's move.
var workspaceOrderLock sync.Mutex

func withWorkspaceOrderLock(fn func() error) error {
	workspaceOrderLock.Lock()
	defer workspaceOrderLock.Unlock()
	return fn()
}

// moltenOrderWorkspaceList sorts Wave's list by the stored order; without one, or when the client cannot be read, it
// is Wave's list unchanged.
func moltenOrderWorkspaceList(ctx context.Context, wl waveobj.WorkspaceList) waveobj.WorkspaceList {
	client, err := wstore.DBGetSingleton[*waveobj.Client](ctx)
	if err != nil || client == nil {
		return wl
	}
	stored := railorder.ReadOrder(client.Meta)
	if len(stored) == 0 {
		return wl
	}
	byId := make(map[string]*waveobj.WorkspaceListEntry, len(wl))
	listed := make([]string, 0, len(wl))
	for _, entry := range wl {
		byId[entry.WorkspaceId] = entry
		listed = append(listed, entry.WorkspaceId)
	}
	rtn := make(waveobj.WorkspaceList, 0, len(wl))
	for _, id := range railorder.ApplyOrder(listed, stored) {
		rtn = append(rtn, byId[id])
	}
	return rtn
}

// MoveWorkspaceInRail applies a window's move and returns the new order. The whole order is written, so ids of deleted
// workspaces leave it and workspaces never moved take their current place in it.
func MoveWorkspaceInRail(ctx context.Context, req railorder.MoveRequest) ([]string, error) {
	// Resolving the products reads each linked project's file: done before the lock and the transaction, so a slow disk
	// never holds the database. A link changed meanwhile is caught by the next move. When the groups cannot be read, the
	// move is checked as one of an ungrouped rail rather than refused.
	products, err := railorder.ProductsOf(ctx)
	if err != nil {
		log.Printf("molten: rail order: resolving the product groups: %v\n", err)
		products = nil
	}
	var order []string
	var changed bool
	var clientId string
	err = withWorkspaceOrderLock(func() error {
		return wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
			tctx := tx.Context()
			wl, err := ListWorkspaces(tctx)
			if err != nil {
				return fmt.Errorf("listing the workspaces: %w", err)
			}
			current := make([]string, 0, len(wl))
			for _, entry := range wl {
				current = append(current, entry.WorkspaceId)
			}
			order, changed, err = railorder.MoveGrouped(current, products, req)
			if err != nil {
				return err
			}
			if !changed {
				return nil
			}
			client, err := wstore.DBGetSingleton[*waveobj.Client](tctx)
			if err != nil {
				return fmt.Errorf("reading the client: %w", err)
			}
			if client.Meta == nil {
				client.Meta = make(waveobj.MetaMapType)
			}
			client.Meta[railorder.MetaKey] = railorder.MetaValue(order)
			clientId = client.OID
			return wstore.DBUpdate(tctx, client)
		})
	})
	if err != nil {
		return nil, err
	}
	if changed {
		// The windows keep a copy of the client: it must not hold the old order.
		SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Client, clientId))
		wps.Broker.Publish(wps.WaveEvent{Event: wps.Event_WorkspaceUpdate})
		railorder.Moved()
	}
	return order, nil
}

// StartWorkspaceOrderRoute lets the windows move workspaces; wavesrv calls it once.
func StartWorkspaceOrderRoute() {
	railorder.StartRoute(MoveWorkspaceInRail)
}
