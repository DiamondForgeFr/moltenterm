// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wshutil

import (
	"log"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// bindAnnounceInOrder binds or unbinds a route announced without a request id (a window's tab and block routes) in the
// order the link sent it, before the router reads the link's next message (#1950). The control route answers each
// request in its own goroutine, so a window that reconnects and sends its route announce and then its event
// subscriptions saw the subscriptions checked first: its tab route was not bound to the new websocket yet, the caller
// was not a window, MoltenTerm's events were refused, and nothing told the window, which never followed agent states
// again. Returns whether msg was handled.
func (router *WshRouter) bindAnnounceInOrder(msg RpcMessage, ingressLinkId baseds.LinkId) bool {
	if msg.ReqId != "" || msg.Route != ControlRoute || msg.Source == "" {
		return false
	}
	var err error
	switch msg.Command {
	case wshrpc.Command_RouteAnnounce:
		err = router.bindRoute(ingressLinkId, msg.Source, false)
	case wshrpc.Command_RouteUnannounce:
		err = router.unbindRoute(ingressLinkId, msg.Source)
	default:
		return false
	}
	if err != nil {
		log.Printf("wshrouter %s %q from link %d: %v", msg.Command, msg.Source, ingressLinkId, err)
	}
	return true
}
