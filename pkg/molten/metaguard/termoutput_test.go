// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

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
	for _, blockId := range []string{routetest.TerminalBlock, siblingBlock} {
		mustRefuse(t, "remote host reads "+blockId, metaguard.CheckTermOutputRead(metaguard.Caller{BlockId: blockId, WorkspaceId: ownWs}, blockId, true))
	}
}

func TestForwardedRead(t *testing.T) {
	const scrollback = "termgetscrollbacklines"
	term := terminal()
	if err := metaguard.CheckForwardedRead(term, scrollback, "feblock:"+routetest.TerminalBlock, ownWorkspaceBlock); err != nil {
		t.Errorf("own block: %v", err)
	}
	if err := metaguard.CheckForwardedRead(term, scrollback, "feblock:"+siblingBlock, ownWorkspaceBlock); err != nil {
		t.Errorf("sibling pane: %v", err)
	}
	mustRefuse(t, "other workspace's panel", metaguard.CheckForwardedRead(term, scrollback, "feblock:"+otherBlock, ownWorkspaceBlock))
	for _, route := range []string{"", "feblock:", "tab:window", "link:3", "wavesrv"} {
		mustRefuse(t, "route "+route, metaguard.CheckForwardedRead(term, scrollback, route, ownWorkspaceBlock))
	}
	mustRefuse(t, "remote host", metaguard.CheckForwardedRead(metaguard.Caller{}, scrollback, "feblock:"+siblingBlock, ownWorkspaceBlock))
	if err := metaguard.CheckForwardedRead(metaguard.Caller{Trusted: true}, scrollback, "feblock:"+otherBlock, ownWorkspaceBlock); err != nil {
		t.Errorf("window: %v", err)
	}
	if err := metaguard.CheckForwardedRead(metaguard.Caller{}, "vdomcreatecontext", "feblock:"+otherBlock, ownWorkspaceBlock); err != nil {
		t.Errorf("a request that reads no output: %v", err)
	}
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
	mustRefuse(t, "remote host", metaguard.CheckBlockFileSubscribe(metaguard.Caller{}, sub(sibling), ownWorkspaceORef))
	if err := metaguard.CheckBlockFileSubscribe(metaguard.Caller{Trusted: true}, wps.SubscriptionRequest{Event: wps.Event_BlockFile, AllScopes: true}, ownWorkspaceORef); err != nil {
		t.Errorf("window: %v", err)
	}
	if err := metaguard.CheckBlockFileSubscribe(term, wps.SubscriptionRequest{Event: wps.Event_Badge, AllScopes: true}, ownWorkspaceORef); err != nil {
		t.Errorf("other events: %v", err)
	}
}
