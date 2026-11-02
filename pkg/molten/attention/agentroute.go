// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package attention

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// The windows and `molten agent state` reach the agent states through a leaf of wavesrv's router answering plain
// command names, like Mission Control (pkg/molten/mission/route.go): nothing is declared in pkg/wshrpc.

const agentReportTimeout = 5 * time.Second

// agentRoute: the hooks and the launcher report from any terminal, remote ones included (agent-states.md: SSH and WSL
// agents are covered when their hooks name them). The states, which name every terminal's command line, and the hook
// offers are the windows' and Electron main's (#662).
var agentRoute = localroute.Route{
	Id: molten.AgentStatesRoute,
	Policy: localroute.Policy{
		Default: localroute.AllowWindow,
		Commands: map[string]string{
			molten.AgentStatesCommand:            localroute.AllowUi,
			molten.AgentStateSetCommand:          localroute.AllowAny,
			molten.AgentIntegrationReportCommand: localroute.AllowAny,
			molten.AgentIntegrationStatusCommand: localroute.AllowAny,
		},
	},
	Handler: func(_ context.Context, command string, _ localroute.Caller, data any) (any, error) {
		return handleAgentCommand(command, data)
	},
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
	case molten.AgentStateSeenCommand:
		var req molten.AgentStateSeenRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return AgentStateSeen(req), nil
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
		var req molten.AgentDocRequest
		if data != nil {
			if err := utilfn.ReUnmarshal(&req, data); err != nil {
				return nil, err
			}
		}
		return molten.AgentDocPath(wavebase.GetWaveDataDir(), wavebase.WaveVersion, req.Doc)
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
	case molten.AgentIntegrationRunsCommand:
		return AgentIntegrationRunsNow(), nil
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
	if _, err := localroute.Register(wshutil.DefaultRouter, agentRoute); err != nil {
		log.Printf("molten: agent states route not started: %v\n", err)
	}
	rpcClient := wshclient.GetBareRpcClient()
	rpcClient.EventListener.On(wps.Event_BlockClose, handleAgentBlockClose)
	wshclient.EventSubCommand(rpcClient, wps.SubscriptionRequest{Event: wps.Event_BlockClose, AllScopes: true}, nil)
}
