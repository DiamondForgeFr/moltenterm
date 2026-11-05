// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wshserver

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/filestore"
	"github.com/wavetermdev/waveterm/pkg/util/shellutil"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func varsClient(t *testing.T) string {
	t.Helper()
	saved := wstore.GetClientId()
	client := uuid.NewString()
	wstore.SetClientId(client)
	t.Cleanup(func() { wstore.SetClientId(saved) })
	return client
}

func mustRefuseVars(t *testing.T, err error) {
	t.Helper()
	if err == nil || !strings.HasPrefix(err.Error(), "refused:") {
		t.Fatalf("got %v, want refusal", err)
	}
}

func varsRemoteContext(t *testing.T, conn string) context.Context {
	t.Helper()
	peer := &termOutputPeer{in: make(chan []byte)}
	t.Cleanup(func() { close(peer.in) })
	link := wshutil.DefaultRouter.RegisterUntrustedLink(peer)
	ctx := wshutil.WithCallerContext(context.Background(), "", link)
	token := uuid.NewString()
	if err := shellutil.AddTokenSwapEntry(&shellutil.TokenSwapEntry{Token: token, Exp: time.Now().Add(time.Minute), RpcContext: &wshrpc.RpcContext{ProcRoute: true, Conn: conn}}); err != nil {
		t.Fatal(err)
	}
	impl := &wshutil.WshRouterControlImpl{Router: wshutil.DefaultRouter}
	rtn, err := impl.AuthenticateTokenCommand(ctx, wshrpc.CommandAuthenticateTokenData{Token: token})
	if err != nil {
		t.Fatal(err)
	}
	return wshutil.WithCallerContext(context.Background(), rtn.RouteId, link)
}

func TestVariableRPCsRespectWorkspaceScopes(t *testing.T) {
	e := termOutputFixture(t)
	client := varsClient(t)
	for _, zone := range []string{client, e.ownWs, e.ownTab, e.ownBlock, e.siblingBlock, e.siblingJob} {
		for _, name := range []string{"var", "deployment.vars"} {
			req := wshrpc.CommandVarData{ZoneId: zone, FileName: name, Key: "TOKEN", Val: "synthetic"}
			if err := WshServerImpl.SetVarCommand(e.ctx, req); err != nil {
				t.Fatalf("write %s/%s: %v", zone, name, err)
			}
			got, err := WshServerImpl.GetVarCommand(e.ctx, req)
			if err != nil || !got.Exists || got.Val != req.Val {
				t.Fatalf("read %s/%s: %+v %v", zone, name, got, err)
			}
			all, err := WshServerImpl.GetAllVarsCommand(e.ctx, req)
			if err != nil || len(all) != 1 || all[0].Val != req.Val {
				t.Fatalf("all %s/%s: %+v %v", zone, name, all, err)
			}
		}
	}
	for _, zone := range []string{e.otherWs, e.otherTab, e.otherBlock, e.otherJob, uuid.NewString(), ""} {
		req := wshrpc.CommandVarData{ZoneId: zone, FileName: wavebase.BlockFile_Term, Key: "TOKEN"}
		_, err := WshServerImpl.GetVarCommand(e.ctx, req)
		mustRefuseVars(t, err)
		_, err = WshServerImpl.GetAllVarsCommand(e.ctx, req)
		mustRefuseVars(t, err)
		req.FileName = wavebase.BlockFile_Env
		req.Val = "injected"
		mustRefuseVars(t, WshServerImpl.SetVarCommand(e.ctx, req))
		if _, err := filestore.WFS.Stat(context.Background(), zone, req.FileName); err == nil {
			t.Fatal("refused write created an environment file")
		}
	}
	peer := &termOutputPeer{in: make(chan []byte)}
	t.Cleanup(func() { close(peer.in) })
	link := wshutil.DefaultRouter.RegisterWindowRouter(peer)
	window := wshutil.WithCallerContext(context.Background(), wshutil.MakeTabRouteId(e.otherTab), link)
	impl := &wshutil.WshRouterControlImpl{Router: wshutil.DefaultRouter}
	if err := impl.RouteAnnounceCommand(window); err != nil {
		t.Fatal(err)
	}
	for _, ctx := range []context.Context{window, context.Background()} {
		req := wshrpc.CommandVarData{ZoneId: e.otherBlock, FileName: "var", Key: "TOKEN", Val: "window"}
		if err := WshServerImpl.SetVarCommand(ctx, req); err != nil {
			t.Fatal(err)
		}
		if got, err := WshServerImpl.GetVarCommand(ctx, req); err != nil || got.Val != req.Val {
			t.Fatalf("trusted read: %+v %v", got, err)
		}
	}
}

func TestRemoteVariableRPCsAskBeforeLocalAccess(t *testing.T) {
	e := termOutputFixture(t)
	client := varsClient(t)
	f := setupGuard(t)
	ctx := varsRemoteContext(t, guardTestConn)
	for _, zone := range []string{client, e.ownWs, e.ownTab, e.otherBlock} {
		req := wshrpc.CommandVarData{ZoneId: zone, FileName: "var", Key: "TOKEN", Val: "synthetic-secret"}
		if err := WshServerImpl.SetVarCommand(context.Background(), req); err != nil {
			t.Fatal(err)
		}
		_, err := WshServerImpl.GetVarCommand(ctx, req)
		mustRefuseVars(t, err)
		_, err = WshServerImpl.GetAllVarsCommand(ctx, req)
		mustRefuseVars(t, err)
		req.Val = "not-allowed"
		mustRefuseVars(t, WshServerImpl.SetVarCommand(ctx, req))
		got, err := WshServerImpl.GetVarCommand(context.Background(), req)
		if err != nil || got.Val != "synthetic-secret" {
			t.Fatalf("denied write changed stored vars: %+v %v", got, err)
		}
	}
	for _, call := range f.asked() {
		if call.kind != moltenAskReadVars && call.kind != moltenAskWriteVars {
			t.Fatalf("wrong prompt: %+v", call)
		}
	}
	f.allow, f.remember = true, true
	req := wshrpc.CommandVarData{ZoneId: client, FileName: "var", Key: "TOKEN"}
	before := len(f.asked())
	if _, err := moltenRemoteGuard(ctx, "getvar", asWire(t, req)); err != nil {
		t.Fatal(err)
	}
	got, err := WshServerImpl.GetVarCommand(ctx, req)
	if err != nil || got.Val != "synthetic-secret" || len(f.asked()) != before+1 {
		t.Fatalf("approved default client read / double prompt: %+v %v (%d prompts)", got, err, len(f.asked())-before)
	}
	if q := f.last(); !q.Sensitive || q.Folder != "" {
		t.Fatalf("variable grant must be exact: %+v", q)
	}
	if q := f.last(); q.TargetLabel != "shared variables / var" || q.TargetText.Code != "remoteask.variablesShared" || !strings.Contains(q.Target, client) {
		t.Fatalf("readable label must not replace exact grant identity: %+v", q)
	}
	if _, err := moltenRemoteGuard(ctx, "getallvars", asWire(t, req)); err != nil {
		t.Fatal(err)
	}
	if _, err := WshServerImpl.GetAllVarsCommand(ctx, req); err != nil || len(f.asked()) != before+1 {
		t.Fatalf("all-vars did not reuse read grant: %v", err)
	}
	req.Val = "approved-write"
	if _, err := moltenRemoteGuard(ctx, "setvar", asWire(t, req)); err != nil {
		t.Fatal(err)
	}
	if err := WshServerImpl.SetVarCommand(ctx, req); err != nil || len(f.asked()) != before+2 {
		t.Fatalf("write must ask separately once: %v", err)
	}
	f.allow = false
	for _, switched := range []wshrpc.CommandVarData{
		{ZoneId: client, FileName: "other.vars", Key: "TOKEN"},
		{ZoneId: e.otherBlock, FileName: "var", Key: "TOKEN"},
		{ZoneId: e.otherBlock, FileName: wavebase.BlockFile_Env, Key: "TOKEN", Val: "injected"},
	} {
		_, err := moltenRemoteGuard(ctx, "getallvars", asWire(t, switched))
		mustRefuseVars(t, err)
		mustRefuseVars(t, WshServerImpl.SetVarCommand(ctx, switched))
	}
	if _, err := filestore.WFS.Stat(context.Background(), e.otherBlock, wavebase.BlockFile_Env); err == nil {
		t.Fatal("denied write created environment file")
	}
}

func TestRemoteVariableRPCsKeepRemoteConnectionAccess(t *testing.T) {
	e := termOutputFixture(t)
	f := setupGuard(t)
	ctx := varsRemoteContext(t, guardTestConn)
	for _, zone := range []string{ownBlock, serverBlock, "own-job"} {
		req := wshrpc.CommandVarData{ZoneId: zone, FileName: "deployment.vars", Key: "TOKEN", Val: "remote"}
		if _, err := moltenRemoteGuard(ctx, "setvar", asWire(t, req)); err != nil {
			t.Fatal(err)
		}
		if err := WshServerImpl.SetVarCommand(ctx, req); err != nil {
			t.Fatal(err)
		}
		if got, err := WshServerImpl.GetVarCommand(ctx, req); err != nil || got.Val != req.Val {
			t.Fatalf("remote variable read: %+v %v", got, err)
		}
	}
	if len(f.asked()) != 0 {
		t.Fatal("remote-connection variables unexpectedly asked the window")
	}
	peer := &termOutputPeer{in: make(chan []byte)}
	t.Cleanup(func() { close(peer.in) })
	unknown := wshutil.DefaultRouter.RegisterTrustedRouter(peer)
	_, err := WshServerImpl.GetAllVarsCommand(wshutil.WithCallerContext(context.Background(), "proc:unknown", unknown), wshrpc.CommandVarData{ZoneId: e.otherBlock, FileName: wavebase.BlockFile_Term})
	mustRefuseVars(t, err)
}

func TestVariableRPCGrantUsesZoneNotDisplayName(t *testing.T) {
	e := termOutputFixture(t)
	f := setupGuard(t)
	ctx := varsRemoteContext(t, guardTestConn)
	for _, block := range []string{e.ownBlock, e.otherBlock} {
		if err := wstore.UpdateObjectMeta(context.Background(), waveobj.MakeORef(waveobj.OType_Block, block), waveobj.MetaMapType{waveobj.MetaKey_FrameTitle: "Deployment"}, false); err != nil {
			t.Fatal(err)
		}
	}
	f.allow = true
	req := wshrpc.CommandVarData{ZoneId: e.ownBlock, FileName: "var", Key: "TOKEN", Val: "allowed"}
	if err := WshServerImpl.SetVarCommand(ctx, req); err != nil {
		t.Fatal(err)
	}
	first := f.last()
	if first.TargetLabel != "panel Deployment / var" {
		t.Fatalf("unreadable target: %+v", first)
	}
	f.allow = false
	req.ZoneId = e.otherBlock
	mustRefuseVars(t, WshServerImpl.SetVarCommand(ctx, req))
	second := f.last()
	if first.TargetLabel != second.TargetLabel || first.Target == second.Target {
		t.Fatalf("display names must not define grants: %+v %+v", first, second)
	}
	if _, err := filestore.WFS.Stat(context.Background(), e.otherBlock, "var"); err == nil {
		t.Fatal("same-name panel inherited another panel's grant")
	}
}
