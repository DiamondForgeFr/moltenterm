// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package localroute

import (
	"strings"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/remote/conncontroller"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wslconn"
)

// OnLink accepts local terminals only through their own leaf link. A remote terminal's proc: route is announced on
// a trusted router link too, even while its connection is absent from the SSH/WSL status inventory (#374).
// Window routes live on their websocket's router link; checking the source takes the router's lock, so call this
// after SendRpcMessage has returned.
func OnLink(router *wshutil.WshRouter, source string, ingressLinkId baseds.LinkId) bool {
	if router == nil || source == "" || ingressLinkId == baseds.NoLinkId {
		return false
	}
	if strings.HasPrefix(source, wshutil.RoutePrefix_Proc) {
		return router.IsLeafSource(ingressLinkId, source)
	}
	if !strings.HasPrefix(source, wshutil.RoutePrefix_Tab) || !router.IsSourceOnLink(ingressLinkId, source) {
		return false
	}
	for _, st := range append(conncontroller.GetAllConnStatus(), wslconn.GetAllConnStatus()...) {
		if st.Connection != "" && router.GetLinkIdForRoute(wshutil.MakeConnectionRouteId(st.Connection)) == ingressLinkId {
			return false
		}
	}
	return true
}
