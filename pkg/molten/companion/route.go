// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/proctree"
	"github.com/wavetermdev/waveterm/pkg/molten/usage"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// The companion views and `molten agent session` reach the companion through a leaf of wavesrv's router answering
// plain command names, like the agent states (pkg/molten/attention/agentroute.go): nothing is declared in pkg/wshrpc.

const blockReadTimeout = 2 * time.Second

type blockRequest struct {
	BlockId string `json:"blockid"`
	ViewId  string `json:"viewid"`
	// Refresh: the view opens or shows, or its refresh interval came: look again now (#600).
	Refresh bool `json:"refresh,omitempty"`
}

type pickRequest struct {
	BlockId string `json:"blockid"`
	ViewId  string `json:"viewid"`
	Path    string `json:"path"`
}

type answerRequest struct {
	BlockId string `json:"blockid"`
	Index   int    `json:"index"`
}

type diffRequest struct {
	BlockId string `json:"blockid"`
	Path    string `json:"path"`
}

type routeLink struct {
	m *Manager
}

// route: a session's transcript and plan usage are read by MoltenTerm's windows only. The two reports a terminal
// sends, from the agent's hook or status line, come from a local terminal's own link and name its own block: an agent
// cannot point another terminal's companion at a file of its choosing (#662).
func (l *routeLink) route() localroute.Route {
	return localroute.Route{
		Id: molten.CompanionRoute,
		Policy: localroute.Policy{
			Default: localroute.AllowWindow,
			Commands: map[string]string{
				molten.CompanionSessionCommand:  localroute.AllowLocalTerminal,
				molten.AgentStatusLineCommand:   localroute.AllowLocalTerminal,
				molten.CompanionSubagentCommand: localroute.AllowLocalTerminal,
			},
			Refusals: map[string]string{
				molten.CompanionSessionCommand:  "no companion for a remote terminal",
				molten.AgentStatusLineCommand:   "no companion for a remote terminal",
				molten.CompanionSubagentCommand: "no companion for a remote terminal",
			},
		},
		Handler: func(_ context.Context, command string, caller localroute.Caller, data any) (any, error) {
			return l.handle(command, caller, data)
		},
	}
}

func ownBlock(caller localroute.Caller, blockId string) error {
	if !caller.IsLocalTerminal || blockId == caller.BlockId {
		return nil
	}
	return fmt.Errorf("a terminal reports for its own block only")
}

func (l *routeLink) handle(command string, caller localroute.Caller, data any) (any, error) {
	switch command {
	case molten.CompanionOpenCommand:
		var req blockRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		view, err := l.m.Open(req.BlockId, req.ViewId)
		if err == nil && req.Refresh {
			l.m.Refresh(req.BlockId)
		}
		return view, err
	case molten.CompanionCloseCommand:
		var req blockRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		l.m.Close(req.BlockId, req.ViewId)
		return nil, nil
	case molten.CompanionPickCommand:
		var req pickRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.m.Pick(req.BlockId, req.ViewId, req.Path)
	case molten.CompanionSessionsCommand:
		var req blockRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.m.Sessions(req.BlockId, req.ViewId)
	case molten.CompanionAnswerCommand:
		var req answerRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.m.Answer(req.BlockId, req.Index)
	case molten.CompanionDiffCommand:
		var req diffRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.m.Diff(req.BlockId, req.Path)
	case molten.CompanionUsageCommand:
		var req usageRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.m.usageFor(req)
	case molten.CompanionUsageGaugesCommand:
		var req usageGaugesRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.m.SetUsageGauges(req.BlockId, req.On)
	case molten.CompanionUsageExperimentalCommand:
		var req usageGaugesRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.m.SetUsageExperimental(req.BlockId, req.On)
	case molten.AgentStatusLineCommand:
		var req molten.AgentStatusLineRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		if err := ownBlock(caller, req.BlockId); err != nil {
			return nil, err
		}
		return l.m.HandleStatusLine(req)
	case molten.CompanionSessionCommand:
		var req molten.AgentSessionRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		if err := ownBlock(caller, req.BlockId); err != nil {
			return nil, err
		}
		return nil, l.m.ReportSession(req)
	case molten.CompanionSubagentCommand:
		var req molten.AgentSubagentRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		if err := ownBlock(caller, req.BlockId); err != nil {
			return nil, err
		}
		return nil, defaultSubagentHooks.add(req)
	}
	return nil, fmt.Errorf("unknown companion command %q", command)
}

// readBlockInfo reads a terminal block's folder and connection from the object store.
func readBlockInfo(blockId string) (blockInfo, error) {
	if blockId == "" {
		return blockInfo{}, fmt.Errorf("no block")
	}
	ctx, cancel := context.WithTimeout(context.Background(), blockReadTimeout)
	defer cancel()
	block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
	if err != nil {
		return blockInfo{}, err
	}
	if block == nil || block.Meta.GetString(waveobj.MetaKey_View, "") != "term" {
		return blockInfo{}, fmt.Errorf("block %s is not a terminal", blockId)
	}
	conn := block.Meta.GetString(waveobj.MetaKey_Connection, "")
	cwd := block.Meta.GetString(waveobj.MetaKey_CmdCwd, "")
	if cwd != "" {
		cwd = wavebase.ExpandHomeDirSafe(cwd)
	}
	return blockInfo{cwd: cwd, remote: !isLocalConnName(conn), term: true}, nil
}

// As conncontroller.IsLocalConnName, without importing the connection controller.
func isLocalConnName(conn string) bool {
	return conn == "" || conn == "local" || len(conn) > 6 && conn[:6] == "local:"
}

func publishView(view CompanionView) {
	scopes := []string{waveobj.MakeORef(waveobj.OType_Block, view.BlockId).String()}
	wps.Broker.Publish(wps.WaveEvent{Event: molten.CompanionEvent, Scopes: scopes, Data: view})
}

func publishUsage(info UsageInfo) {
	scopes := []string{waveobj.MakeORef(waveobj.OType_Block, info.BlockId).String()}
	wps.Broker.Publish(wps.WaveEvent{Event: molten.CompanionUsageEvent, Scopes: scopes, Data: info})
}

func handleBlockClose(m *Manager, event *wps.WaveEvent) {
	blockId, ok := event.Data.(string)
	if !ok || blockId == "" {
		return
	}
	m.ForgetBlock(blockId)
	ForgetHookSubagents(blockId)
}

var defaultManager *Manager

// Start registers the companion's route; wavesrv calls it once at startup, after the agent states.
func Start() {
	SetConfiguredRoots(func() map[string][]string {
		return wconfig.GetWatcher().GetFullConfig().Settings.AgentSessionRoots
	})
	m := MakeManager()
	m.runOf = attention.AgentRun
	m.setSettings = attention.SetAgentSettings
	m.integrationOf = attention.AgentIntegration
	m.allRuns = attention.AgentRuns
	m.blockInfo = readBlockInfo
	m.openFiles = proctree.OpenFiles
	m.procTable = proctree.Read
	m.ticketLabels = GhIssueLabels
	m.branchPRLookup = GhBranchPRs
	m.publish = publishView
	m.publishUsage = publishUsage
	m.writeGauges = writeGaugesSetting
	m.writeSetting = writeUsageSetting
	m.settings = func() *wconfig.SettingsType {
		settings := wconfig.GetWatcher().GetFullConfig().Settings
		return &settings
	}
	defaultManager = m
	m.startProcessLinks()
	usage.DefaultCodexUsage.SetTranscript(m.CodexLimits)
	wconfig.GetWatcher().RegisterUpdateHandler(func(config wconfig.FullConfigType) {
		m.settingsChanged(&config.Settings)
	})
	if _, err := localroute.Register(wshutil.DefaultRouter, (&routeLink{m: m}).route()); err != nil {
		log.Printf("molten: agent companion route not started: %v\n", err)
		return
	}
	rpcClient := wshclient.GetBareRpcClient()
	rpcClient.EventListener.On(wps.Event_BlockClose, func(event *wps.WaveEvent) {
		handleBlockClose(m, event)
	})
	wshclient.EventSubCommand(rpcClient, wps.SubscriptionRequest{Event: wps.Event_BlockClose, AllScopes: true}, nil)
	// A companion without a running agent waits for its block's agent state (FR-PERF-011).
	rpcClient.EventListener.On(molten.AgentStateEvent, func(event *wps.WaveEvent) {
		var info molten.AgentStateInfo
		if utilfn.ReUnmarshal(&info, event.Data) == nil && info.BlockId != "" {
			m.Poke(info.BlockId)
		}
	})
	wshclient.EventSubCommand(rpcClient, wps.SubscriptionRequest{Event: molten.AgentStateEvent, AllScopes: true}, nil)
}
