// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package browseragent

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/authkey"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// emain's side of the DevTools controller (emain/moltenterm-browseragent.ts); must match the handler names there.
const (
	EmainCdpCommand     = "moltenbrowsercdp"
	EmainControlCommand = "moltenbrowsercontrol"

	defaultCdpTimeout = 10 * time.Second
	// must match EmainTokenLabel in emain/moltenterm-browseragent.ts
	emainTokenLabel = "molten:browseragent"
)

// Any route can address emain, and a router link's source is not stamped: emain runs these commands only with a token
// derived from the auth key emain gave wavesrv at launch, which never leaves the two processes.
type CdpRequest struct {
	BlockId      string `json:"blockid"`
	BrowserTabId string `json:"browsertabid"`
	Method       string `json:"method"`
	Params       any    `json:"params,omitempty"`
	Token        string `json:"token"`
}

type EmainControlRequest struct {
	BlockId      string `json:"blockid"`
	BrowserTabId string `json:"browsertabid"`
	Controlled   bool   `json:"controlled"`
	Token        string `json:"token"`
}

func emainToken() string {
	mac := hmac.New(sha256.New, []byte(authkey.GetAuthKey()))
	mac.Write([]byte(emainTokenLabel))
	return hex.EncodeToString(mac.Sum(nil))
}

type waveEnv struct{}

// MakeWaveEnv is the Env of a running wavesrv: wstore, the bare RPC client (as the windows' own calls go) and the
// event broker.
func MakeWaveEnv() Env {
	return waveEnv{}
}

func (waveEnv) VerifyToken(token string) (string, error) {
	rpcCtx, err := wshutil.ValidateAndExtractRpcContextFromToken(token)
	if err != nil {
		return "", err
	}
	if rpcCtx == nil || rpcCtx.BlockId == "" || rpcCtx.IsRouter {
		return "", errors.New("the token is not a terminal's")
	}
	return rpcCtx.BlockId, nil
}

func (waveEnv) LocateBlock(ctx context.Context, blockId string) (BlockLocation, error) {
	block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
	if err != nil {
		return BlockLocation{}, err
	}
	if block == nil {
		return BlockLocation{}, fmt.Errorf("block %s not found", blockId)
	}
	tabId, err := wstore.DBFindTabForBlockId(ctx, blockId)
	if err != nil {
		return BlockLocation{}, err
	}
	wsId, err := wstore.DBFindWorkspaceForTabId(ctx, tabId)
	if err != nil {
		return BlockLocation{}, err
	}
	return BlockLocation{TabId: tabId, WorkspaceId: wsId, View: block.Meta.GetString(waveobj.MetaKey_View, "")}, nil
}

func (waveEnv) TabPanels(ctx context.Context, tabId string) ([]string, any, error) {
	tab, err := wstore.DBGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		return nil, nil, err
	}
	if tab == nil {
		return nil, nil, fmt.Errorf("tab %s not found", tabId)
	}
	var panels []string
	for _, blockId := range tab.BlockIds {
		block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
		if err != nil || block == nil {
			continue
		}
		if block.Meta.GetString(waveobj.MetaKey_View, "") == molten.BrowserView {
			panels = append(panels, blockId)
		}
	}
	return panels, tab.Meta[molten.BrowserRecentMetaKey], nil
}

func (waveEnv) ReadPanel(ctx context.Context, panelId string) (Panel, bool, error) {
	block, err := wstore.DBGet[*waveobj.Block](ctx, panelId)
	if err != nil {
		return Panel{}, false, err
	}
	if block == nil || block.Meta.GetString(waveobj.MetaKey_View, "") != molten.BrowserView {
		return Panel{}, false, nil
	}
	tabId, err := wstore.DBFindTabForBlockId(ctx, panelId)
	if err != nil {
		return Panel{}, false, nil
	}
	wsId, err := wstore.DBFindWorkspaceForTabId(ctx, tabId)
	if err != nil {
		return Panel{}, false, nil
	}
	return Panel{BlockId: panelId, TabId: tabId, WorkspaceId: wsId, Tabs: molten.BrowserPanelTabs(block.Meta)}, true, nil
}

func (waveEnv) AgentName(blockId string) string {
	run, ok := attention.AgentRun(blockId)
	if !ok || !run.Running || run.Agent == "" {
		return ""
	}
	return molten.AgentDisplayName(run.Agent)
}

func (waveEnv) OpenTab(ctx context.Context, req OpenTabRequest) (string, error) {
	rpc := wshclient.GetBareRpcClient()
	if req.PanelId != "" {
		requestId, err := uuid.NewV7()
		if err != nil {
			return "", err
		}
		err = wshclient.SetMetaCommand(rpc, wshrpc.CommandSetMetaData{
			ORef: waveobj.MakeORef(waveobj.OType_Block, req.PanelId),
			Meta: molten.BrowserAgentTabRequestMeta(requestId.String(), req.Url, req.BrowserTabId),
		}, nil)
		if err != nil {
			return "", err
		}
		return req.PanelId, nil
	}
	// A new panel opens beside the agent's terminal, which keeps the focus (AC2); it starts with the agent's tab.
	meta := map[string]any{
		waveobj.MetaKey_View:        molten.BrowserView,
		waveobj.MetaKey_Url:         req.Url,
		molten.BrowserTabsMetaKey:   []any{map[string]any{"id": req.BrowserTabId, "url": req.Url}},
		molten.BrowserActiveMetaKey: req.BrowserTabId,
	}
	oref, err := wshclient.CreateBlockCommand(rpc, wshrpc.CommandCreateBlockData{
		TabId:         req.TabId,
		BlockDef:      &waveobj.BlockDef{Meta: meta},
		TargetBlockId: req.TermBlockId,
		TargetAction:  "splitright",
		Focused:       false,
	}, nil)
	if err != nil {
		return "", err
	}
	return oref.OID, nil
}

func (waveEnv) CloseTab(ctx context.Context, key TabKey) error {
	requestId, err := uuid.NewV7()
	if err != nil {
		return err
	}
	return wshclient.SetMetaCommand(wshclient.GetBareRpcClient(), wshrpc.CommandSetMetaData{
		ORef: waveobj.MakeORef(waveobj.OType_Block, key.PanelId),
		Meta: molten.BrowserCloseRequestMeta(requestId.String(), key.BrowserTabId),
	}, nil)
}

func (waveEnv) Cdp(ctx context.Context, key TabKey, method string, params any) (json.RawMessage, error) {
	timeout := defaultCdpTimeout
	if deadline, ok := ctx.Deadline(); ok {
		timeout = time.Until(deadline)
	}
	if timeout <= 0 {
		return nil, context.DeadlineExceeded
	}
	handler, err := wshclient.GetBareRpcClient().SendComplexRequest(EmainCdpCommand, CdpRequest{
		BlockId:      key.PanelId,
		BrowserTabId: key.BrowserTabId,
		Method:       method,
		Params:       params,
		Token:        emainToken(),
	}, &wshrpc.RpcOpts{Route: wshutil.ElectronRoute, Timeout: timeout.Milliseconds()})
	if err != nil {
		return nil, err
	}
	type response struct {
		data any
		err  error
	}
	respCh := make(chan response, 1)
	go func() {
		data, err := handler.NextResponse()
		respCh <- response{data: data, err: err}
	}()
	select {
	case resp := <-respCh:
		if resp.err != nil {
			return nil, resp.err
		}
		var raw json.RawMessage
		if err := utilfn.ReUnmarshal(&raw, resp.data); err != nil {
			return nil, err
		}
		return raw, nil
	case <-ctx.Done():
		cancelCtx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		handler.SendCancel(cancelCtx)
		return nil, ctx.Err()
	}
}

func (waveEnv) SetControl(key TabKey, controlled bool) {
	wshclient.GetBareRpcClient().SendCommand(EmainControlCommand, EmainControlRequest{
		BlockId:      key.PanelId,
		BrowserTabId: key.BrowserTabId,
		Controlled:   controlled,
		Token:        emainToken(),
	}, &wshrpc.RpcOpts{Route: wshutil.ElectronRoute})
}

func (waveEnv) Publish(state PanelState) {
	wps.Broker.Publish(wps.WaveEvent{
		Event:  mcpbrowser.StateEvent,
		Scopes: []string{waveobj.MakeORef(waveobj.OType_Block, state.BlockId).String()},
		Data:   state,
	})
}
