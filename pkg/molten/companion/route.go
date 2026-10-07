// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/molten/usage"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
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

const routeQueueSize = 64
const blockReadTimeout = 2 * time.Second

type blockRequest struct {
	BlockId string `json:"blockid"`
	ViewId  string `json:"viewid"`
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
	m      *Manager
	output chan []byte
}

func (l *routeLink) GetPeerInfo() string {
	return molten.CompanionRoute
}

func (l *routeLink) RecvRpcMessage() ([]byte, bool) {
	msg, ok := <-l.output
	return msg, ok
}

func (l *routeLink) SendRpcMessage(msg []byte, ingressLinkId baseds.LinkId, debugStr string) bool {
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

func (l *routeLink) answer(req wshutil.RpcMessage) {
	defer func() {
		panichandler.PanicHandler("molten:companion:route", recover())
	}()
	resp := wshutil.RpcMessage{ResId: req.ReqId}
	data, err := l.handle(req.Command, req.Source, req.Data)
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

// isWindowSource tells a request from a MoltenTerm window apart from one sent by a terminal or a remote host: the
// router stamps the source of every link that has a route of its own, so a terminal cannot pass for a tab. Only
// windows read a session.
func isWindowSource(source string) bool {
	return strings.HasPrefix(source, wshutil.RoutePrefix_Tab)
}

// fromTerminal: the commands a terminal's wsh sends, from the agent's hook or status line.
func fromTerminal(command string) bool {
	return command == molten.CompanionSessionCommand || command == molten.AgentStatusLineCommand
}

func (l *routeLink) handle(command string, source string, data any) (any, error) {
	if !fromTerminal(command) && !isWindowSource(source) {
		return nil, fmt.Errorf("the companion answers MoltenTerm windows only")
	}
	if fromTerminal(command) && strings.HasPrefix(source, wshutil.RoutePrefix_Conn) {
		return nil, fmt.Errorf("no companion for a remote terminal")
	}
	switch command {
	case molten.CompanionOpenCommand:
		var req blockRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.m.Open(req.BlockId, req.ViewId)
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
		return nil, l.m.RecordStatusLine(req)
	case molten.CompanionSessionCommand:
		var req molten.AgentSessionRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return nil, l.m.ReportSession(req)
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
}

var defaultManager *Manager

// Start registers the companion's route; wavesrv calls it once at startup, after the agent states.
func Start() {
	SetConfiguredRoots(func() map[string][]string {
		return wconfig.GetWatcher().GetFullConfig().Settings.AgentSessionRoots
	})
	m := MakeManager()
	m.runOf = attention.AgentRun
	m.integrationOf = attention.AgentIntegration
	m.allRuns = attention.AgentRuns
	m.blockInfo = readBlockInfo
	m.publish = publishView
	m.publishUsage = publishUsage
	m.writeGauges = writeGaugesSetting
	m.writeSetting = writeUsageSetting
	m.settings = func() *wconfig.SettingsType {
		settings := wconfig.GetWatcher().GetFullConfig().Settings
		return &settings
	}
	defaultManager = m
	usage.DefaultCodexUsage.SetTranscript(m.CodexLimits)
	wconfig.GetWatcher().RegisterUpdateHandler(func(config wconfig.FullConfigType) {
		m.settingsChanged(&config.Settings)
	})
	link := &routeLink{m: m, output: make(chan []byte, routeQueueSize)}
	if _, err := wshutil.DefaultRouter.RegisterTrustedLeaf(link, molten.CompanionRoute); err != nil {
		log.Printf("molten: agent companion route not started: %v\n", err)
		return
	}
	rpcClient := wshclient.GetBareRpcClient()
	rpcClient.EventListener.On(wps.Event_BlockClose, func(event *wps.WaveEvent) {
		handleBlockClose(m, event)
	})
	wshclient.EventSubCommand(rpcClient, wps.SubscriptionRequest{Event: wps.Event_BlockClose, AllScopes: true}, nil)
}
