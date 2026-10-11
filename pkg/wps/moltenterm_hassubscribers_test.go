// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wps

import (
	"sort"
	"sync"
	"testing"
)

type routeRecorder struct {
	lock   sync.Mutex
	routes []string
}

func (r *routeRecorder) SendEvent(routeId string, event WaveEvent) {
	r.lock.Lock()
	defer r.lock.Unlock()
	r.routes = append(r.routes, routeId)
}

func makeTestBroker() (*BrokerType, *routeRecorder) {
	rec := &routeRecorder{}
	b := &BrokerType{Lock: &sync.Mutex{}, SubMap: make(map[string]*BrokerSubscription), PersistMap: make(map[persistKey]*persistEventWrap)}
	b.SetClient(rec)
	return b, rec
}

// A block's output reaches only the routes that subscribed to that block (FR-PERF-010-AC3).
func TestBlockFileRoutingIsScoped(t *testing.T) {
	b, rec := makeTestBroker()
	b.Subscribe("tab-shows-a", SubscriptionRequest{Event: Event_BlockFile, Scopes: []string{"block:a"}})
	b.Subscribe("tab-shows-a-and-b", SubscriptionRequest{Event: Event_BlockFile, Scopes: []string{"block:a", "block:b"}})
	b.Subscribe("tab-shows-c", SubscriptionRequest{Event: Event_BlockFile, Scopes: []string{"block:c"}})
	b.Subscribe("tab-other-event", SubscriptionRequest{Event: Event_WaveObjUpdate, AllScopes: true})

	if !b.HasSubscribers(Event_BlockFile, "block:a") || b.HasSubscribers(Event_BlockFile, "block:z") {
		t.Fatalf("HasSubscribers does not follow the scoped subscriptions")
	}
	b.Publish(WaveEvent{Event: Event_BlockFile, Scopes: []string{"block:a"}})
	got := append([]string(nil), rec.routes...)
	sort.Strings(got)
	if len(got) != 2 || got[0] != "tab-shows-a" || got[1] != "tab-shows-a-and-b" {
		t.Fatalf("block:a output went to %v", got)
	}

	b.Unsubscribe("tab-shows-a", Event_BlockFile)
	b.Unsubscribe("tab-shows-a-and-b", Event_BlockFile)
	if b.HasSubscribers(Event_BlockFile, "block:a") {
		t.Fatalf("HasSubscribers still true after the last subscriber left")
	}

	b.Subscribe("tab-all", SubscriptionRequest{Event: Event_BlockFile, AllScopes: true})
	if !b.HasSubscribers(Event_BlockFile, "block:z") {
		t.Fatalf("an all-scopes subscriber must count")
	}
	b.UnsubscribeAll("tab-all")
	b.Subscribe("tab-star", SubscriptionRequest{Event: Event_BlockFile, Scopes: []string{"block:*"}})
	if !b.HasSubscribers(Event_BlockFile, "block:z") {
		t.Fatalf("a star subscriber must count")
	}
}
