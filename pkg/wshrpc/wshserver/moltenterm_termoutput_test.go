// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wshserver

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/filestore"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const termOwnSource = "proc:termoutput-own"

type termOutputPeer struct {
	in chan []byte
}

func (p *termOutputPeer) GetPeerInfo() string { return "termoutput" }
func (p *termOutputPeer) RecvRpcMessage() ([]byte, bool) {
	msg, ok := <-p.in
	return msg, ok
}
func (p *termOutputPeer) SendRpcMessage(_ []byte, _ baseds.LinkId, _ string) bool { return true }

// termOutputEnv: two workspaces, a terminal (ownBlock) and a sibling pane in the first, a block in the second, each
// with terminal output, and a durable session attached to the sibling and to the other block. ctx is a request from
// the terminal's wsh, on its own leaf (link) of the root router. Ids are fresh per test: the file store's cache
// outlives a test's database.
type termOutputEnv struct {
	ctx          context.Context
	link         baseds.LinkId
	ownWs        string
	otherWs      string
	ownTab       string
	otherTab     string
	ownBlock     string
	siblingBlock string
	otherBlock   string
	siblingJob   string
	otherJob     string
}

func termOutputFixture(t *testing.T) *termOutputEnv {
	t.Helper()
	dataDir := t.TempDir()
	saved := wavebase.DataHome_VarCache
	wavebase.DataHome_VarCache = dataDir
	t.Cleanup(func() { wavebase.DataHome_VarCache = saved })
	if err := os.MkdirAll(filepath.Join(dataDir, wavebase.WaveDBDir), 0700); err != nil {
		t.Fatal(err)
	}
	if err := wstore.InitWStore(); err != nil {
		t.Fatal(err)
	}
	if err := filestore.InitFilestore(); err != nil {
		t.Fatal(err)
	}
	e := &termOutputEnv{ownWs: uuid.NewString(), otherWs: uuid.NewString(), otherTab: uuid.NewString(), ownBlock: uuid.NewString(),
		siblingBlock: uuid.NewString(), otherBlock: uuid.NewString(), siblingJob: uuid.NewString(), otherJob: uuid.NewString()}
	ownTab := uuid.NewString()
	e.ownTab = ownTab
	ctx := context.Background()
	objs := []waveobj.WaveObj{
		&waveobj.Workspace{OID: e.ownWs, TabIds: []string{ownTab}},
		&waveobj.Workspace{OID: e.otherWs, TabIds: []string{e.otherTab}},
		&waveobj.Tab{OID: ownTab, BlockIds: []string{e.ownBlock, e.siblingBlock}},
		&waveobj.Tab{OID: e.otherTab, BlockIds: []string{e.otherBlock}},
		&waveobj.Block{OID: e.ownBlock, ParentORef: "tab:" + ownTab, Meta: waveobj.MetaMapType{waveobj.MetaKey_View: "term"}},
		&waveobj.Block{OID: e.siblingBlock, ParentORef: "tab:" + ownTab, Meta: waveobj.MetaMapType{waveobj.MetaKey_View: "term"}},
		&waveobj.Block{OID: e.otherBlock, ParentORef: "tab:" + e.otherTab, Meta: waveobj.MetaMapType{waveobj.MetaKey_View: "term"}},
		&waveobj.Job{OID: e.siblingJob, AttachedBlockId: e.siblingBlock},
		&waveobj.Job{OID: e.otherJob, AttachedBlockId: e.otherBlock},
	}
	for _, obj := range objs {
		if err := wstore.DBInsert(ctx, obj); err != nil {
			t.Fatal(err)
		}
	}
	for _, zone := range []string{e.ownBlock, e.siblingBlock, e.otherBlock, e.siblingJob, e.otherJob} {
		if err := filestore.WFS.MakeFile(ctx, zone, wavebase.BlockFile_Term, nil, wshrpc.FileOpts{}); err != nil {
			t.Fatal(err)
		}
		if err := filestore.WFS.AppendData(ctx, zone, wavebase.BlockFile_Term, []byte("output of "+zone)); err != nil {
			t.Fatal(err)
		}
	}
	savedRouter := wshutil.DefaultRouter
	router := wshutil.NewWshRouter()
	router.SetAsRootRouter()
	wshutil.DefaultRouter = router
	t.Cleanup(func() { wshutil.DefaultRouter = savedRouter })
	peer := &termOutputPeer{in: make(chan []byte)}
	t.Cleanup(func() { close(peer.in) })
	link, err := router.RegisterTerminalLeaf(peer, termOwnSource, e.ownBlock)
	if err != nil {
		t.Fatal(err)
	}
	e.link = link
	e.ctx = wshutil.WithCallerContext(ctx, termOwnSource, link)
	return e
}

func mustRefuseTermOutput(t *testing.T, name string, err error) {
	t.Helper()
	if err == nil || !strings.HasPrefix(err.Error(), "refused: a terminal cannot") {
		t.Errorf("%s: %v, want a refusal", name, err)
	}
}

func mustAllowTermOutput(t *testing.T, name string, err error) {
	t.Helper()
	if err != nil && strings.HasPrefix(err.Error(), "refused") {
		t.Errorf("%s: refused: %v", name, err)
	}
}

// `wsh debugterm -b`: a terminal reads its own block and its workspace's panes, not another workspace's (#1832).
func TestDebugTermReadsOnlyOwnWorkspace(t *testing.T) {
	e := termOutputFixture(t)
	read := func(ctx context.Context, blockId string) (string, error) {
		rtn, err := WshServerImpl.DebugTermCommand(ctx, wshrpc.CommandDebugTermData{BlockId: blockId, Size: 1024})
		if err != nil {
			return "", err
		}
		data, _ := base64.StdEncoding.DecodeString(rtn.Data64)
		return string(data), nil
	}
	for _, blockId := range []string{e.ownBlock, e.siblingBlock} {
		if got, err := read(e.ctx, blockId); err != nil || got != "output of "+blockId {
			t.Errorf("terminal reads %s: %q, %v", blockId, got, err)
		}
	}
	got, err := read(e.ctx, e.otherBlock)
	mustRefuseTermOutput(t, "another workspace's block", err)
	if got != "" {
		t.Errorf("another workspace's output leaked: %q", got)
	}
	_, err = read(e.ctx, uuid.NewString())
	mustRefuseTermOutput(t, "an unknown block", err)
	if got, err := read(context.Background(), e.otherBlock); err != nil || got != "output of "+e.otherBlock {
		t.Errorf("wavesrv reads another workspace's block: %q, %v", got, err)
	}
	remote := wshutil.DefaultRouter.RegisterTrustedRouter(&termOutputPeer{in: make(chan []byte)})
	remoteCtx := wshutil.WithCallerContext(context.Background(), "proc:remote", remote)
	if got, err := read(remoteCtx, e.otherBlock); err != nil || got != "output of "+e.otherBlock {
		t.Errorf("a remote host's read changed (#1831's scope): %q, %v", got, err)
	}
}

// `wsh readfile` / `wsh jobdebug`: the wave file streams of a block or a durable session follow the same rule.
func TestWaveFileReadStreamReadsOnlyOwnWorkspace(t *testing.T) {
	e := termOutputFixture(t)
	stream := func(ctx context.Context, zoneId string) error {
		_, err := WshServerImpl.WaveFileReadStreamCommand(ctx, wshrpc.CommandWaveFileReadStreamData{ZoneId: zoneId, Name: wavebase.BlockFile_Term})
		return err
	}
	for _, zone := range []string{e.ownBlock, e.siblingBlock, e.siblingJob} {
		mustAllowTermOutput(t, "zone "+zone, stream(e.ctx, zone))
	}
	for _, zone := range []string{e.otherBlock, e.otherJob, e.otherWs, uuid.NewString()} {
		mustRefuseTermOutput(t, "zone "+zone, stream(e.ctx, zone))
	}
	mustAllowTermOutput(t, "wavesrv", stream(context.Background(), e.otherBlock))
}

// blockfile events carry a terminal's live output: a terminal follows its own workspace's blocks only.
func TestBlockFileEventsOnlyOwnWorkspace(t *testing.T) {
	e := termOutputFixture(t)
	t.Cleanup(func() { wps.Broker.UnsubscribeAll(termOwnSource) })
	scope := func(blockId string) string { return waveobj.MakeORef(waveobj.OType_Block, blockId).String() }
	if err := WshServerImpl.EventSubCommand(e.ctx, wps.SubscriptionRequest{Event: wps.Event_BlockFile, Scopes: []string{scope(e.ownBlock), scope(e.siblingBlock)}}); err != nil {
		t.Errorf("own workspace's blocks: %v", err)
	}
	refused := []wps.SubscriptionRequest{
		{Event: wps.Event_BlockFile, Scopes: []string{scope(e.otherBlock)}},
		{Event: wps.Event_BlockFile, Scopes: []string{scope(e.ownBlock), scope(e.otherBlock)}},
		{Event: wps.Event_BlockFile, AllScopes: true},
		{Event: wps.Event_BlockFile, Scopes: []string{"block:*"}},
	}
	for _, req := range refused {
		mustRefuseTermOutput(t, "subscribe "+strings.Join(req.Scopes, ","), WshServerImpl.EventSubCommand(e.ctx, req))
	}
	if wps.Broker.HasSubscribers(wps.Event_BlockFile, scope(e.otherBlock)) {
		t.Error("a refused subscription follows another workspace's block")
	}
	_, err := WshServerImpl.EventReadHistoryCommand(e.ctx, wshrpc.CommandEventReadHistoryData{Event: wps.Event_BlockFile, Scope: scope(e.otherBlock), MaxItems: 10})
	mustRefuseTermOutput(t, "history of another workspace's block", err)
	_, err = WshServerImpl.EventReadHistoryCommand(e.ctx, wshrpc.CommandEventReadHistoryData{Event: wps.Event_BlockFile, Scope: scope(e.siblingBlock), MaxItems: 10})
	mustAllowTermOutput(t, "history of a sibling pane", err)
}

// `wsh termscrollback -b`: wavesrv refuses to forward the request to another workspace's panel, which would answer it.
func TestScrollbackForwardOnlyOwnWorkspace(t *testing.T) {
	e := termOutputFixture(t)
	ask := func(source string, command string, route string) error {
		return moltenForwardGuard(wshutil.DefaultRouter, wshutil.RpcMessage{Command: command, ReqId: "r", Source: source, Route: route}, e.link)
	}
	const scrollback = "termgetscrollbacklines"
	for _, blockId := range []string{e.ownBlock, e.siblingBlock} {
		mustAllowTermOutput(t, "panel "+blockId, ask(termOwnSource, scrollback, wshutil.MakeFeBlockRouteId(blockId)))
	}
	mustRefuseTermOutput(t, "another workspace's panel", ask(termOwnSource, scrollback, wshutil.MakeFeBlockRouteId(e.otherBlock)))
	mustRefuseTermOutput(t, "a tab route", ask(termOwnSource, scrollback, wshutil.MakeTabRouteId(e.otherTab)))
	remote := wshutil.DefaultRouter.RegisterTrustedRouter(&termOutputPeer{in: make(chan []byte)})
	if err := moltenForwardGuard(wshutil.DefaultRouter, wshutil.RpcMessage{Command: scrollback, ReqId: "r", Source: "proc:remote", Route: wshutil.MakeFeBlockRouteId(e.otherBlock)}, remote); err != nil {
		t.Errorf("a remote host's scrollback changed (#1831's scope): %v", err)
	}
	if err := ask(termOwnSource, "getmeta", wshutil.MakeFeBlockRouteId(e.otherBlock)); err != nil {
		t.Errorf("a request that reads no output: %v", err)
	}
}

// A block's screenshot and the AI panel's context, which the window's tab answers: own workspace only.
func TestTabRequestsForwardOnlyOwnWorkspace(t *testing.T) {
	e := termOutputFixture(t)
	ask := func(command string, tabId string, blockId string) error {
		var data any = map[string]any{"text": "hello"}
		if blockId != "" {
			data = map[string]any{"blockid": blockId}
		}
		return moltenForwardGuard(wshutil.DefaultRouter, wshutil.RpcMessage{Command: command, ReqId: "r", Source: termOwnSource, Route: wshutil.MakeTabRouteId(tabId), Data: data}, e.link)
	}
	mustAllowTermOutput(t, "screenshot of a sibling pane", ask("captureblockscreenshot", e.ownTab, e.siblingBlock))
	mustAllowTermOutput(t, "AI context in its own tab", ask("waveaiaddcontext", e.ownTab, ""))
	mustRefuseTermOutput(t, "screenshot in another workspace's tab", ask("captureblockscreenshot", e.otherTab, e.otherBlock))
	mustRefuseTermOutput(t, "screenshot of another workspace's block", ask("captureblockscreenshot", e.ownTab, e.otherBlock))
	mustRefuseTermOutput(t, "AI context in another workspace's tab", ask("waveaiaddcontext", e.otherTab, ""))
}
