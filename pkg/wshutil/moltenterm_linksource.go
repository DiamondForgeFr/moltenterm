// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wshutil

import "github.com/wavetermdev/waveterm/pkg/baseds"

// IsLeafSource tells whether a request came in through the leaf link whose own route is its source: a client
// connected to this router itself (a local terminal's wsh), not one forwarded by a router link. A remote connection's
// wsh also carries a "proc:" source, but reaches wavesrv through its connection's router link (#368).
func (router *WshRouter) IsLeafSource(ingressLinkId baseds.LinkId, source string) bool {
	lm := router.getLinkMeta(ingressLinkId)
	return lm != nil && lm.trusted && lm.linkKind == LinkKind_Leaf && source != "" && lm.sourceRouteId == source
}

// IsSourceOnLink tells whether a request's source is a route bound to the trusted link it came in through: a window's
// tab route and Electron main's route live on their websocket's router link, so a message naming them that arrives
// through another link (a terminal, a remote connection) is not theirs (#276). Takes the router's lock: never call it
// from SendRpcMessage, which the router calls under that lock.
func (router *WshRouter) IsSourceOnLink(ingressLinkId baseds.LinkId, source string) bool {
	if source == "" || ingressLinkId == baseds.NoLinkId {
		return false
	}
	router.lock.Lock()
	defer router.lock.Unlock()
	lm := router.linkMap[ingressLinkId]
	return lm != nil && lm.trusted && router.routeMap[source] == ingressLinkId
}
