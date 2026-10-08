// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"fmt"
	"log"
	"slices"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/railorder"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// The rail order (FR-MC-031, DS-MC-024) sorts Wave's workspace list, so the rail, the app menu and the command palette
// show one order. The local rail groups (FR-MC-032, DS-MC-028) are written with it. Their rules are
// pkg/molten/railorder's; this file reads and writes them.

const railReconcileTimeout = 5 * time.Second

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

// readRail reads the rail as a write sees it: the saved workspaces in rail order, their names and the stored local
// groups. Products are the caller's.
func readRail(ctx context.Context, products railorder.ProductMap) (railorder.Rail, *waveobj.Client, error) {
	wl, err := ListWorkspaces(ctx)
	if err != nil {
		return railorder.Rail{}, nil, fmt.Errorf("listing the workspaces: %w", err)
	}
	order := make([]string, 0, len(wl))
	for _, entry := range wl {
		order = append(order, entry.WorkspaceId)
	}
	names := make(map[string]string, len(order))
	workspaces, err := wstore.DBGetAllObjsByType[*waveobj.Workspace](ctx, waveobj.OType_Workspace)
	if err != nil {
		return railorder.Rail{}, nil, fmt.Errorf("reading the workspaces: %w", err)
	}
	for _, ws := range workspaces {
		names[ws.OID] = ws.Name
	}
	client, err := wstore.DBGetSingleton[*waveobj.Client](ctx)
	if err != nil {
		return railorder.Rail{}, nil, fmt.Errorf("reading the client: %w", err)
	}
	rail := railorder.Rail{Order: order, Groups: railorder.ReadGroups(client.Meta), Products: products, Names: names}
	return rail, client, nil
}

// resolveProducts resolves the project products before the lock and the transaction: it reads each linked project's
// file, and a slow disk must never hold the database. A link changed meanwhile is caught by the next write. When the
// products cannot be read, the rail is checked as one without products rather than refused.
func resolveProducts(ctx context.Context) railorder.ProductMap {
	products, err := railorder.ProductsOf(ctx)
	if err != nil {
		log.Printf("molten: rail order: resolving the product groups: %v\n", err)
		return railorder.ProductMap{}
	}
	return products
}

// ReadRail is the rail normalized, as the next write would see it.
func ReadRail(ctx context.Context) (railorder.Rail, error) {
	rail, _, err := readRail(ctx, resolveProducts(ctx))
	if err != nil {
		return railorder.Rail{}, err
	}
	normal, _ := rail.Normalize()
	return normal, nil
}

// ApplyRail runs a change on the normalized rail and writes the order and the local groups in one transaction. The
// whole order is written, so ids of deleted workspaces leave it and workspaces never moved take their current place.
func ApplyRail(ctx context.Context, change func(railorder.Rail) (railorder.Rail, error)) (railorder.Rail, error) {
	return applyRail(ctx, resolveProducts(ctx), change)
}

func applyRail(ctx context.Context, products railorder.ProductMap, change func(railorder.Rail) (railorder.Rail, error)) (railorder.Rail, error) {
	var written railorder.Rail
	var orderChanged, changed bool
	var clientId string
	var displaced []railorder.Displaced
	err := withWorkspaceOrderLock(func() error {
		return wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
			tctx := tx.Context()
			rail, client, err := readRail(tctx, products)
			if err != nil {
				return err
			}
			normal, before := rail.Normalize()
			next, err := change(normal)
			if err != nil {
				return err
			}
			final, after := next.Normalize()
			written = final
			displaced = append(before, after...)
			orderChanged = !slices.Equal(final.Order, rail.Order)
			changed = orderChanged || !railorder.SameGroups(final.Groups, rail.Groups)
			if !changed {
				return nil
			}
			if client.Meta == nil {
				client.Meta = make(waveobj.MetaMapType)
			}
			client.Meta[railorder.MetaKey] = railorder.MetaValue(final.Order)
			if len(final.Groups) == 0 {
				delete(client.Meta, railorder.GroupsMetaKey)
			} else {
				client.Meta[railorder.GroupsMetaKey] = railorder.GroupsMetaValue(final.Groups)
			}
			clientId = client.OID
			return wstore.DBUpdate(tctx, client)
		})
	})
	if err != nil {
		return railorder.Rail{}, err
	}
	if changed {
		// The windows keep a copy of the client: it must not hold the old order or groups.
		SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Client, clientId))
		wps.Broker.Publish(wps.WaveEvent{Event: wps.Event_WorkspaceUpdate})
		railorder.TellDisplaced(displaced)
	}
	if orderChanged {
		railorder.Moved()
	}
	return written, nil
}

// MoveWorkspaceInRail applies a window's move (railordermove) and returns the new order.
func MoveWorkspaceInRail(ctx context.Context, req railorder.MoveRequest) ([]string, error) {
	rail, err := ApplyRail(ctx, func(r railorder.Rail) (railorder.Rail, error) { return r.Move(req) })
	if err != nil {
		return nil, err
	}
	return rail.Order, nil
}

// reconcileRailGroups takes out of the local groups the members a project product now shows (FR-MC-032-AC8). Most
// resolutions change nothing: the stored groups are read first, and only a member found in a product makes a write.
func reconcileRailGroups(products railorder.ProductMap) {
	if len(products.Of) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), railReconcileTimeout)
	defer cancel()
	client, err := wstore.DBGetSingleton[*waveobj.Client](ctx)
	if err != nil || client == nil {
		return
	}
	taken := false
	for _, group := range railorder.ReadGroups(client.Meta) {
		for _, id := range group.Members {
			if products.Of[id] != "" {
				taken = true
			}
		}
	}
	if !taken {
		return
	}
	if _, err := applyRail(ctx, products, func(r railorder.Rail) (railorder.Rail, error) { return r, nil }); err != nil {
		log.Printf("molten: rail groups: giving members to their project product: %v\n", err)
	}
}

// StartWorkspaceOrderRoute lets the windows and MoltenTerm's terminals order and group the rail; wavesrv calls it once.
func StartWorkspaceOrderRoute() {
	railorder.SetReconcile(reconcileRailGroups)
	railorder.StartRoute(railorder.Store{Read: ReadRail, Apply: ApplyRail})
}
