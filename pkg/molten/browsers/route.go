// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package browsers

import (
	"encoding/json"
	"fmt"
	"log"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// The browser panels and `molten open` reach the opener through a leaf of wavesrv's router answering plain command
// names, like Mission Control (pkg/molten/mission/route.go): nothing is declared in pkg/wshrpc. Terminals may call
// it too: agents open pages with `molten open`, which the per-site choices route (FR-BRW-002).

// must match the names in frontend/moltenterm-shell/browser/browser-engine.ts and cmd/wsh/cmd/wshcmd-molten-open.go
const (
	RouteId         = "molten:browser"
	ListCommand     = "moltenbrowserlist"
	OpenCommand     = "moltenbrowseropen"
	ActivateCommand = "moltenbrowseractivate"
	SiteCommand     = "moltenbrowsersite"
)

const routeQueueSize = 32

type routeLink struct {
	opener *Opener
	output chan []byte
}

func (l *routeLink) GetPeerInfo() string {
	return RouteId
}

func (l *routeLink) RecvRpcMessage() ([]byte, bool) {
	msg, ok := <-l.output
	return msg, ok
}

func (l *routeLink) SendRpcMessage(msg []byte, ingressLinkId baseds.LinkId, debugStr string) bool {
	var req wshutil.RpcMessage
	if err := json.Unmarshal(msg, &req); err != nil {
		return true
	}
	if req.Command == "" || req.ReqId == "" {
		return true
	}
	go l.answer(req)
	return true
}

func (l *routeLink) answer(req wshutil.RpcMessage) {
	defer func() {
		panichandler.PanicHandler("molten:browser:route", recover())
	}()
	resp := wshutil.RpcMessage{ResId: req.ReqId}
	data, err := l.handle(req.Command, req.Source, req.Data)
	if err != nil {
		resp.Error = err.Error()
	} else {
		resp.Data = data
	}
	out, err := json.Marshal(resp)
	if err != nil {
		return
	}
	l.output <- out
}

func (l *routeLink) handle(command string, source string, data any) (any, error) {
	if command == ListCommand {
		return l.opener.List(), nil
	}
	if command == SiteCommand {
		// The router stamps the source of every link with a route of its own: a terminal cannot pass for a window.
		if !strings.HasPrefix(source, wshutil.RoutePrefix_Tab) {
			return nil, fmt.Errorf("per-site choices can only be changed from a MoltenTerm window or in settings.json")
		}
		var req SiteRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.opener.SetSite(req)
	}
	if command != OpenCommand && command != ActivateCommand {
		return nil, fmt.Errorf("unknown browser command %q", command)
	}
	var req OpenRequest
	if err := utilfn.ReUnmarshal(&req, data); err != nil {
		return nil, err
	}
	if req.Url == "" && command == OpenCommand {
		return nil, fmt.Errorf("no page to open")
	}
	if command == ActivateCommand {
		return l.opener.Activate(req), nil
	}
	return l.opener.Open(req), nil
}

// StartRoute registers the opener on wavesrv's router; Mission Control's Start calls it once.
func StartRoute(settings func() Settings, saveSites func(sites map[string]string) error) {
	link := &routeLink{opener: MakeOpener(settings, saveSites), output: make(chan []byte, routeQueueSize)}
	if _, err := wshutil.DefaultRouter.RegisterTrustedLeaf(link, RouteId); err != nil {
		log.Printf("molten: browser route not started: %v\n", err)
	}
}
