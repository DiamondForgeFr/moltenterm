// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package metaguard

import (
	"fmt"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

// feBlockRoutePrefix is wshutil.RoutePrefix_FeBlock, the route of a panel's frontend client; tabRoutePrefix is
// wshutil.RoutePrefix_Tab, a window's tab.
const (
	feBlockRoutePrefix = "feblock:"
	tabRoutePrefix     = "tab:"
)

// ForwardedCommands are the requests the window answers for whoever asks, which the router checks before it forwards
// them (#1832): a terminal's scrollback (to the panel's "feblock:<block>" route), a block's screenshot and the AI
// panel's context (to the window's "tab:<tab>" route), which show and act on what the panes hold.
var ForwardedCommands = map[string]string{
	"termgetscrollbacklines": feBlockRoutePrefix,
	"captureblockscreenshot": tabRoutePrefix,
	"waveaiaddcontext":       tabRoutePrefix,
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

// CheckForwardedRequest tells whether c may have wavesrv forward command to route. Only ForwardedCommands are
// checked: each goes only to the route kind it names, of c's own workspace (a panel c may read, CheckTermOutputRead,
// or a tab), and blockId, the block a screenshot names, is in c's own workspace too. A remote host sends none.
func CheckForwardedRequest(c Caller, command string, route string, blockId string, inOwnWorkspace func(waveobj.ORef) bool) error {
	prefix, checked := ForwardedCommands[command]
	if c.Trusted || !checked {
		return nil
	}
	id, ok := strings.CutPrefix(route, prefix)
	if !ok || id == "" {
		return fmt.Errorf("refused: a terminal cannot send %s to %q, only to a panel or a tab of its own workspace; the MoltenTerm window does", command, route)
	}
	if prefix == feBlockRoutePrefix {
		return CheckTermOutputRead(c, id, c.Local && inOwnWorkspace(waveobj.MakeORef(waveobj.OType_Block, id)))
	}
	if !c.Local {
		return fmt.Errorf("refused: a terminal cannot send %s to a tab from an SSH or WSL host; the MoltenTerm window does", command)
	}
	if c.WorkspaceId == "" || !inOwnWorkspace(waveobj.MakeORef(waveobj.OType_Tab, id)) {
		return fmt.Errorf("refused: a terminal cannot send %s to tab %s, outside its own workspace; the MoltenTerm window does", command, id)
	}
	if blockId != "" {
		return CheckTermOutputRead(c, blockId, inOwnWorkspace(waveobj.MakeORef(waveobj.OType_Block, blockId)))
	}
	return nil
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
