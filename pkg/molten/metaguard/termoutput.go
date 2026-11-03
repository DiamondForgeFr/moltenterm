// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package metaguard

import (
	"fmt"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

// feBlockRoutePrefix is wshutil.RoutePrefix_FeBlock, the route of a panel's frontend client.
const feBlockRoutePrefix = "feblock:"

// TermOutputCommands are the requests a panel's frontend client answers with a terminal's output (#1832): wavesrv
// forwards them to the window, which answers whoever asks, so the router checks them before forwarding.
var TermOutputCommands = map[string]bool{
	"termgetscrollbacklines": true,
}

// CheckTermOutputRead tells whether c may read the output of blockId (its terminal file, its scrollback, its live
// output): a terminal reads its own block and its own workspace's other blocks, whose panes agents read (their
// companion, a sibling shell); an SSH or WSL host, whose workspace is unknown, reads none (NFR-FORK-001, #1832).
func CheckTermOutputRead(c Caller, blockId string, inOwnWorkspace bool) error {
	if c.Trusted {
		return nil
	}
	if !c.Local {
		return fmt.Errorf("refused: a terminal cannot read a terminal's output from an SSH or WSL host (block %s); the MoltenTerm window does", blockId)
	}
	if blockId != "" && blockId == c.BlockId {
		return nil
	}
	if blockId != "" && c.WorkspaceId != "" && inOwnWorkspace {
		return nil
	}
	return fmt.Errorf("refused: a terminal cannot read the output of block %s, outside its own workspace; the MoltenTerm window does", blockId)
}

// CheckForwardedRead tells whether c may have wavesrv forward command to route. Only TermOutputCommands are checked,
// and they go only to a panel's frontend route ("feblock:<block>") whose block c may read (CheckTermOutputRead).
func CheckForwardedRead(c Caller, command string, route string, inOwnWorkspace func(blockId string) bool) error {
	if c.Trusted || !TermOutputCommands[command] {
		return nil
	}
	blockId, ok := strings.CutPrefix(route, feBlockRoutePrefix)
	if !ok || blockId == "" {
		return fmt.Errorf("refused: a terminal cannot send %s to %q, only to a terminal panel of its own workspace; the MoltenTerm window does", command, route)
	}
	return CheckTermOutputRead(c, blockId, c.Local && inOwnWorkspace(blockId))
}

// CheckBlockFileSubscribe tells whether c may follow a blockfile event (a terminal's live output) or read its history:
// every scope names a block c may read (CheckTermOutputRead); no wildcard, no all-scopes. Other events are unchanged.
func CheckBlockFileSubscribe(c Caller, req wps.SubscriptionRequest, inOwnWorkspace func(waveobj.ORef) bool) error {
	if c.Trusted || req.Event != wps.Event_BlockFile {
		return nil
	}
	if req.AllScopes || len(req.Scopes) == 0 {
		return fmt.Errorf("refused: a terminal cannot follow every terminal's output; it follows only its own workspace's blocks; the MoltenTerm window does")
	}
	for _, scope := range req.Scopes {
		otype, oid, _ := strings.Cut(scope, ":")
		if otype != waveobj.OType_Block || oid == "" || strings.ContainsAny(scope, "*?") {
			return fmt.Errorf("refused: a terminal cannot follow the output of %q; it follows only its own workspace's blocks; the MoltenTerm window does", scope)
		}
		oref := waveobj.MakeORef(otype, oid)
		if err := CheckTermOutputRead(c, oid, c.Local && inOwnWorkspace(oref)); err != nil {
			return err
		}
	}
	return nil
}
