// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wshutil

import "errors"

// ErrLinkEnded answers the requests still waiting when their client's server loop ends (#1926).
const ErrLinkEnded = "the link ended before the answer came"

// moltenFailPendingRpcs answers every request still waiting with ErrLinkEnded. A request's timeout is delivered by the
// server loop (retrySendTimeout): once the loop has ended nothing ever answered it, and its caller waited forever. The
// molten MCP server's link wedged that way under its lock, and list_agents and send_to_agent hung for 30 minutes.
func (w *WshRpc) moltenFailPendingRpcs() {
	for _, reqId := range w.moltenPendingRpcIds() {
		w.unregisterRpc(reqId, errors.New(ErrLinkEnded))
	}
}

func (w *WshRpc) moltenPendingRpcIds() []string {
	w.Lock.Lock()
	defer w.Lock.Unlock()
	ids := make([]string, 0, len(w.RpcMap))
	for reqId := range w.RpcMap {
		ids = append(ids, reqId)
	}
	return ids
}
