// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package browsers

import (
	"context"
	"fmt"
	"log"

	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
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

// route: `molten open` and `molten browsers` also run on a remote host, the page opening on this computer
// (wshcmd-molten-open.go), so those two answer any caller. Bringing a tab forward and the per-site choices are a
// window's (#662).
func route(opener *Opener) localroute.Route {
	return localroute.Route{
		Id: RouteId,
		Policy: localroute.Policy{
			Default:  localroute.AllowWindow,
			Commands: map[string]string{ListCommand: localroute.AllowAny, OpenCommand: localroute.AllowAny},
			Refusals: map[string]string{SiteCommand: "per-site choices can only be changed from a MoltenTerm window or in settings.json"},
		},
		Handler: func(_ context.Context, command string, _ localroute.Caller, data any) (any, error) {
			return handle(opener, command, data)
		},
	}
}

func handle(opener *Opener, command string, data any) (any, error) {
	if command == ListCommand {
		return opener.List(), nil
	}
	if command == SiteCommand {
		var req SiteRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return opener.SetSite(req)
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
		return opener.Activate(req), nil
	}
	return opener.Open(req), nil
}

// StartRoute registers the opener on wavesrv's router; Mission Control's Start calls it once.
func StartRoute(settings func() Settings, saveSites func(sites map[string]string) error) {
	if _, err := localroute.Register(wshutil.DefaultRouter, route(MakeOpener(settings, saveSites))); err != nil {
		log.Printf("molten: browser route not started: %v\n", err)
	}
}
