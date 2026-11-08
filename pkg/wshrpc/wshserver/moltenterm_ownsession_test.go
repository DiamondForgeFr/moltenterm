// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wshserver

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// An agent cannot pass for Brokk's session (#2067): `wsh setmeta molten:brokk=true` on its own terminal and a sub-block
// made with the marker are refused, and nothing is written; wavesrv, which makes his session, still sets it.
func TestTerminalCannotClaimBrokksSession(t *testing.T) {
	e := termOutputFixture(t)
	own := waveobj.MakeORef(waveobj.OType_Block, e.ownBlock)
	marker := waveobj.MetaMapType{molten.OwnSessionMetaKey: true}

	mustRefuseTermOutput(t, "setmeta molten:brokk on its own block", WshServerImpl.SetMetaCommand(e.ctx, wshrpc.CommandSetMetaData{ORef: own, Meta: marker}))
	mustRefuseTermOutput(t, "setmeta browser tabs on its own block", WshServerImpl.SetMetaCommand(e.ctx, wshrpc.CommandSetMetaData{ORef: own, Meta: waveobj.MetaMapType{
		waveobj.MetaKey_View:      molten.BrowserView,
		molten.BrowserTabsMetaKey: []any{map[string]any{"id": "t1", "url": "file:///tmp/x.html", "allowed": true}},
	}}))
	_, err := WshServerImpl.CreateSubBlockCommand(e.ctx, wshrpc.CommandCreateSubBlockData{ParentBlockId: e.ownBlock, BlockDef: &waveobj.BlockDef{
		Meta: waveobj.MetaMapType{waveobj.MetaKey_View: "term", molten.OwnSessionMetaKey: true},
	}})
	mustRefuseTermOutput(t, "createsubblock with molten:brokk", err)
	_, err = WshServerImpl.CreateSubBlockCommand(e.ctx, wshrpc.CommandCreateSubBlockData{ParentBlockId: e.otherBlock, BlockDef: &waveobj.BlockDef{
		Meta: waveobj.MetaMapType{waveobj.MetaKey_View: "term"},
	}})
	mustRefuseTermOutput(t, "createsubblock in another workspace", err)

	blocks, err := wstore.DBGetAllObjsByType[*waveobj.Block](context.Background(), waveobj.OType_Block)
	if err != nil {
		t.Fatal(err)
	}
	for _, block := range blocks {
		if molten.IsOwnSession(block.Meta) {
			t.Fatalf("block %s carries Brokk's marker after the refusals", block.OID)
		}
	}

	mustAllowTermOutput(t, "setmeta molten worktree on its own block", WshServerImpl.SetMetaCommand(e.ctx, wshrpc.CommandSetMetaData{ORef: own, Meta: waveobj.MetaMapType{molten.WorktreeMetaKey: "/w"}}))
	if err := WshServerImpl.SetMetaCommand(context.Background(), wshrpc.CommandSetMetaData{ORef: own, Meta: marker}); err != nil {
		t.Fatalf("wavesrv was refused Brokk's marker: %v", err)
	}
	block, err := wstore.DBMustGet[*waveobj.Block](context.Background(), e.ownBlock)
	if err != nil || !molten.IsOwnSession(block.Meta) {
		t.Fatalf("wavesrv's marker was not written: %v %v", block, err)
	}
}
