// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package railorder

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// The windows reach the rail order through a leaf of wavesrv's router answering plain command names, like the first
// run (pkg/molten/onboarding/route.go): nothing is declared in pkg/wshrpc, the package upstream changes most.

const routeTimeout = 5 * time.Second

// Store reads and writes the rail; wcore provides it, since the order sorts Wave's workspace list. Apply runs a change
// on the normalized rail under the rail order's lock, writes the order and the local groups in one transaction, and
// returns the rail as written.
type Store struct {
	Read  func(ctx context.Context) (Rail, error)
	Apply func(ctx context.Context, change func(Rail) (Rail, error)) (Rail, error)
}

// Products tells which product each workspace belongs to, only for products of two members or more (FR-MC-027).
// Mission Control provides it (pkg/molten/mission), which resolves the groups; this package cannot import it, since
// Mission Control reads the order.
type Products func(ctx context.Context) (ProductMap, error)

var groupingLock sync.Mutex
var productsFn Products
var movedFn func()
var displacedFn func([]Displaced)
var reconcileFn func(ProductMap)

// One reconcile runs at a time; products seen meanwhile replace the pending ones, so a burst of resolutions makes at
// most one more pass, with the newest products.
var reconcileLock sync.Mutex
var reconcileRunning bool
var reconcilePending *ProductMap

// SetGrouping installs the product resolution, what to tell once a move is written (the groups follow the order) and
// what to tell when a project product took local members (FR-MC-032-AC8: one notification).
func SetGrouping(products Products, moved func(), displaced func([]Displaced)) {
	groupingLock.Lock()
	defer groupingLock.Unlock()
	productsFn = products
	movedFn = moved
	displacedFn = displaced
}

// SetReconcile installs what rewrites the local groups once the products changed; wcore installs it.
func SetReconcile(fn func(ProductMap)) {
	groupingLock.Lock()
	defer groupingLock.Unlock()
	reconcileFn = fn
}

func getGrouping() (Products, func(), func([]Displaced), func(ProductMap)) {
	groupingLock.Lock()
	defer groupingLock.Unlock()
	return productsFn, movedFn, displacedFn, reconcileFn
}

// ProductsOf resolves the products; none when no resolution is installed.
func ProductsOf(ctx context.Context) (ProductMap, error) {
	fn, _, _, _ := getGrouping()
	if fn == nil {
		return ProductMap{}, nil
	}
	return fn(ctx)
}

// Moved tells that a move was written.
func Moved() {
	_, fn, _, _ := getGrouping()
	if fn != nil {
		fn()
	}
}

// TellDisplaced tells the local members a project product took.
func TellDisplaced(displaced []Displaced) {
	_, _, fn, _ := getGrouping()
	if fn != nil && len(displaced) > 0 {
		fn(displaced)
	}
}

// ProductsSeen hands the products Mission Control just resolved to the local groups: a local member a project product
// now shows leaves its group (FR-MC-032-AC8). Linking a workspace changes no rail data, so this is how the rail learns.
func ProductsSeen(products ProductMap) {
	_, _, _, fn := getGrouping()
	if fn == nil || !queueReconcile(products) {
		return
	}
	go func() {
		defer func() {
			panichandler.PanicHandler("molten:railorder:reconcile", recover())
		}()
		for {
			next, ok := nextReconcile()
			if !ok {
				return
			}
			fn(next)
		}
	}()
}

// queueReconcile keeps the products for the next pass; true when no pass is running, so the caller starts one.
func queueReconcile(products ProductMap) bool {
	reconcileLock.Lock()
	defer reconcileLock.Unlock()
	reconcilePending = &products
	if reconcileRunning {
		return false
	}
	reconcileRunning = true
	return true
}

func nextReconcile() (ProductMap, bool) {
	reconcileLock.Lock()
	defer reconcileLock.Unlock()
	if reconcilePending == nil {
		reconcileRunning = false
		return ProductMap{}, false
	}
	next := *reconcilePending
	reconcilePending = nil
	return next, true
}

func decode[T any](data any) (T, error) {
	var req T
	err := utilfn.ReUnmarshal(&req, data)
	return req, err
}

type routeLink struct {
	store Store
}

// route: the windows, and `molten rail group` in a local terminal (FR-MC-032-AC10); never a remote host.
func (l *routeLink) route() localroute.Route {
	return localroute.Route{Id: RouteId, Policy: localroute.Policy{Default: localroute.AllowLocal}, Handler: l.handle}
}

func (l *routeLink) apply(ctx context.Context, change func(Rail) (Rail, error)) (any, error) {
	rail, err := l.store.Apply(ctx, change)
	if err != nil {
		return nil, err
	}
	return rail.List(), nil
}

func (l *routeLink) handle(ctx context.Context, command string, _ localroute.Caller, data any) (any, error) {
	ctx, cancel := context.WithTimeout(ctx, routeTimeout)
	defer cancel()
	switch command {
	case MoveCommand:
		req, err := decode[MoveRequest](data)
		if err != nil {
			return nil, err
		}
		rail, err := l.store.Apply(ctx, func(r Rail) (Rail, error) { return r.Move(req) })
		if err != nil {
			return nil, err
		}
		return rail.Order, nil
	case JoinCommand:
		req, err := decode[JoinRequest](data)
		if err != nil {
			return nil, err
		}
		return l.apply(ctx, func(r Rail) (Rail, error) { return r.Join(req) })
	case LeaveCommand:
		req, err := decode[LeaveRequest](data)
		if err != nil {
			return nil, err
		}
		return l.apply(ctx, func(r Rail) (Rail, error) { return r.Leave(req) })
	case RenameCommand:
		req, err := decode[RenameRequest](data)
		if err != nil {
			return nil, err
		}
		return l.apply(ctx, func(r Rail) (Rail, error) { return r.Rename(req) })
	case UngroupCommand:
		req, err := decode[UngroupRequest](data)
		if err != nil {
			return nil, err
		}
		return l.apply(ctx, func(r Rail) (Rail, error) { return r.Ungroup(req) })
	case ListCommand:
		rail, err := l.store.Read(ctx)
		if err != nil {
			return nil, err
		}
		return rail.List(), nil
	}
	return nil, fmt.Errorf("unknown rail order command %q", command)
}

// StartRoute registers the route; wavesrv calls it once.
func StartRoute(store Store) {
	if _, err := localroute.Register(wshutil.DefaultRouter, (&routeLink{store: store}).route()); err != nil {
		log.Printf("molten: rail order route not started: %v\n", err)
	}
}
