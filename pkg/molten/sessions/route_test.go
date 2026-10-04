// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package sessions

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

func makeTestLink(sessions ...molten.DurableSession) (*routeLink, *fakeOps) {
	a, _, ops := makeTestActions(sessions...)
	return &routeLink{output: make(chan []byte, 1), model: a.model, actions: a}, ops
}

func TestRouteCallers(t *testing.T) {
	l, ops := makeTestLink(detachedS)
	if _, err := l.handle(molten.DurableSessionsListCommand, "conn:me@box", nil); err == nil {
		t.Fatalf("a remote host is not answered")
	}
	if _, err := l.handle(molten.DurableSessionsListCommand, "proc:abc", nil); err != nil {
		t.Fatalf("a terminal lists: %v", err)
	}
	_, err := l.handle(molten.DurableSessionsCleanupCommand, "proc:abc", map[string]any{"ids": []string{"detached"}})
	if err == nil || !strings.Contains(err.Error(), "window") {
		t.Fatalf("cleanup from a terminal: %v", err)
	}
	if len(ops.calls) != 0 {
		t.Fatalf("refused cleanup ended something: %s", ops.trace())
	}
	if _, err := l.handle("moltensessionsnope", "tab:t1", nil); err == nil || !strings.Contains(err.Error(), "unknown") {
		t.Fatalf("unknown command: %v", err)
	}
	if _, err := l.handle(molten.DurableSessionsEndCommand, "tab:t1", "not an object"); err == nil {
		t.Fatalf("bad data accepted")
	}
}

func TestRouteShowUsesTheWindowsTab(t *testing.T) {
	l, ops := makeTestLink(detachedS)
	if _, err := l.handle(molten.DurableSessionsShowCommand, "tab:tabA", map[string]any{"id": "detached"}); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(ops.trace(), "create tabA") {
		t.Fatalf("show from a window opens in its tab: %s", ops.trace())
	}
}

func TestRelevantEvent(t *testing.T) {
	cases := []struct {
		event wps.WaveEvent
		want  bool
	}{
		{wps.WaveEvent{Event: wps.Event_RouteUp, Scopes: []string{"job:1"}}, true},
		{wps.WaveEvent{Event: wps.Event_RouteUp, Scopes: []string{"tab:1"}}, false},
		{wps.WaveEvent{Event: wps.Event_WaveObjUpdate, Scopes: []string{"block:1"}}, true},
		{wps.WaveEvent{Event: wps.Event_WaveObjUpdate, Scopes: []string{"workspace:1"}}, true},
		{wps.WaveEvent{Event: wps.Event_WaveObjUpdate, Scopes: []string{"layout:1"}}, false},
		{wps.WaveEvent{Event: wps.Event_BlockClose}, true},
	}
	for _, c := range cases {
		if got := relevantEvent(&c.event); got != c.want {
			t.Fatalf("%s %v: got %v", c.event.Event, c.event.Scopes, got)
		}
	}
}
