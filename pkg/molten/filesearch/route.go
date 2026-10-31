// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package filesearch

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// `molten files` and the file panels reach the search through a leaf of wavesrv's router answering plain command
// names, like the file confinement check (pkg/molten/fileconfine/route.go): nothing is declared in pkg/wshrpc. A local
// terminal shows a search in its own tab; a window lists a panel's recursive matches. A remote host may do neither,
// its paths are not this computer's.

const dbTimeout = 5 * time.Second

func (s *Service) route() localroute.Route {
	return localroute.Route{
		Id: RouteId,
		Policy: localroute.Policy{
			Default: localroute.AllowLocalTerminal,
			Commands: map[string]string{
				SearchCommand: localroute.AllowUi,
			},
		},
		Handler: func(ctx context.Context, command string, caller localroute.Caller, data any) (any, error) {
			return s.handle(ctx, command, caller, data)
		},
	}
}

func (s *Service) handle(ctx context.Context, command string, caller localroute.Caller, data any) (any, error) {
	switch command {
	case ShowCommand:
		var req ShowRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return s.Show(caller, req)
	case AnswerCommand:
		var req AnswerRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return s.Answer(ctx, caller, req)
	case SearchCommand:
		var req SearchRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return SearchForPanel(req)
	}
	return nil, fmt.Errorf("unknown molten files command %q", command)
}

type storeBackend struct{}

func dbCtx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), dbTimeout)
}

func (storeBackend) Block(blockId string) (*waveobj.Block, error) {
	ctx, cancel := dbCtx()
	defer cancel()
	return wstore.DBGet[*waveobj.Block](ctx, blockId)
}

func (storeBackend) TabOfBlock(blockId string) (*waveobj.Tab, error) {
	ctx, cancel := dbCtx()
	defer cancel()
	tabId, err := wstore.DBFindTabForBlockId(ctx, blockId)
	if err != nil {
		return nil, err
	}
	return wstore.DBGet[*waveobj.Tab](ctx, tabId)
}

func (storeBackend) WorkspaceOfTab(tabId string) (*waveobj.Workspace, error) {
	ctx, cancel := dbCtx()
	defer cancel()
	wsId, err := wstore.DBFindWorkspaceForTabId(ctx, tabId)
	if err != nil {
		return nil, err
	}
	return wstore.DBGet[*waveobj.Workspace](ctx, wsId)
}

func (storeBackend) SetMeta(blockId string, meta waveobj.MetaMapType) error {
	ctx, cancel := dbCtx()
	defer cancel()
	oref := waveobj.MakeORef(waveobj.OType_Block, blockId)
	if err := wstore.UpdateObjectMeta(ctx, oref, meta, false); err != nil {
		return err
	}
	wcore.SendWaveObjUpdate(oref)
	return nil
}

func (storeBackend) CreatePanel(tabId string, meta waveobj.MetaMapType, besideBlockId string) (string, error) {
	ctx, cancel := dbCtx()
	defer cancel()
	block, err := wcore.CreateBlock(ctx, tabId, &waveobj.BlockDef{Meta: meta}, nil)
	if err != nil {
		return "", err
	}
	// Agent on the left, panels on the right (DS-REV-012); the agent's terminal keeps the focus.
	action := waveobj.LayoutActionData{ActionType: wcore.LayoutActionDataType_SplitHorizontal, BlockId: block.OID,
		TargetBlockId: besideBlockId, Position: "after", Focused: false}
	if err := wcore.QueueLayoutActionForTab(ctx, tabId, action); err != nil {
		return "", err
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		return "", err
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Block, block.OID))
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Tab, tabId))
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_LayoutState, tab.LayoutState))
	return block.OID, nil
}

func (storeBackend) AgentName(blockId string) string {
	if run, ok := attention.AgentRun(blockId); ok && run.Running {
		return run.FirstName
	}
	return ""
}

func (storeBackend) ShowHiddenDefault() bool {
	if v := wconfig.GetWatcher().GetFullConfig().Settings.PreviewShowHiddenFiles; v != nil {
		return *v
	}
	return true
}

// StartRoute registers the route; wavesrv calls it once.
func StartRoute() {
	if _, err := localroute.Register(wshutil.DefaultRouter, MakeService(storeBackend{}).route()); err != nil {
		log.Printf("molten: molten files route not started: %v\n", err)
	}
}
