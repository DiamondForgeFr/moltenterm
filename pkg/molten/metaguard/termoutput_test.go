// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package metaguard_test

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
	"github.com/wavetermdev/waveterm/pkg/molten/metaguard"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

const (
	siblingBlock = "block-sibling"
	otherBlock   = "block-other"
)

func ownWorkspaceBlock(blockId string) bool {
	return blockId == routetest.TerminalBlock || blockId == siblingBlock
}

func ownWorkspaceORef(oref waveobj.ORef) bool {
	return oref.OType == waveobj.OType_Block && ownWorkspaceBlock(oref.OID)
}

func TestTermOutputRead(t *testing.T) {
	trusted := metaguard.Caller{Trusted: true}
	for _, blockId := range []string{routetest.TerminalBlock, siblingBlock, otherBlock} {
		if err := metaguard.CheckTermOutputRead(trusted, blockId, false); err != nil {
			t.Errorf("window reads %s: %v", blockId, err)
		}
	}
	term := terminal()
	if err := metaguard.CheckTermOutputRead(term, routetest.TerminalBlock, false); err != nil {
		t.Errorf("own block: %v", err)
	}
	if err := metaguard.CheckTermOutputRead(term, siblingBlock, true); err != nil {
		t.Errorf("sibling pane: %v", err)
	}
	mustRefuse(t, "other workspace's block", metaguard.CheckTermOutputRead(term, otherBlock, false))
	mustRefuse(t, "no block", metaguard.CheckTermOutputRead(term, "", true))
	mustRefuse(t, "terminal without a workspace", metaguard.CheckTermOutputRead(metaguard.Caller{Local: true, BlockId: routetest.TerminalBlock}, siblingBlock, true))
	mustRefuse(t, "terminal without a block", metaguard.CheckTermOutputRead(metaguard.Caller{Local: true}, siblingBlock, true))
	for _, blockId := range []string{routetest.TerminalBlock, siblingBlock, otherBlock} {
		if err := metaguard.CheckTermOutputRead(remoteHost, blockId, false); err != nil {
			t.Errorf("a remote host's read of %s changed (#1831's scope): %v", blockId, err)
		}
	}
}

// remoteHost is an SSH or WSL host: these rules leave it as Wave has it, the remote-host guard (#1831) owns it.
var remoteHost = metaguard.Caller{}

const (
	ownTab   = "tab-own"
	otherTab = "tab-other"
)

func ownWorkspaceObj(oref waveobj.ORef) bool {
	return ownWorkspaceORef(oref) || (oref.OType == waveobj.OType_Tab && oref.OID == ownTab)
}

func TestForwardedScrollback(t *testing.T) {
	const scrollback = "termgetscrollbacklines"
	term := terminal()
	for _, blockId := range []string{routetest.TerminalBlock, siblingBlock} {
		if err := metaguard.CheckForwardedRequest(term, scrollback, "feblock:"+blockId, "", ownWorkspaceObj); err != nil {
			t.Errorf("panel %s: %v", blockId, err)
		}
	}
	mustRefuse(t, "other workspace's panel", metaguard.CheckForwardedRequest(term, scrollback, "feblock:"+otherBlock, "", ownWorkspaceObj))
	for _, route := range []string{"", "feblock:", "tab:" + ownTab, "link:3", "wavesrv"} {
		mustRefuse(t, "route "+route, metaguard.CheckForwardedRequest(term, scrollback, route, "", ownWorkspaceObj))
	}
	if err := metaguard.CheckForwardedRequest(remoteHost, scrollback, "feblock:"+otherBlock, "", ownWorkspaceObj); err != nil {
		t.Errorf("a remote host's scrollback changed (#1831's scope): %v", err)
	}
	if err := metaguard.CheckForwardedRequest(metaguard.Caller{Trusted: true}, scrollback, "feblock:"+otherBlock, "", ownWorkspaceObj); err != nil {
		t.Errorf("window: %v", err)
	}
	if err := metaguard.CheckForwardedRequest(metaguard.Caller{}, "vdomcreatecontext", "feblock:"+otherBlock, "", ownWorkspaceObj); err != nil {
		t.Errorf("a request that reads no output: %v", err)
	}
}

// A block's screenshot and the AI panel's context go to a window's tab: a terminal reaches its own workspace's tabs
// and blocks only; a remote host is unchanged.
func TestForwardedTabRequests(t *testing.T) {
	term := terminal()
	for _, command := range []string{"captureblockscreenshot", "waveaiaddcontext"} {
		if err := metaguard.CheckForwardedRequest(term, command, "tab:"+ownTab, siblingBlock, ownWorkspaceObj); err != nil {
			t.Errorf("%s in its own tab: %v", command, err)
		}
		mustRefuse(t, command+" to another workspace's tab", metaguard.CheckForwardedRequest(term, command, "tab:"+otherTab, "", ownWorkspaceObj))
		mustRefuse(t, command+" to a panel route", metaguard.CheckForwardedRequest(term, command, "feblock:"+siblingBlock, "", ownWorkspaceObj))
		if err := metaguard.CheckForwardedRequest(remoteHost, command, "tab:"+otherTab, otherBlock, ownWorkspaceObj); err != nil {
			t.Errorf("%s from a remote host changed (#1831's scope): %v", command, err)
		}
		mustRefuse(t, command+" from a terminal without a workspace", metaguard.CheckForwardedRequest(metaguard.Caller{Local: true, BlockId: routetest.TerminalBlock}, command, "tab:"+ownTab, "", ownWorkspaceObj))
		if err := metaguard.CheckForwardedRequest(metaguard.Caller{Trusted: true}, command, "tab:"+otherTab, otherBlock, ownWorkspaceObj); err != nil {
			t.Errorf("%s from the window: %v", command, err)
		}
	}
	mustRefuse(t, "screenshot of another workspace's block", metaguard.CheckForwardedRequest(term, "captureblockscreenshot", "tab:"+ownTab, otherBlock, ownWorkspaceObj))
}

func TestBlockFileSubscribe(t *testing.T) {
	sub := func(scopes ...string) wps.SubscriptionRequest {
		return wps.SubscriptionRequest{Event: wps.Event_BlockFile, Scopes: scopes}
	}
	own := waveobj.MakeORef(waveobj.OType_Block, routetest.TerminalBlock).String()
	sibling := waveobj.MakeORef(waveobj.OType_Block, siblingBlock).String()
	other := waveobj.MakeORef(waveobj.OType_Block, otherBlock).String()
	term := terminal()
	if err := metaguard.CheckBlockFileSubscribe(term, sub(own, sibling), ownWorkspaceORef); err != nil {
		t.Errorf("own and sibling blocks: %v", err)
	}
	refused := map[string]wps.SubscriptionRequest{
		"other workspace's block": sub(own, other),
		"all scopes":              {Event: wps.Event_BlockFile, AllScopes: true},
		"no scope":                sub(),
		"wildcard":                sub("block:*"),
		"tab scope":               sub("tab:" + siblingBlock),
		"bare block":              sub("block:"),
	}
	for name, req := range refused {
		mustRefuse(t, name, metaguard.CheckBlockFileSubscribe(term, req, ownWorkspaceORef))
	}
	if err := metaguard.CheckBlockFileSubscribe(remoteHost, sub(other), ownWorkspaceORef); err != nil {
		t.Errorf("a remote host's subscription changed (#1831's scope): %v", err)
	}
	if err := metaguard.CheckBlockFileSubscribe(metaguard.Caller{Trusted: true}, wps.SubscriptionRequest{Event: wps.Event_BlockFile, AllScopes: true}, ownWorkspaceORef); err != nil {
		t.Errorf("window: %v", err)
	}
	if err := metaguard.CheckBlockFileSubscribe(term, wps.SubscriptionRequest{Event: wps.Event_Badge, AllScopes: true}, ownWorkspaceORef); err != nil {
		t.Errorf("other events: %v", err)
	}
}
