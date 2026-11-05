// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wshutil

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

// announceOrderRouter is a root router whose control route never answers, as when its goroutine has not run yet, a
// wavesrv leaf and a window's websocket.
func announceOrderRouter(t *testing.T) (*WshRouter, baseds.LinkId, *guardTestPeer, *guardTestPeer) {
	t.Helper()
	router := NewWshRouter()
	router.SetAsRootRouter()
	stalled := makeGuardTestPeer(t)
	stalledLink, err := router.RegisterTrustedLeaf(stalled, "test:stalledcontrol")
	if err != nil {
		t.Fatal(err)
	}
	router.lock.Lock()
	router.routeMap[ControlRoute] = stalledLink
	router.routeMap[ControlRootRoute] = stalledLink
	router.lock.Unlock()
	wavesrv := makeGuardTestPeer(t)
	if _, err := router.RegisterTrustedLeaf(wavesrv, DefaultRoute); err != nil {
		t.Fatal(err)
	}
	window := makeGuardTestPeer(t)
	windowLink := router.RegisterWindowRouter(window)
	return router, windowLink, window, wavesrv
}

// A window that reconnects announces its tab route, then subscribes to events (#1950). The subscription is checked
// against the route's link, so the route must be bound when the next request of that link arrives, whatever the
// control route's goroutine does: the agent states were refused otherwise, and the view never followed them again.
func TestAnnounceBindsBeforeTheLinksNextRequest(t *testing.T) {
	router, windowLink, window, wavesrv := announceOrderRouter(t)
	const tabRoute = "tab:t1950"

	window.send(t, RpcMessage{Command: "routeannounce", Route: ControlRoute, Source: tabRoute})
	window.send(t, RpcMessage{Command: "eventsub", Route: DefaultRoute, Source: tabRoute, ReqId: "sub-1"})
	wavesrv.next(t, "the subscription", func(m RpcMessage) bool { return m.ReqId == "sub-1" })
	if !router.IsWindowSource(windowLink, tabRoute) {
		t.Fatalf("the subscription reached wavesrv before %q was bound to the window's websocket", tabRoute)
	}

	window.send(t, RpcMessage{Command: "routeunannounce", Route: ControlRoute, Source: tabRoute})
	window.send(t, RpcMessage{Command: "eventsub", Route: DefaultRoute, Source: tabRoute, ReqId: "sub-2"})
	wavesrv.next(t, "the second subscription", func(m RpcMessage) bool { return m.ReqId == "sub-2" })
	if router.IsWindowSource(windowLink, tabRoute) {
		t.Fatalf("%q stayed bound after the window unannounced it", tabRoute)
	}
}

// An announce that asks for an answer still goes to the control route, which answers it.
func TestAnnounceWithRequestIdGoesToTheControlRoute(t *testing.T) {
	router := NewWshRouter()
	router.SetAsRootRouter()
	window := makeGuardTestPeer(t)
	windowLink := router.RegisterWindowRouter(window)
	window.send(t, RpcMessage{Command: "routeannounce", Route: ControlRoute, Source: "tab:answered", ReqId: "announce-1"})
	answer := window.next(t, "the announce's answer", func(m RpcMessage) bool { return m.ResId == "announce-1" })
	if answer.Error != "" {
		t.Fatalf("announce answered %q", answer.Error)
	}
	if !router.IsWindowSource(windowLink, "tab:answered") {
		t.Fatal("the answered announce did not bind the route")
	}
}
