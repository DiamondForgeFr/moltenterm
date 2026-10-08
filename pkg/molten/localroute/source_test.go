// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package localroute

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

type testPeer struct {
	in  chan []byte
	out chan []byte
}

func (p *testPeer) GetPeerInfo() string { return "localroute-test" }
func (p *testPeer) RecvRpcMessage() ([]byte, bool) {
	msg, ok := <-p.in
	return msg, ok
}
func (p *testPeer) SendRpcMessage(msg []byte, _ baseds.LinkId, _ string) bool {
	p.out <- msg
	return true
}

func makePeer(t *testing.T) *testPeer {
	t.Helper()
	p := &testPeer{in: make(chan []byte, 1), out: make(chan []byte, 1)}
	t.Cleanup(func() { close(p.in) })
	return p
}

func announce(t *testing.T, p *testPeer, source string) {
	t.Helper()
	msg, err := json.Marshal(wshutil.RpcMessage{Command: "routeannounce", Route: wshutil.ControlRoute, Source: source, ReqId: source})
	if err != nil {
		t.Fatal(err)
	}
	p.in <- msg
	select {
	case msg := <-p.out:
		var resp wshutil.RpcMessage
		if err := json.Unmarshal(msg, &resp); err != nil || resp.Error != "" || resp.ResId != source {
			t.Fatalf("announce %s: %s (%v)", source, msg, err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("route announcement did not answer")
	}
}

func TestOnLink(t *testing.T) {
	router := wshutil.NewWshRouter()
	router.SetAsRootRouter()
	local, err := router.RegisterTrustedLeaf(makePeer(t), "proc:local")
	if err != nil {
		t.Fatal(err)
	}
	window := makePeer(t)
	windowId := router.RegisterTrustedRouter(window)
	announce(t, window, "tab:window")
	remote := makePeer(t)
	remoteId := router.RegisterTrustedRouter(remote)
	// No connection status is registered: forwarded proc: sources must still be refused.
	announce(t, remote, "proc:remote")
	if router.GetLinkIdForRoute("proc:remote") != remoteId {
		t.Fatal("remote source was not registered on its router link")
	}
	untrusted := router.RegisterUntrustedLink(makePeer(t))
	cases := []struct {
		name   string
		source string
		link   baseds.LinkId
		want   bool
	}{
		{"local terminal", "proc:local", local, true},
		{"local window", "tab:window", windowId, true},
		{"forwarded terminal", "proc:remote", remoteId, false},
		{"remote impersonates local terminal", "proc:local", remoteId, false},
		{"remote impersonates window", "tab:window", remoteId, false},
		{"terminal impersonates window", "tab:window", local, false},
		{"terminal impersonates another terminal", "proc:other", local, false},
		{"untrusted terminal", "proc:local", untrusted, false},
		{"untrusted window", "tab:window", untrusted, false},
		{"connection", "conn:remote", remoteId, false},
		{"empty source", "", local, false},
		{"missing link", "proc:local", baseds.NoLinkId, false},
		{"unknown link", "proc:local", baseds.LinkId(99999), false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := OnLink(router, c.source, c.link); got != c.want {
				t.Fatalf("OnLink(%q, %d) = %v, want %v", c.source, c.link, got, c.want)
			}
		})
	}
	if OnLink(nil, "proc:local", local) {
		t.Fatal("an uninitialized router accepted a source")
	}
}
