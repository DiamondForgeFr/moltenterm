// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/reviewsession"
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
