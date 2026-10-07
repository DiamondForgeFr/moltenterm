// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package attention

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// The windows and `molten agent state` reach the agent states through a leaf of wavesrv's router answering plain
// command names, like Mission Control (pkg/molten/mission/route.go): nothing is declared in pkg/wshrpc.

const agentRouteQueueSize = 64
const agentReportTimeout = 5 * time.Second

type agentRouteLink struct {
	output chan []byte
}

func (l *agentRouteLink) GetPeerInfo() string {
	return molten.AgentStatesRoute
}

func (l *agentRouteLink) RecvRpcMessage() ([]byte, bool) {
	msg, ok := <-l.output
	return msg, ok
}

func (l *agentRouteLink) SendRpcMessage(msg []byte, ingressLinkId baseds.LinkId, debugStr string) bool {
	var req wshutil.RpcMessage
	if err := json.Unmarshal(msg, &req); err != nil {
		return true
	}
	if req.Command == "" || req.ReqId == "" {
		return true
	}
	go l.answer(req)
	return true
}

func (l *agentRouteLink) answer(req wshutil.RpcMessage) {
	defer func() {
		panichandler.PanicHandler("molten:agents:route", recover())
	}()
	resp := wshutil.RpcMessage{ResId: req.ReqId}
	data, err := handleAgentCommand(req.Command, req.Data)
	if err != nil {
		resp.Error = err.Error()
	} else {
		resp.Data = data
	}
	out, err := json.Marshal(resp)
	if err != nil {
		return
	}
	l.output <- out
}

func handleAgentCommand(command string, data any) (any, error) {
	switch command {
	case molten.AgentStatesCommand:
		return AgentStatesSnapshot(), nil
	case molten.AgentStateSetCommand:
		var req molten.AgentStateRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		ctx, cancel := context.WithTimeout(context.Background(), agentReportTimeout)
		defer cancel()
		return nil, ReportAgentState(ctx, req)
	case molten.AgentHookOfferCommand:
		var req molten.AgentHookOfferRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		ctx, cancel := context.WithTimeout(context.Background(), agentReportTimeout)
		defer cancel()
		return AgentHookOffer(ctx, req.BlockId)
	case molten.AgentHookDismissCommand:
		var req molten.AgentHookDismissRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return nil, DismissAgentHookOffer(req.Agent)
	case molten.AgentStatesDocCommand:
		return molten.AgentStatesDocPath(wavebase.GetWaveDataDir(), wavebase.WaveVersion)
	case molten.AgentIntegrationReportCommand:
		var req molten.AgentIntegrationReport
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return nil, RecordAgentIntegration(req)
	case molten.AgentIntegrationStatusCommand:
		var req molten.AgentIntegrationStatusRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		rep, ok := AgentIntegration(req.BlockId)
		if !ok {
			return molten.AgentIntegrationStatus{}, nil
		}
		return molten.AgentIntegrationStatus{Found: true, Report: &rep}, nil
	}
	return nil, fmt.Errorf("unknown agent state command %q", command)
}

func handleAgentBlockClose(event *wps.WaveEvent) {
	blockId, ok := event.Data.(string)
	if !ok || blockId == "" {
		return
	}
	ForgetBlock(blockId)
}

// StartAgentRoute registers the route, follows closed blocks and starts the publisher; wavesrv calls it at startup.
func StartAgentRoute() {
	StartAgentStates()
	link := &agentRouteLink{output: make(chan []byte, agentRouteQueueSize)}
	if _, err := wshutil.DefaultRouter.RegisterTrustedLeaf(link, molten.AgentStatesRoute); err != nil {
		log.Printf("molten: agent states route not started: %v\n", err)
	}
	rpcClient := wshclient.GetBareRpcClient()
	rpcClient.EventListener.On(wps.Event_BlockClose, handleAgentBlockClose)
	wshclient.EventSubCommand(rpcClient, wps.SubscriptionRequest{Event: wps.Event_BlockClose, AllScopes: true}, nil)
}
