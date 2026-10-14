// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package localroute_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

func TestResolve(t *testing.T) {
	e := routetest.Make(t)
	cases := []struct {
		from routetest.From
		want localroute.Caller
	}{
		{e.Window(), localroute.Caller{Source: "tab:window", IsWindow: true, TabId: routetest.WindowTabId}},
		{e.Electron(), localroute.Caller{Source: wshutil.ElectronRoute, IsElectron: true}},
		{e.Terminal(), localroute.Caller{Source: "proc:local", IsLocalTerminal: true, BlockId: routetest.TerminalBlock}},
		{routetest.From{Name: "unknown link", Source: "proc:local", Link: baseds.LinkId(99999)}, localroute.Caller{}},
		{routetest.From{Name: "missing link", Source: "proc:local", Link: baseds.NoLinkId}, localroute.Caller{}},
	}
	for _, from := range e.Forged() {
		cases = append(cases, struct {
			from routetest.From
			want localroute.Caller
		}{from, localroute.Caller{}})
	}
	for _, c := range cases {
		t.Run(c.from.Name, func(t *testing.T) {
			if got := localroute.Resolve(e.Router, c.from.Source, c.from.Link); got != c.want {
				t.Fatalf("Resolve(%q, %d) = %+v, want %+v", c.from.Source, c.from.Link, got, c.want)
			}
		})
	}
	if got := localroute.Resolve(nil, "proc:local", e.Terminal().Link); got != (localroute.Caller{}) {
		t.Fatalf("an uninitialized router resolved %+v", got)
	}
}

func TestPolicyIsRequired(t *testing.T) {
	handler := func(context.Context, string, localroute.Caller, any) (any, error) { return nil, nil }
	bad := []localroute.Route{
		{Id: "r", Handler: handler},
		{Id: "r", Handler: handler, Policy: localroute.Policy{Default: "anyone"}},
		{Id: "r", Handler: handler, Policy: localroute.Policy{Default: localroute.AllowLocal, Commands: map[string]string{"x": ""}}},
		{Id: "r", Policy: localroute.Policy{Default: localroute.AllowLocal}},
	}
	for i, route := range bad {
		if _, err := localroute.MakeLink(nil, route); err == nil {
			t.Errorf("route %d without a valid policy was made", i)
		}
	}
}

func TestLinkAdmitsByPolicy(t *testing.T) {
	e := routetest.Make(t)
	got := map[string][]localroute.Caller{}
	link, err := localroute.MakeLink(e.Router, localroute.Route{
		Id: "test",
		Policy: localroute.Policy{Default: localroute.AllowLocal, Commands: map[string]string{
			"window": localroute.AllowWindow, "ui": localroute.AllowUi, "terminal": localroute.AllowLocalTerminal, "any": localroute.AllowAny, "custom": localroute.AllowWindow,
		}, Refusals: map[string]string{"custom": "custom refusal"}},
		Handler: func(_ context.Context, command string, caller localroute.Caller, _ any) (any, error) {
			got[command] = append(got[command], caller)
			return command, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	admitted := map[string][]routetest.From{
		"local":    {e.Window(), e.Electron(), e.Terminal()},
		"window":   {e.Window()},
		"ui":       {e.Window(), e.Electron()},
		"terminal": {e.Terminal()},
		"any":      append([]routetest.From{e.Window(), e.Electron(), e.Terminal()}, e.Forged()...),
	}
	refused := map[string][]routetest.From{
		"local":    e.Forged(),
		"window":   e.NonWindows(),
		"ui":       append([]routetest.From{e.Terminal()}, e.Forged()...),
		"terminal": append([]routetest.From{e.Window(), e.Electron()}, e.Forged()...),
	}
	for command, froms := range admitted {
		for _, from := range froms {
			if data, errStr := routetest.Ask(t, link, from, command, nil); errStr != "" || data != command {
				t.Errorf("%s from %s: %v %q", command, from.Name, data, errStr)
			}
		}
	}
	calls := 0
	for _, callers := range got {
		calls += len(callers)
	}
	for command, froms := range refused {
		routetest.MustRefuse(t, link, froms, command, nil)
	}
	routetest.MustRefuseWith(t, link, e.NonWindows(), "custom", nil, "custom refusal")
	for _, callers := range got {
		calls -= len(callers)
	}
	if calls != 0 {
		t.Fatalf("refused callers reached the handler: %+v", got)
	}
	for _, c := range got["any"][3:] {
		if c != (localroute.Caller{}) {
			t.Fatalf("an unverified caller was handed as %+v", c)
		}
	}
}

func TestLinkCancelFromItsOwnLinkOnly(t *testing.T) {
	e := routetest.Make(t)
	started := make(chan context.Context, 1)
	link, err := localroute.MakeLink(e.Router, localroute.Route{
		Id:     "test",
		Policy: localroute.Policy{Default: localroute.AllowLocal},
		Handler: func(ctx context.Context, _ string, _ localroute.Caller, _ any) (any, error) {
			started <- ctx
			<-ctx.Done()
			return nil, ctx.Err()
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	send := func(msg wshutil.RpcMessage, from routetest.From) {
		raw, err := json.Marshal(msg)
		if err != nil {
			t.Fatal(err)
		}
		link.SendRpcMessage(raw, from.Link, "")
	}
	send(wshutil.RpcMessage{Command: "wait", ReqId: "r1", Source: e.Terminal().Source}, e.Terminal())
	ctx := <-started
	// SendRpcMessage cancels before it returns: another link's cancel left the call running.
	send(wshutil.RpcMessage{ReqId: "r1", Cancel: true}, e.Window())
	if ctx.Err() != nil {
		t.Fatal("another link cancelled the call")
	}
	send(wshutil.RpcMessage{ReqId: "r1", Cancel: true}, e.Terminal())
	select {
	case msg := <-recv(link):
		var resp wshutil.RpcMessage
		if err := json.Unmarshal(msg, &resp); err != nil || resp.ResId != "r1" || !strings.Contains(resp.Error, "canceled") {
			t.Fatalf("cancelled call: %s (%v)", msg, err)
		}
	case <-time.After(time.Minute):
		t.Fatal("the cancelled call did not answer")
	}
}

func recv(link *localroute.Link) <-chan []byte {
	ch := make(chan []byte, 1)
	go func() {
		if msg, ok := link.RecvRpcMessage(); ok {
			ch <- msg
		}
	}()
	return ch
}
