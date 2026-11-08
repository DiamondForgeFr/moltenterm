// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wshutil

import (
	"fmt"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

func subscribeUnannounceTest(t *testing.T, route string) (string, string) {
	t.Helper()
	event, scope := "molten:test-unannounce", t.Name()+":"+route
	wps.Broker.Subscribe(route, wps.SubscriptionRequest{Event: event, Scopes: []string{scope}})
	t.Cleanup(func() { wps.Broker.UnsubscribeAll(route) })
	if !wps.Broker.HasSubscribers(event, scope) {
		t.Fatal("fixture subscription was not registered")
	}
	return event, scope
}

func TestUnannounceRefusesAnotherLinksRoute(t *testing.T) {
	for _, route := range []string{MakeTabRouteId("win"), MakeConnectionRouteId("other")} {
		t.Run(route, func(t *testing.T) {
			e := makeRemoteTestEnv(t)
			owner := e.router.GetLinkIdForRoute(route)
			event, scope := subscribeUnannounceTest(t, route)
			e.remote.send(t, RpcMessage{Command: "routeunannounce", Route: ControlRoute, Source: route, ReqId: "foreign-unannounce"})
			if answer := e.remote.waitAnswer(t, "foreign-unannounce"); answer.Error == "" {
				t.Fatal("non-owner unannouncement was accepted")
			}
			if got := e.router.GetLinkIdForRoute(route); got != owner {
				t.Fatalf("route owner changed: got %d, want %d", got, owner)
			}
			if !wps.Broker.HasSubscribers(event, scope) {
				t.Fatal("non-owner unannouncement removed the owner's subscription")
			}
		})
	}
}

func TestUnannounceOwnerAndRepeatedRemoval(t *testing.T) {
	e := makeRemoteTestEnv(t)
	route := MakeConnectionRouteId(remoteTestConn)
	event, scope := subscribeUnannounceTest(t, route)
	e.remote.send(t, RpcMessage{Command: "routeunannounce", Route: ControlRoute, Source: route, ReqId: "owner-unannounce"})
	if answer := e.remote.waitAnswer(t, "owner-unannounce"); answer.Error != "" {
		t.Fatal(answer.Error)
	}
	if got := e.router.GetLinkIdForRoute(route); got != baseds.NoLinkId {
		t.Fatalf("owner's route stayed bound to %d", got)
	}
	if wps.Broker.HasSubscribers(event, scope) {
		t.Fatal("owner cleanup left its subscription registered")
	}
	// A repeated/missing removal cannot erase subscriptions created after the original cleanup.
	wps.Broker.Subscribe(route, wps.SubscriptionRequest{Event: event, Scopes: []string{scope}})
	if err := e.router.unbindRoute(e.remoteLink, route); err == nil {
		t.Fatal("missing route unannouncement was accepted")
	}
	if !wps.Broker.HasSubscribers(event, scope) {
		t.Fatal("repeated cleanup removed a later subscription")
	}
}

func TestUnannounceStaleOwnerKeepsReconnectedWindow(t *testing.T) {
	e := makeRemoteTestEnv(t)
	route := MakeTabRouteId("win")
	oldOwner := e.router.GetLinkIdForRoute(route)
	reconnected := makeRemoteTestPeer(t)
	newOwner := e.router.RegisterWindowRouter(reconnected)
	e.announce(t, reconnected, route)
	event, scope := subscribeUnannounceTest(t, route)
	e.router.UnregisterLink(oldOwner)
	if err := e.router.unbindRoute(oldOwner, route); err == nil {
		t.Fatal("stale owner's delayed unannouncement was accepted")
	}
	if got := e.router.GetLinkIdForRoute(route); got != newOwner {
		t.Fatalf("reconnected route owner = %d, want %d", got, newOwner)
	}
	if !wps.Broker.HasSubscribers(event, scope) {
		t.Fatal("old link cleanup removed the reconnected window's subscription")
	}
}

func TestUnannounceConcurrentReconnectKeepsNewSubscriptions(t *testing.T) {
	router := NewWshRouter()
	router.SetAsRootRouter()
	oldOwner := router.RegisterWindowRouter(makeRemoteTestPeer(t))
	newOwner := router.RegisterWindowRouter(makeRemoteTestPeer(t))
	const route = "tab:concurrent-unannounce"
	t.Cleanup(func() { wps.Broker.UnsubscribeAll(route) })
	for i := 0; i < 20; i++ {
		if err := router.bindRoute(oldOwner, route, false); err != nil {
			t.Fatal(err)
		}
		scope := fmt.Sprintf("%s:%d", t.Name(), i)
		start := make(chan struct{})
		removed, rebound := make(chan error, 1), make(chan error, 1)
		go func() {
			<-start
			removed <- router.unbindRoute(oldOwner, route)
		}()
		go func() {
			<-start
			err := router.bindRoute(newOwner, route, false)
			if err == nil {
				wps.Broker.Subscribe(route, wps.SubscriptionRequest{Event: "molten:test-reconnect", Scopes: []string{scope}})
			}
			rebound <- err
		}()
		close(start)
		deadline := time.After(time.Minute) // Only bounds a failing run; both goroutines finish before cleanup.
		for _, result := range []<-chan error{removed, rebound} {
			select {
			case err := <-result:
				// Either removal won, or the replaced owner was refused. Both are valid.
				if result == rebound && err != nil {
					t.Fatal(err)
				}
			case <-deadline:
				t.Fatal("concurrent cleanup/reconnect did not finish")
			}
		}
		if got := router.GetLinkIdForRoute(route); got != newOwner {
			t.Fatalf("replacement owner = %d, want %d", got, newOwner)
		}
		if !wps.Broker.HasSubscribers("molten:test-reconnect", scope) {
			t.Fatal("old cleanup erased the replacement's subscription")
		}
	}
}

func TestUnannounceUpstreamOnlyForOwner(t *testing.T) {
	router := NewWshRouter()
	upstream := makeGuardTestPeer(t)
	router.RegisterUpstream(upstream)
	owner := router.RegisterTrustedRouter(makeGuardTestPeer(t))
	other := router.RegisterTrustedRouter(makeGuardTestPeer(t))
	const route = "proc:unannounce-owner"
	if err := router.bindRoute(owner, route, false); err != nil {
		t.Fatal(err)
	}
	upstream.next(t, "initial announcement", func(m RpcMessage) bool { return m.Command == "routeannounce" && m.Source == route })
	for i, link := range []baseds.LinkId{other, owner, owner} {
		err := router.unbindRoute(link, route)
		if (err == nil) != (i == 1) {
			t.Fatalf("removal %d error = %v", i, err)
		}
		// The FIFO marker proves all earlier upstream work was observed, without a timed absence assertion.
		marker := fmt.Sprintf("test:unannounce-barrier-%d", i)
		router.announceUpstream(marker)
		var removals int
		upstream.next(t, "upstream barrier", func(m RpcMessage) bool {
			if m.Command == "routeunannounce" && m.Source == route {
				removals++
			}
			return m.Command == "routeannounce" && m.Source == marker
		})
		want := 0
		if i == 1 {
			want = 1
		}
		if removals != want {
			t.Fatalf("removal %d emitted %d upstream unannouncements, want %d", i, removals, want)
		}
	}
}
