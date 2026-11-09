// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

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

const (
	agentReportTimeout = 5 * time.Second
	// The job status and the controller status a terminal whose shell ended reports.
	shellStatusDone = "done"
)

// agentRoute: the hooks and the launcher report from any terminal, remote ones included (agent-states.md: SSH and WSL
// agents are covered when their hooks name them). The states, which name every terminal's command line, and the hook
// offers are the windows' and Electron main's (#662).
var agentRoute = localroute.Route{
	Id: molten.AgentStatesRoute,
	Policy: localroute.Policy{
		Default: localroute.AllowWindow,
		Commands: map[string]string{
			molten.AgentStatesCommand:            localroute.AllowUi,
			molten.AgentStopSettleCommand:        localroute.AllowUi,
			molten.AgentStateSetCommand:          localroute.AllowAny,
			molten.AgentIntegrationReportCommand: localroute.AllowAny,
			molten.AgentIntegrationStatusCommand: localroute.AllowAny,
		},
	},
	Handler: func(_ context.Context, command string, caller localroute.Caller, data any) (any, error) {
		return handleAgentCommand(command, caller, data)
	},
}

func handleAgentCommand(command string, caller localroute.Caller, data any) (any, error) {
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
		if err := ReportAgentState(ctx, req); err != nil {
			return nil, err
		}
		linkTranscript(caller, req)
		return nil, nil
	case molten.AgentStateSeenCommand:
		var req molten.AgentStateSeenRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return AgentStateSeen(req), nil
	case molten.AgentStopSettleCommand:
		var req molten.AgentStopSettleRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return molten.AgentStopSettleResult{Status: SettleAgentStop(req.BlockId, "", req.Note)}, nil
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
	dropAgentNotes(blockId)
}

// shellEndStatus: the slice of a terminal's job status (wshrpc.BlockJobStatusData) and of its controller status
// (blockcontroller.BlockControllerRuntimeStatus, which this package cannot import) that tells its shell ended.
type shellEndStatus struct {
	BlockId         string `json:"blockid"`
	Status          string `json:"status"`
	CmdExitTs       int64  `json:"cmdexitts"`
	ShellProcStatus string `json:"shellprocstatus"`
}

// shellEndOf tells which terminal an event says has no shell any more (#1920): a durable session's job done or its
// command exited (a session ended through wavesrv, `molten session end`, the Sessions view, or its shell exiting), or
// a plain shell's process done. The pane stays as an ended terminal, so no block close follows.
func shellEndOf(event *wps.WaveEvent) (string, bool) {
	if event == nil || event.Data == nil {
		return "", false
	}
	var status shellEndStatus
	if err := utilfn.ReUnmarshal(&status, event.Data); err != nil || status.BlockId == "" {
		return "", false
	}
	switch event.Event {
	case wps.Event_BlockJobStatus:
		return status.BlockId, status.Status == shellStatusDone || status.CmdExitTs != 0
	case wps.Event_ControllerStatus:
		return status.BlockId, status.ShellProcStatus == shellStatusDone
	}
	return "", false
}

// shellEvent ends the agent run of a terminal whose shell ended: an agent no shell runs any more neither works nor
// waits, whatever its hooks said last (a waiting agent killed with its session never reports again).
func (a *agentStates) shellEvent(event *wps.WaveEvent) {
	blockId, ended := shellEndOf(event)
	if !ended {
		return
	}
	a.endRun(blockId)
}

func handleAgentShellEnd(event *wps.WaveEvent) {
	defaultAgentStates.shellEvent(event)
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
	for _, event := range []string{wps.Event_BlockJobStatus, wps.Event_ControllerStatus} {
		rpcClient.EventListener.On(event, handleAgentShellEnd)
		wshclient.EventSubCommand(rpcClient, wps.SubscriptionRequest{Event: event, AllScopes: true}, nil)
	}
}
