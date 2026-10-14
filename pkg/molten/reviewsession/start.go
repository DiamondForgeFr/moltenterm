// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package reviewsession

import (
	"context"
	"errors"
	"log"
	"os"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentcontinuity"
	"github.com/wavetermdev/waveterm/pkg/molten/agentdocs"
	"github.com/wavetermdev/waveterm/pkg/molten/agentlaunch"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/molten/termupdate"
	"github.com/wavetermdev/waveterm/pkg/remote/conncontroller"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// Hooks are what wavesrv's block controller does for the sessions (this package cannot import it).
type Hooks struct {
	// StartTerminal starts a terminal block's shell (blockcontroller.ResyncController).
	StartTerminal func(ctx context.Context, tabId string, blockId string) error
}

var startOnce sync.Once

// Start registers the review sessions on wavesrv's router and ends a session when its terminal closes; it starts
// with Mission Control. Nothing else runs until a window or an agent asks: no timer, no watcher (NFR-REV-002).
func Start(hooks Hooks) {
	startOnce.Do(func() {
		manager := MakeManager(liveEnv(hooks))
		link := &routeLink{
			manager:     manager,
			output:      make(chan []byte, routeQueueSize),
			localSource: localSourceOnLink,
			pending:     make(map[string]context.CancelFunc),
		}
		if _, err := wshutil.DefaultRouter.RegisterTrustedLeaf(link, mcpreview.RouteId); err != nil {
			log.Printf("%s route not started: %v\n", logPrefix, err)
			return
		}
		rpcClient := wshclient.GetBareRpcClient()
		rpcClient.EventListener.On(wps.Event_BlockClose, func(event *wps.WaveEvent) {
			if blockId, ok := event.Data.(string); ok {
				manager.BlockClosed(blockId)
			}
		})
		rpcClient.EventListener.On(wps.Event_RouteDown, func(event *wps.WaveEvent) {
			for _, route := range event.Scopes {
				manager.RouteDown(route)
			}
		})
		wshclient.EventSubCommand(rpcClient, wps.SubscriptionRequest{Event: wps.Event_BlockClose, AllScopes: true}, nil)
		wshclient.EventSubCommand(rpcClient, wps.SubscriptionRequest{Event: wps.Event_RouteDown, AllScopes: true}, nil)
	})
}

func localSourceOnLink(source string, ingressLinkId baseds.LinkId) bool {
	return localroute.OnLink(wshutil.DefaultRouter, source, ingressLinkId)
}

func liveEnv(hooks Hooks) Env {
	dataDir := wavebase.GetWaveDataDir()
	return Env{
		DataDir:    dataDir,
		MoltenPath: func() string { return agentlaunch.MoltenPath(dataDir) },
		Now:        time.Now,
		Git: func(ctx context.Context, dir string, args ...string) ([]byte, error) {
			return mission.ExecRunner(ctx, dir, "git", args...)
		},
		AgentInstalled: func(agent string) bool {
			adapter := agentcontinuity.Find(agent)
			return adapter != nil && molten.LookPathIn(adapter.Executable(), molten.LoginPath()) != ""
		},
		AgentOrder: agentcontinuity.Default().Ids(),
		WriteFile: func(prefix string, ext string, data []byte) (string, error) {
			path, _, err := agentlaunch.WriteLaunchFileExt(agentlaunch.LaunchDir(dataDir), prefix, ext, data, time.Now())
			return path, err
		},
		Guide: func() ([]byte, error) {
			return agentdocs.Files.ReadFile(agentdocs.ReviewGuideFile)
		},
		CreateTerminal: createTerminal,
		StartAndType: func(ctx context.Context, tabId string, blockId string, line string) error {
			if hooks.StartTerminal == nil {
				return errors.New("terminals cannot be started")
			}
			start := func(ctx context.Context) error { return hooks.StartTerminal(ctx, tabId, blockId) }
			return termupdate.StartAndType(ctx, blockId, start, line)
		},
		CloseTerminal: closeTerminal,
		ReviewBlocks:  reviewBlocks,
		BlockExists: func(ctx context.Context, blockId string) bool {
			block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
			return err == nil && block != nil
		},
		VerifyToken: func(token string) (string, error) {
			rpcCtx, err := wshutil.ValidateAndExtractRpcContextFromToken(token)
			if err != nil {
				return "", err
			}
			if rpcCtx == nil || rpcCtx.BlockId == "" || rpcCtx.IsRouter {
				return "", errors.New("the token is not a terminal's")
			}
			return rpcCtx.BlockId, nil
		},
		BlockIsLocal: func(ctx context.Context, blockId string) bool {
			block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
			return err == nil && block != nil && conncontroller.IsLocalConnName(block.Meta.GetString(waveobj.MetaKey_Connection, ""))
		},
		Publish: func(scope string, update mcpreview.Update) {
			wps.Broker.Publish(wps.WaveEvent{Event: mcpreview.Event, Scopes: []string{scope}, Data: update})
		},
		ReadFile: func(path string) []byte {
			data, err := os.ReadFile(path)
			if err != nil {
				return nil
			}
			return data
		},
		Locale: osLocale,
		Language: func() string {
			return wconfig.GetWatcher().GetFullConfig().Settings.ReviewLanguage
		},
		Gh: func(ctx context.Context, dir string, args ...string) ([]byte, error) {
			return mission.ExecRunner(ctx, dir, "gh", args...)
		},
		TypePrompt: func(ctx context.Context, blockId string, line string) (bool, bool, string) {
			out := termupdate.TypeHandoffLine(ctx, blockId, line)
			if out.Result == termupdate.InputSent {
				return true, false, out.Message
			}
			switch out.Reason {
			case termupdate.InputReasonWorking, termupdate.InputReasonWaiting, termupdate.InputReasonBusy, termupdate.InputReasonNotForeground:
				return false, true, out.Message
			}
			return false, false, out.Message
		},
		SaveRecord: func(ctx context.Context, blockId string, rec any) error {
			oref := waveobj.MakeORef(waveobj.OType_Block, blockId)
			if err := wstore.UpdateObjectMeta(ctx, oref, waveobj.MetaMapType{mcpreview.SessionMetaKey: rec}, false); err != nil {
				return err
			}
			wcore.SendWaveObjUpdate(oref)
			return nil
		},
	}
}

// osLocale is the language of the OS locale (LC_ALL, LC_MESSAGES, LANG: fr_FR.UTF-8 is fr), "" when none says.
func osLocale() string {
	for _, name := range []string{"LC_ALL", "LC_MESSAGES", "LANG"} {
		value := os.Getenv(name)
		if value == "" || value == "C" || value == "POSIX" || strings.HasPrefix(value, "C.") {
			continue
		}
		lang, _, _ := strings.Cut(value, "_")
		lang, _, _ = strings.Cut(lang, ".")
		if lang != "" {
			return strings.ToLower(lang)
		}
	}
	return ""
}

// createTerminal creates the session's terminal in the tab and puts it in the tab's layout, focused: under the AI
// panel when it names one of the tab's blocks (its cards above the agent's terminal, DS-REV-012), else added.
func createTerminal(ctx context.Context, tabId string, afterBlockId string, meta waveobj.MetaMapType) (string, error) {
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		return "", err
	}
	block, err := wcore.CreateBlock(ctx, tabId, &waveobj.BlockDef{Meta: meta}, nil)
	if err != nil {
		return "", err
	}
	action := waveobj.LayoutActionData{ActionType: wcore.LayoutActionDataType_Insert, BlockId: block.OID, Focused: true}
	if afterBlockId != "" && slices.Contains(tab.BlockIds, afterBlockId) {
		action = waveobj.LayoutActionData{ActionType: wcore.LayoutActionDataType_SplitVertical, BlockId: block.OID,
			TargetBlockId: afterBlockId, Position: "after", Focused: true}
	}
	if err := wcore.QueueLayoutActionForTab(ctx, tabId, action); err != nil {
		return "", err
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Block, block.OID))
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Tab, tabId))
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_LayoutState, tab.LayoutState))
	return block.OID, nil
}

// closeTerminal deletes the session's terminal the way a window closes a pane: its shell and agent end with it.
func closeTerminal(ctx context.Context, tabId string, blockId string) error {
	if tabId == "" {
		found, err := wstore.DBFindTabForBlockId(ctx, blockId)
		if err != nil {
			return err
		}
		tabId = found
	}
	ctx = waveobj.ContextWithUpdates(ctx)
	if err := wcore.DeleteBlock(ctx, blockId, false); err != nil {
		return err
	}
	wcore.QueueLayoutActionForTab(ctx, tabId, waveobj.LayoutActionData{ActionType: wcore.LayoutActionDataType_Remove, BlockId: blockId})
	wps.Broker.SendUpdateEvents(waveobj.ContextGetUpdatesRtn(ctx))
	return nil
}

// reviewBlocks lists the terminal blocks that hold a review session, with their tab.
func reviewBlocks(ctx context.Context) ([]ReviewBlock, error) {
	blocks, err := wstore.DBGetAllObjsByType[*waveobj.Block](ctx, waveobj.OType_Block)
	if err != nil {
		return nil, err
	}
	var rtn []ReviewBlock
	for _, b := range blocks {
		if b.Meta == nil || b.Meta[mcpreview.SessionMetaKey] == nil {
			continue
		}
		tabId, _ := wstore.DBFindTabForBlockId(ctx, b.OID)
		rtn = append(rtn, ReviewBlock{BlockId: b.OID, TabId: tabId, Meta: b.Meta})
	}
	return rtn, nil
}
