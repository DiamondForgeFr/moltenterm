// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wshutil

import "github.com/wavetermdev/waveterm/pkg/baseds"

// IsLeafSource tells whether a request came in through the leaf link whose own route is its source: a client
// connected to this router itself (a local terminal's wsh), not one forwarded by a router link. A remote connection's
// wsh also carries a "proc:" source, but reaches wavesrv through its connection's router link (#368).
func (router *WshRouter) IsLeafSource(ingressLinkId baseds.LinkId, source string) bool {
	_, ok := router.LeafSourceBlockId(ingressLinkId, source)
	return ok
}

// LeafSourceBlockId is IsLeafSource that also returns the block the leaf authenticated for: the block id its token
// was issued to, or "" when the leaf has none (#662).
func (router *WshRouter) LeafSourceBlockId(ingressLinkId baseds.LinkId, source string) (string, bool) {
	lm := router.getLinkMeta(ingressLinkId)
	if lm == nil || !lm.trusted || lm.linkKind != LinkKind_Leaf || source == "" || lm.sourceRouteId != source {
		return "", false
	}
	return lm.blockId, true
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

// IsWindowSource is IsSourceOnLink restricted to the windows' websocket (RegisterWindowRouter). A remote connection is
// a trusted router link too, and binds whatever routes it announces, "tab:" ones included: only the websocket tells a
// window apart, whether or not the connection is in the SSH/WSL status inventory (#662).
func (router *WshRouter) IsWindowSource(ingressLinkId baseds.LinkId, source string) bool {
	if source == "" || ingressLinkId == baseds.NoLinkId {
		return false
	}
	router.lock.Lock()
	defer router.lock.Unlock()
	lm := router.linkMap[ingressLinkId]
	return lm != nil && lm.trusted && lm.isWindow && lm.linkKind == LinkKind_Router && router.routeMap[source] == ingressLinkId
}

// RegisterWindowRouter registers the websocket of MoltenTerm's windows and Electron main (pkg/web/ws.go): a trusted
// router link whose routes are window sources. The mark is set before the link is trusted, so no request is ever
// answered from it unmarked.
func (router *WshRouter) RegisterWindowRouter(rpc AbstractRpcClient) baseds.LinkId {
	linkId := router.RegisterUntrustedLink(rpc)
	router.markWindowLink(linkId)
	router.trustLink(linkId, LinkKind_Router)
	return linkId
}

// RegisterTerminalLeaf registers a trusted leaf for a terminal's block, as authenticating with the block's token does.
func (router *WshRouter) RegisterTerminalLeaf(rpc AbstractRpcClient, routeId string, blockId string) (baseds.LinkId, error) {
	linkId, err := router.RegisterTrustedLeaf(rpc, routeId)
	if err != nil {
		return linkId, err
	}
	router.setLinkBlockId(linkId, blockId)
	return linkId, nil
}

func (router *WshRouter) markWindowLink(linkId baseds.LinkId) {
	router.lock.Lock()
	defer router.lock.Unlock()
	if lm := router.linkMap[linkId]; lm != nil {
		lm.isWindow = true
	}
}

func (router *WshRouter) setLinkBlockId(linkId baseds.LinkId, blockId string) {
	router.lock.Lock()
	defer router.lock.Unlock()
	if lm := router.linkMap[linkId]; lm != nil && lm.linkKind == LinkKind_Leaf {
		lm.blockId = blockId
	}
}
