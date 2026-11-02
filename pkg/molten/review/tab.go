// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/reviewsession"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// The Review tab (DS-REV-012): a tab per PR, holding one molten-review block (the file list, the diff and the AI
// panel); the review session's terminal joins it when the AI panel opens. Opening a PR that has its tab switches to it.

const (
	// ReviewView is the Review tab's block view; must match frontend/moltenterm-shell/review/review-model.ts.
	ReviewView = "molten-review"
	// AiPaneView is the AI panel's block view, left of the review block, with the session's terminal under it.
	AiPaneView = "molten-review-ai"
	// The AI panel's share of the tab's width next to the review block (layout sizes are relative; the block's is 10).
	aiPaneNodeSize = uint(6)
	// PrMetaKey: the block's PR (PrInfo); TabMetaKey: the tab's PR as "owner/name#N", to find it again.
	PrMetaKey  = "molten:review"
	TabMetaKey = "molten:review"
)

// PrInfo is the PR a Review tab shows, as the Reviews view read it.
type PrInfo struct {
	Dir     string `json:"dir"`
	Repo    string `json:"repo"`
	Number  int    `json:"number"`
	Title   string `json:"title,omitempty"`
	Url     string `json:"url,omitempty"`
	HeadRef string `json:"headref"`
	BaseRef string `json:"baseref"`
	HeadOid string `json:"headoid,omitempty"`
	BaseOid string `json:"baseoid,omitempty"`
	Ticket  int    `json:"ticket,omitempty"`
}

type OpenRequest struct {
	WorkspaceId string `json:"workspaceid"`
	Pr          PrInfo `json:"pr"`
}

type OpenResult struct {
	TabId   string `json:"tabid"`
	Created bool   `json:"created,omitempty"`
}

func (p PrInfo) check() error {
	if err := checkDir(p.Dir); err != nil {
		return err
	}
	if err := (PrKey{Repo: p.Repo, Number: p.Number}).check(); err != nil {
		return err
	}
	if !reviewsession.ValidRef(p.HeadRef) || !reviewsession.ValidRef(p.BaseRef) {
		return fmt.Errorf("headref and baseref must be the PR's branches")
	}
	if err := checkOid(p.HeadOid, "headoid"); err != nil {
		return err
	}
	return checkOid(p.BaseOid, "baseoid")
}

func tabKey(repo string, number int) string {
	return strings.ToLower(repo) + "#" + strconv.Itoa(number)
}

// TabName is the Review tab's name: the PR's number (it shares GitHub's numbering with the tickets).
func TabName(number int) string {
	return "Review #" + strconv.Itoa(number)
}

// findTab returns the workspace's Review tab of the PR, "" when it has none.
func findTab(ctx context.Context, ws *waveobj.Workspace, key string) string {
	for _, tabId := range ws.TabIds {
		tab, err := wstore.DBGet[*waveobj.Tab](ctx, tabId)
		if err != nil || tab == nil {
			continue
		}
		if tab.Meta.GetString(TabMetaKey, "") == key {
			return tabId
		}
	}
	return ""
}

// OpenTab returns the PR's Review tab in the workspace, creating it when there is none; the window then shows it.
func OpenTab(ctx context.Context, req OpenRequest) (OpenResult, error) {
	if req.WorkspaceId == "" {
		return OpenResult{}, fmt.Errorf("workspaceid is required")
	}
	if err := req.Pr.check(); err != nil {
		return OpenResult{}, err
	}
	ws, err := wcore.GetWorkspace(ctx, req.WorkspaceId)
	if err != nil {
		return OpenResult{}, err
	}
	key := tabKey(req.Pr.Repo, req.Pr.Number)
	if tabId := findTab(ctx, ws, key); tabId != "" {
		return OpenResult{TabId: tabId}, nil
	}
	ctx = waveobj.ContextWithUpdates(ctx)
	// No starter layout: the tab holds the review block only.
	tabId, err := wcore.CreateTab(ctx, req.WorkspaceId, TabName(req.Pr.Number), false, true)
	if err != nil {
		return OpenResult{}, err
	}
	tabORef := waveobj.MakeORef(waveobj.OType_Tab, tabId)
	if err := wstore.UpdateObjectMeta(ctx, tabORef, waveobj.MetaMapType{TabMetaKey: key}, false); err != nil {
		return OpenResult{}, err
	}
	layout := wcore.PortableLayout{{IndexArr: []int{0}, Focused: true, BlockDef: &waveobj.BlockDef{
		Meta: waveobj.MetaMapType{waveobj.MetaKey_View: ReviewView, PrMetaKey: req.Pr},
	}}}
	if err := wcore.ApplyPortableLayout(ctx, tabId, layout, true); err != nil {
		return OpenResult{}, err
	}
	wps.Broker.SendUpdateEvents(waveobj.ContextGetUpdatesRtn(ctx))
	wcore.SendWaveObjUpdate(tabORef)
	return OpenResult{TabId: tabId, Created: true}, nil
}

// AiPaneRequest opens the AI panel of the review block BlockId in its tab.
type AiPaneRequest struct {
	TabId   string `json:"tabid"`
	BlockId string `json:"blockid"`
	Pr      PrInfo `json:"pr"`
}

type AiPaneResult struct {
	BlockId string `json:"blockid"`
	Created bool   `json:"created,omitempty"`
}

// isAiPaneOf tells whether a block is the AI panel of the PR.
func isAiPaneOf(block *waveobj.Block, key string) bool {
	if block == nil || block.Meta.GetString(waveobj.MetaKey_View, "") != AiPaneView {
		return false
	}
	var pr PrInfo
	if utilfn.ReUnmarshal(&pr, block.Meta[PrMetaKey]) != nil {
		return false
	}
	return tabKey(pr.Repo, pr.Number) == key
}

// aiPaneLayoutAction lays the AI panel out on the left of the review block (DS-REV-012, #1165): in a tab holding an
// agent and a panel, the agent is on the left and the graphics on the right. An AI panel laid out on the right by an
// earlier version keeps its place until it or its tab is closed, so a running session is never disturbed.
func aiPaneLayoutAction(aiBlockId string, reviewBlockId string) waveobj.LayoutActionData {
	size := aiPaneNodeSize
	return waveobj.LayoutActionData{ActionType: wcore.LayoutActionDataType_SplitHorizontal, BlockId: aiBlockId,
		TargetBlockId: reviewBlockId, Position: "before", NodeSize: &size}
}

// OpenAiPane returns the PR's AI panel in the tab, creating it on the left of the review block (DS-REV-012): the
// briefing and the explanation cards, with the review session's terminal split under it.
func OpenAiPane(ctx context.Context, req AiPaneRequest) (AiPaneResult, error) {
	if req.TabId == "" || req.BlockId == "" {
		return AiPaneResult{}, fmt.Errorf("tabid and blockid are required")
	}
	if err := req.Pr.check(); err != nil {
		return AiPaneResult{}, err
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, req.TabId)
	if err != nil {
		return AiPaneResult{}, err
	}
	key := tabKey(req.Pr.Repo, req.Pr.Number)
	for _, blockId := range tab.BlockIds {
		block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
		if err == nil && isAiPaneOf(block, key) {
			return AiPaneResult{BlockId: blockId}, nil
		}
	}
	if !slices.Contains(tab.BlockIds, req.BlockId) {
		return AiPaneResult{}, uimsg.Errorf(uimsg.Make("review.blocknotintab"), "the review block is not in this tab")
	}
	block, err := wcore.CreateBlock(ctx, req.TabId, &waveobj.BlockDef{Meta: waveobj.MetaMapType{
		waveobj.MetaKey_View: AiPaneView, PrMetaKey: req.Pr,
	}}, nil)
	if err != nil {
		return AiPaneResult{}, err
	}
	if err := wcore.QueueLayoutActionForTab(ctx, req.TabId, aiPaneLayoutAction(block.OID, req.BlockId)); err != nil {
		return AiPaneResult{}, err
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Block, block.OID))
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Tab, req.TabId))
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_LayoutState, tab.LayoutState))
	return AiPaneResult{BlockId: block.OID, Created: true}, nil
}
