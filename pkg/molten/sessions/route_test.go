// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package sessions

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

func makeTestLink(sessions ...molten.DurableSession) (*routeLink, *fakeOps) {
	a, _, ops := makeTestActions(sessions...)
	return &routeLink{output: make(chan []byte, 1), model: a.model, actions: a}, ops
}

func TestRouteRefusesForwardedCallers(t *testing.T) {
	for _, source := range []string{"proc:remote", "tab:forged", "conn:remote"} {
		for _, command := range []string{molten.DurableSessionsListCommand, molten.DurableSessionsShowCommand, molten.DurableSessionsEndCommand, molten.DurableSessionsReconnectCommand, molten.DurableSessionsCleanupCommand} {
			t.Run(source+"/"+command, func(t *testing.T) {
				l, ops := makeTestLink(detachedS)
				l.localSource = func(gotSource string, gotLink baseds.LinkId) bool {
					if gotSource != source || gotLink != 7 {
						t.Errorf("source check got %q on %d", gotSource, gotLink)
					}
					return false
				}
				req := wshutil.RpcMessage{Command: command, ReqId: "r1", Source: source, Data: map[string]any{"id": "detached", "ids": []string{"detached"}}}
				msg, err := json.Marshal(req)
				if err != nil {
					t.Fatal(err)
				}
				l.SendRpcMessage(msg, 7, "")
				select {
				case msg := <-l.output:
					var resp wshutil.RpcMessage
					if err := json.Unmarshal(msg, &resp); err != nil || resp.ResId != "r1" || !strings.Contains(resp.Error, "local terminals only") || resp.Data != nil {
						t.Fatalf("refused caller: %s (%v)", msg, err)
					}
				case <-time.After(5 * time.Second):
					t.Fatal("source check did not answer")
				}
				if len(ops.calls) != 0 {
					t.Fatalf("refused caller acted on a session: %s", ops.trace())
				}
			})
		}
	}
}

func TestRouteAnswersVerifiedLocalCallers(t *testing.T) {
	for _, source := range []string{"proc:local", "tab:window"} {
		t.Run(source, func(t *testing.T) {
			l, _ := makeTestLink(detachedS)
			l.localSource = func(string, baseds.LinkId) bool { return true }
			l.answer(wshutil.RpcMessage{Command: molten.DurableSessionsListCommand, ReqId: "r1", Source: source}, 7)
			var resp wshutil.RpcMessage
			if err := json.Unmarshal(<-l.output, &resp); err != nil || resp.Error != "" || resp.Data == nil {
				t.Fatalf("local list: %+v (%v)", resp, err)
			}
		})
	}
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
