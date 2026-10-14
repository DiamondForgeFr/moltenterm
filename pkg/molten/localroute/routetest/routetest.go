// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package routetest builds a router with every kind of caller a molten route meets, for the routes' tests: a window,
// Electron main, a local terminal, and a remote connection that forwards a terminal of its own and forged sources.
package routetest

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

const (
	WindowTabId   = "window"
	TerminalBlock = "block-local"
	// answerDeadline only bounds a failing run.
	answerDeadline = time.Minute
)

// From is a request's claimed source and the link it comes in on.
type From struct {
	Name   string
	Source string
	Link   baseds.LinkId
}

type Env struct {
	Router   *wshutil.WshRouter
	window   baseds.LinkId
	terminal baseds.LinkId
	remote   baseds.LinkId
}

type peer struct {
	in  chan []byte
	out chan []byte
}

func (p *peer) GetPeerInfo() string { return "routetest" }
func (p *peer) RecvRpcMessage() ([]byte, bool) {
	msg, ok := <-p.in
	return msg, ok
}
func (p *peer) SendRpcMessage(msg []byte, _ baseds.LinkId, _ string) bool {
	select {
	case p.out <- msg:
	default:
	}
	return true
}

func makePeer(t *testing.T) *peer {
	t.Helper()
	p := &peer{in: make(chan []byte, 1), out: make(chan []byte, 16)}
	t.Cleanup(func() { close(p.in) })
	return p
}

func announce(t *testing.T, p *peer, source string) {
	t.Helper()
	msg, err := json.Marshal(wshutil.RpcMessage{Command: "routeannounce", Route: wshutil.ControlRoute, Source: source, ReqId: source})
	if err != nil {
		t.Fatal(err)
	}
	p.in <- msg
	deadline := time.After(answerDeadline)
	for {
		select {
		case msg := <-p.out:
			var resp wshutil.RpcMessage
			if err := json.Unmarshal(msg, &resp); err != nil || resp.ResId != source {
				continue
			}
			if resp.Error != "" {
				t.Fatalf("announce %s: %s", source, resp.Error)
			}
			return
		case <-deadline:
			t.Fatalf("route announcement of %s did not answer", source)
		}
	}
}

// Make builds the router: the windows' websocket announces "tab:window" and Electron main, a local terminal's leaf is
// "proc:local" for block TerminalBlock, and a remote connection announces "proc:remote" and the forged "tab:forged".
func Make(t *testing.T) *Env {
	t.Helper()
	router := wshutil.NewWshRouter()
	router.SetAsRootRouter()
	e := &Env{Router: router}
	var err error
	e.terminal, err = router.RegisterTerminalLeaf(makePeer(t), "proc:local", TerminalBlock)
	if err != nil {
		t.Fatal(err)
	}
	window := makePeer(t)
	e.window = router.RegisterWindowRouter(window)
	announce(t, window, wshutil.MakeTabRouteId(WindowTabId))
	announce(t, window, wshutil.ElectronRoute)
	remote := makePeer(t)
	e.remote = router.RegisterTrustedRouter(remote)
	announce(t, remote, "proc:remote")
	announce(t, remote, "tab:forged")
	return e
}

func (e *Env) Window() From {
	return From{Name: "window", Source: wshutil.MakeTabRouteId(WindowTabId), Link: e.window}
}

func (e *Env) Electron() From {
	return From{Name: "electron", Source: wshutil.ElectronRoute, Link: e.window}
}

func (e *Env) Terminal() From {
	return From{Name: "local terminal", Source: "proc:local", Link: e.terminal}
}

// Forged lists the callers no route answers: a remote terminal, a remote host forging a window, Electron main or a
// local terminal, and a local terminal forging a window.
func (e *Env) Forged() []From {
	return []From{
		{Name: "remote terminal", Source: "proc:remote", Link: e.remote},
		{Name: "remote forged window", Source: "tab:forged", Link: e.remote},
		{Name: "remote names the window", Source: wshutil.MakeTabRouteId(WindowTabId), Link: e.remote},
		{Name: "remote names electron", Source: wshutil.ElectronRoute, Link: e.remote},
		{Name: "remote names the local terminal", Source: "proc:local", Link: e.remote},
		{Name: "terminal names the window", Source: wshutil.MakeTabRouteId(WindowTabId), Link: e.terminal},
		{Name: "terminal names electron", Source: wshutil.ElectronRoute, Link: e.terminal},
		{Name: "no source", Source: "", Link: e.window},
	}
}

// NonWindows: every caller a window-only command refuses.
func (e *Env) NonWindows() []From {
	return append([]From{e.Terminal(), e.Electron()}, e.Forged()...)
}

// NonLocal: every caller a local-only command refuses.
func (e *Env) NonLocal() []From {
	return e.Forged()
}

// Send sends a request that wants no answer (no reqid) to link as from.
func Send(t *testing.T, link *localroute.Link, from From, command string, data any) {
	t.Helper()
	msg, err := json.Marshal(wshutil.RpcMessage{Command: command, Source: from.Source, Data: data})
	if err != nil {
		t.Fatal(err)
	}
	link.SendRpcMessage(msg, from.Link, "")
}

// Ask sends one request to link as from and waits for its answer. Calls on one link must not overlap.
func Ask(t *testing.T, link *localroute.Link, from From, command string, data any) (any, string) {
	t.Helper()
	reqId := uuid.NewString()
	msg, err := json.Marshal(wshutil.RpcMessage{Command: command, ReqId: reqId, Source: from.Source, Data: data})
	if err != nil {
		t.Fatal(err)
	}
	link.SendRpcMessage(msg, from.Link, "")
	got := make(chan []byte, 1)
	go func() {
		for {
			msg, ok := link.RecvRpcMessage()
			if !ok {
				return
			}
			var resp wshutil.RpcMessage
			if json.Unmarshal(msg, &resp) == nil && resp.ResId == reqId {
				got <- msg
				return
			}
		}
	}()
	select {
	case msg := <-got:
		var resp wshutil.RpcMessage
		if err := json.Unmarshal(msg, &resp); err != nil {
			t.Fatal(err)
		}
		return resp.Data, resp.Error
	case <-time.After(answerDeadline):
		t.Fatalf("%s from %s did not answer", command, from.Name)
	}
	return nil, ""
}

// MustRefuse asks command from each caller and fails unless the route's caller policy refuses each one.
func MustRefuse(t *testing.T, link *localroute.Link, froms []From, command string, data any) {
	t.Helper()
	MustRefuseWith(t, link, froms, command, data, localroute.RefusalMark)
}

// MustRefuseWith is MustRefuse for a command whose policy refusal has its own message (Policy.Refusals).
func MustRefuseWith(t *testing.T, link *localroute.Link, froms []From, command string, data any, refusal string) {
	t.Helper()
	for _, from := range froms {
		if _, errStr := Ask(t, link, from, command, data); !strings.Contains(errStr, refusal) {
			t.Errorf("%s from %s (%q) was not refused: %q", command, from.Name, from.Source, errStr)
		}
	}
}
