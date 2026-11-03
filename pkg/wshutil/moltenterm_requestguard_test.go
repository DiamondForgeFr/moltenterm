// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wshutil

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

// guardTestDeadline only bounds a failing run.
const guardTestDeadline = time.Minute

type guardTestPeer struct {
	in  chan []byte
	out chan []byte
}

func (p *guardTestPeer) GetPeerInfo() string { return "guardtest" }
func (p *guardTestPeer) RecvRpcMessage() ([]byte, bool) {
	msg, ok := <-p.in
	return msg, ok
}
func (p *guardTestPeer) SendRpcMessage(msg []byte, _ baseds.LinkId, _ string) bool {
	p.out <- msg
	return true
}

func makeGuardTestPeer(t *testing.T) *guardTestPeer {
	t.Helper()
	p := &guardTestPeer{in: make(chan []byte, 4), out: make(chan []byte, 64)}
	t.Cleanup(func() { close(p.in) })
	return p
}

func (p *guardTestPeer) send(t *testing.T, msg RpcMessage) {
	t.Helper()
	data, err := json.Marshal(msg)
	if err != nil {
		t.Fatal(err)
	}
	p.in <- data
}

// next is the next message p receives that matches.
func (p *guardTestPeer) next(t *testing.T, what string, match func(RpcMessage) bool) RpcMessage {
	t.Helper()
	deadline := time.After(guardTestDeadline)
	for {
		select {
		case data := <-p.out:
			var msg RpcMessage
			if json.Unmarshal(data, &msg) == nil && match(msg) {
				return msg
			}
		case <-deadline:
			t.Fatalf("%s never arrived", what)
		}
	}
}

// The root router asks the request guard before it forwards a request, and answers a refusal on the link the request
// came in on, without forwarding it (#1832): the window answers `wsh termscrollback` for whoever asks.
func TestRequestGuardRefusesBeforeForwarding(t *testing.T) {
	const command, ownRoute, otherRoute = "termgetscrollbacklines", "feblock:own", "feblock:other"
	var asked []string
	SetRequestGuard(func(router *WshRouter, msg RpcMessage, ingressLinkId baseds.LinkId) error {
		asked = append(asked, msg.Source)
		if msg.Command == command && msg.Route == otherRoute {
			return fmt.Errorf("refused: not yours")
		}
		return nil
	})
	t.Cleanup(func() { SetRequestGuard(nil) })

	router := NewWshRouter()
	router.SetAsRootRouter()
	window := makeGuardTestPeer(t)
	router.RegisterWindowRouter(window)
	for _, route := range []string{ownRoute, otherRoute} {
		window.send(t, RpcMessage{Command: "routeannounce", Route: ControlRoute, Source: route, ReqId: "announce-" + route})
		window.next(t, "announce of "+route, func(m RpcMessage) bool { return m.ResId == "announce-"+route })
	}
	term := makeGuardTestPeer(t)
	if _, err := router.RegisterTerminalLeaf(term, "proc:term", "block-term"); err != nil {
		t.Fatal(err)
	}

	term.send(t, RpcMessage{Command: command, ReqId: "req-other", Route: otherRoute})
	refusal := term.next(t, "the refusal", func(m RpcMessage) bool { return m.ResId == "req-other" })
	if refusal.Error != "refused: not yours" {
		t.Errorf("refusal: %+v", refusal)
	}
	term.send(t, RpcMessage{Command: command, ReqId: "req-own", Route: ownRoute})
	forwarded := window.next(t, "the allowed request", func(m RpcMessage) bool { return m.Command == command })
	if forwarded.ReqId != "req-own" || forwarded.Source != "proc:term" {
		t.Errorf("the window got %+v first, want only the allowed request", forwarded)
	}

	SetRequestGuard(nil)
	term.send(t, RpcMessage{Command: command, ReqId: "req-unguarded", Route: otherRoute})
	if got := window.next(t, "the unguarded request", func(m RpcMessage) bool { return m.Command == command }); got.ReqId != "req-unguarded" {
		t.Errorf("without a guard the window got %+v", got)
	}
	if len(asked) < 2 {
		t.Errorf("the guard was asked for %v", asked)
	}
}
