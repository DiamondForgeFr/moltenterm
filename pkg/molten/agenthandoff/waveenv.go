// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agenthandoff

import (
	"context"
	"errors"
	"fmt"
	"log"
	"path/filepath"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/molten/browseragent"
	"github.com/wavetermdev/waveterm/pkg/molten/termupdate"
	"github.com/wavetermdev/waveterm/pkg/remote/conncontroller"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const (
	notifyTimeout = 5 * time.Second
	termView      = "term"
)

type waveEnv struct{}

// MakeWaveEnv is the Env of a running wavesrv.
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

func (waveEnv) Runs() []molten.AgentRunInfo {
	return attention.AgentRuns()
}

func (waveEnv) Run(blockId string) (molten.AgentRunInfo, bool) {
	return attention.AgentRun(blockId)
}

func (waveEnv) Locate(ctx context.Context, blockId string) (Location, error) {
	block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
	if err != nil {
		return Location{}, err
	}
	if block == nil || block.Meta.GetString(waveobj.MetaKey_View, "") != termView {
		return Location{}, fmt.Errorf("block %s is not a terminal", blockId)
	}
	rtn := Location{
		Folder: block.Meta.GetString(waveobj.MetaKey_CmdCwd, ""),
		Local:  conncontroller.IsLocalConnName(block.Meta.GetString(waveobj.MetaKey_Connection, "")),
	}
	if rtn.Folder != "" {
		rtn.Folder = filepath.Clean(wavebase.ExpandHomeDirSafe(rtn.Folder))
	}
	tabId, err := wstore.DBFindTabForBlockId(ctx, blockId)
	if err != nil {
		return Location{}, err
	}
	rtn.TabId = tabId
	if tab, err := wstore.DBGet[*waveobj.Tab](ctx, tabId); err == nil && tab != nil {
		rtn.TabName = tab.Name
	}
	wsId, err := wstore.DBFindWorkspaceForTabId(ctx, tabId)
	if err != nil {
		return Location{}, err
	}
	rtn.WorkspaceId = wsId
	project := ""
	if ws, err := wstore.DBGet[*waveobj.Workspace](ctx, wsId); err == nil && ws != nil {
		rtn.WorkspaceName = ws.Name
		project = ws.Meta.GetString(molten.ProjectMetaKey, "")
	}
	rtn.ProjectDir = projectDirOf(rtn.Folder, project)
	return rtn, nil
}

// projectDirOf: the workspace's project when the folder is in it (or unknown), else the folder's git root, else the
// folder.
func projectDirOf(folder string, project string) string {
	if project != "" && (folder == "" || within(folder, project)) {
		return project
	}
	if folder == "" {
		return ""
	}
	if root := molten.FindGitRoot(folder); root != "" {
		return root
	}
	return folder
}

func (waveEnv) TypePrompt(ctx context.Context, blockId string, line string) TypeResult {
	out := termupdate.TypeHandoffLine(ctx, blockId, line)
	if out.Result == termupdate.InputSent {
		return TypeResult{Sent: true, Submitted: out.Submitted, Message: out.Message}
	}
	switch out.Reason {
	case termupdate.InputReasonWorking, termupdate.InputReasonWaiting, termupdate.InputReasonBusy, termupdate.InputReasonNotForeground:
		return TypeResult{Retry: true, Message: out.Message}
	}
	return TypeResult{Message: out.Message}
}

func (waveEnv) BrowserPage(ctx context.Context, blockId string, tabId int64) (string, string, bool) {
	page, ok := browseragent.PageOfAgentTab(ctx, blockId, tabId)
	return page.Url, page.Title, ok
}

func (waveEnv) Notify(input molten.NotificationInput) {
	ctx, cancel := context.WithTimeout(context.Background(), notifyTimeout)
	defer cancel()
	if err := attention.PublishNotification(ctx, input); err != nil {
		log.Printf("%s notification: %v\n", logPrefix, err)
	}
}

func (waveEnv) ResolveNotification(key string) {
	ctx, cancel := context.WithTimeout(context.Background(), notifyTimeout)
	defer cancel()
	if err := attention.ResolveNotificationsExcept(ctx, key, nil); err != nil {
		log.Printf("%s notification: %v\n", logPrefix, err)
	}
}

func (waveEnv) DataDir() string {
	return wavebase.GetWaveDataDir()
}

// RecordHandoff sets the receiver's parent once: a session that later gets work from others stays under the first.
func (waveEnv) RecordHandoff(ctx context.Context, fromBlockId string, toBlockId string) {
	if fromBlockId == "" || toBlockId == "" || fromBlockId == toBlockId {
		return
	}
	block, err := wstore.DBGet[*waveobj.Block](ctx, toBlockId)
	if err != nil || block == nil || block.Meta.GetString(molten.HandedByMetaKey, "") != "" {
		return
	}
	oref := waveobj.MakeORef(waveobj.OType_Block, toBlockId)
	if err := wstore.UpdateObjectMeta(ctx, oref, waveobj.MetaMapType{molten.HandedByMetaKey: fromBlockId}, false); err != nil {
		log.Printf("molten: handoff parent not kept: %v\n", err)
		return
	}
	// The update event wcore sends (wcore imports this package): the sessions list rebuilds on it.
	if updated, err := wstore.DBGet[*waveobj.Block](ctx, toBlockId); err == nil && updated != nil {
		wps.Broker.Publish(wps.WaveEvent{
			Event:  wps.Event_WaveObjUpdate,
			Scopes: []string{oref.String()},
			Data:   waveobj.WaveObjUpdate{UpdateType: waveobj.UpdateType_Update, OType: waveobj.OType_Block, OID: toBlockId, Obj: updated},
		})
	}
}
