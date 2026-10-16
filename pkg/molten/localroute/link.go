// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package localroute

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// The molten routes are leaves of wavesrv's router answering plain command names (nothing is declared in pkg/wshrpc).
// A request's source is only what its sender wrote unless the router stamped it: a local terminal's leaf gets its own
// route, but a router link (the windows' websocket, an SSH or WSL connection) forwards any source. Link reads who is
// calling from the link the request came in on, once, and answers only the callers its policy lets in (#662).

const (
	// AllowWindow lets in MoltenTerm's windows: a "tab:" route on the windows' own websocket.
	AllowWindow = "window"
	// AllowUi lets in the windows and Electron main.
	AllowUi = "ui"
	// AllowLocalTerminal lets in a local terminal's wsh (agents' hooks and MCP servers, `molten`), on its own leaf.
	AllowLocalTerminal = "terminal"
	// AllowLocal lets in the windows, Electron main and local terminals: never a remote host.
	AllowLocal = "local"
	// AllowAny lets in every caller the router trusts, remote connections included, for the few commands a remote host
	// legitimately sends (`molten open`, `molten agent state`). The handler gets an unverified Caller and must not act on
	// its source.
	AllowAny = "any"
)

const outputQueueSize = 64

// RefusalMark is in the error of every request a route's policy refuses.
const RefusalMark = "is answered to"

// Caller is who sent a request, as the router's links prove it. Anything else (a remote connection, a source forged
// on another link) is a Caller with no kind and no source.
type Caller struct {
	// Source is the verified source route, "" when unverified.
	Source          string
	IsWindow        bool
	IsElectron      bool
	IsLocalTerminal bool
	// TabId is a window's tab.
	TabId string
	// BlockId is the block a local terminal's token was issued to ("" when its token named none).
	BlockId string
}

// IsUi: a window or Electron main, the user's own surfaces.
func (c Caller) IsUi() bool {
	return c.IsWindow || c.IsElectron
}

// Resolve reads who sent source through ingressLinkId. It takes the router's lock: never call it from
// SendRpcMessage, which the router calls under that lock.
func Resolve(router *wshutil.WshRouter, source string, ingressLinkId baseds.LinkId) Caller {
	if router == nil || source == "" || ingressLinkId == baseds.NoLinkId {
		return Caller{}
	}
	switch {
	case strings.HasPrefix(source, wshutil.RoutePrefix_Tab):
		if router.IsWindowSource(ingressLinkId, source) {
			return Caller{Source: source, IsWindow: true, TabId: strings.TrimPrefix(source, wshutil.RoutePrefix_Tab)}
		}
	case source == wshutil.ElectronRoute:
		if router.IsWindowSource(ingressLinkId, source) {
			return Caller{Source: source, IsElectron: true}
		}
	case strings.HasPrefix(source, wshutil.RoutePrefix_Proc):
		if blockId, ok := router.LeafSourceBlockId(ingressLinkId, source); ok {
			return Caller{Source: source, IsLocalTerminal: true, BlockId: blockId}
		}
	}
	return Caller{}
}

// Policy names the callers each command lets in. Default is required; Commands overrides it per command, and
// Refusals replaces the error a refused command gets.
type Policy struct {
	Default  string
	Commands map[string]string
	Refusals map[string]string
}

func validAllow(allow string) bool {
	return allow == AllowWindow || allow == AllowUi || allow == AllowLocalTerminal || allow == AllowLocal || allow == AllowAny
}

func (p Policy) check() error {
	if !validAllow(p.Default) {
		return fmt.Errorf("no caller policy (%q)", p.Default)
	}
	for command, allow := range p.Commands {
		if !validAllow(allow) {
			return fmt.Errorf("no caller policy for %s (%q)", command, allow)
		}
	}
	return nil
}

// Admits tells whether the policy lets caller send command.
func (p Policy) Admits(command string, c Caller) bool {
	return admits(p.allowOf(command), c)
}

func (p Policy) allowOf(command string) string {
	if allow, ok := p.Commands[command]; ok {
		return allow
	}
	return p.Default
}

func admits(allow string, c Caller) bool {
	switch allow {
	case AllowWindow:
		return c.IsWindow
	case AllowUi:
		return c.IsUi()
	case AllowLocalTerminal:
		return c.IsLocalTerminal
	case AllowLocal:
		return c.IsUi() || c.IsLocalTerminal
	case AllowAny:
		return true
	}
	return false
}

func refusal(allow string) string {
	switch allow {
	case AllowWindow, AllowUi:
		return "MoltenTerm windows only"
	case AllowLocalTerminal:
		return "local MoltenTerm terminals only"
	}
	return "MoltenTerm windows and local terminals only"
}

// Handler answers a command from a caller the policy let in. ctx ends when the caller cancels the request.
type Handler func(ctx context.Context, command string, caller Caller, data any) (any, error)

// Route is what a molten package registers.
type Route struct {
	Id      string
	Policy  Policy
	Handler Handler
	// RunUnanswered runs requests without a reqid (they want no answer) instead of dropping them.
	RunUnanswered bool
}

type pendingCall struct {
	ingressLinkId baseds.LinkId
	cancel        context.CancelFunc
}

// Link is a route's leaf on the router.
type Link struct {
	route  Route
	router *wshutil.WshRouter
	output chan []byte

	lock    sync.Mutex
	pending map[string]pendingCall
}

// MakeLink builds a route's link on router without registering it.
func MakeLink(router *wshutil.WshRouter, route Route) (*Link, error) {
	if route.Id == "" || route.Handler == nil {
		return nil, fmt.Errorf("route %q has no handler", route.Id)
	}
	if err := route.Policy.check(); err != nil {
		return nil, fmt.Errorf("route %s: %w", route.Id, err)
	}
	return &Link{route: route, router: router, output: make(chan []byte, outputQueueSize), pending: map[string]pendingCall{}}, nil
}

// Register builds a route's link and registers it as a leaf of router.
func Register(router *wshutil.WshRouter, route Route) (*Link, error) {
	link, err := MakeLink(router, route)
	if err != nil {
		return nil, err
	}
	if _, err := router.RegisterTrustedLeaf(link, route.Id); err != nil {
		return nil, err
	}
	return link, nil
}

func (l *Link) GetPeerInfo() string {
	return l.route.Id
}

func (l *Link) RecvRpcMessage() ([]byte, bool) {
	msg, ok := <-l.output
	return msg, ok
}

func (l *Link) SendRpcMessage(msg []byte, ingressLinkId baseds.LinkId, debugStr string) bool {
	var req wshutil.RpcMessage
	if err := json.Unmarshal(msg, &req); err != nil {
		return true
	}
	if req.Cancel && req.ReqId != "" {
		l.cancel(req.ReqId, ingressLinkId)
		return true
	}
	if req.Command == "" || (req.ReqId == "" && !l.route.RunUnanswered) {
		return true
	}
	// Not here: the router calls SendRpcMessage with its lock held, and reading the caller takes it.
	go l.answer(req, ingressLinkId)
	return true
}

func (l *Link) track(reqId string, call pendingCall) {
	l.lock.Lock()
	defer l.lock.Unlock()
	l.pending[reqId] = call
}

func (l *Link) untrack(reqId string) {
	l.lock.Lock()
	defer l.lock.Unlock()
	delete(l.pending, reqId)
}

// cancel: only the link a request came in on cancels it.
func (l *Link) cancel(reqId string, ingressLinkId baseds.LinkId) {
	l.lock.Lock()
	defer l.lock.Unlock()
	if call, ok := l.pending[reqId]; ok && call.ingressLinkId == ingressLinkId {
		call.cancel()
	}
}

func (l *Link) answer(req wshutil.RpcMessage, ingressLinkId baseds.LinkId) {
	defer func() {
		panichandler.PanicHandler(l.route.Id+":route", recover())
	}()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if req.ReqId != "" {
		l.track(req.ReqId, pendingCall{ingressLinkId: ingressLinkId, cancel: cancel})
		defer l.untrack(req.ReqId)
	}
	var data any
	var err error
	caller := Resolve(l.router, req.Source, ingressLinkId)
	allow := l.route.Policy.allowOf(req.Command)
	if !admits(allow, caller) {
		err = fmt.Errorf("%s %s %s", req.Command, RefusalMark, refusal(allow))
		if msg := l.route.Policy.Refusals[req.Command]; msg != "" {
			err = errors.New(msg)
		}
	} else {
		data, err = l.route.Handler(ctx, req.Command, caller, req.Data)
	}
	if req.ReqId == "" {
		return
	}
	resp := wshutil.RpcMessage{ResId: req.ReqId}
	if err != nil {
		resp.Error = err.Error()
		// Only the windows word a coded error themselves (#656): a terminal's `molten` and agents read the English.
		if caller.IsWindow {
			resp.Error = uimsg.Wire(err)
		}
	} else {
		resp.Data = data
	}
	out, err := json.Marshal(resp)
	if err != nil {
		return
	}
	l.output <- out
}
