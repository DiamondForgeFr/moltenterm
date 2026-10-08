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
