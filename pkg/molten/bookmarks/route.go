// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package bookmarks

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// `molten bookmarks list` reaches the bookmarks through a leaf of wavesrv's router answering a plain command name,
// like `molten material` (nothing is declared in pkg/wshrpc). Agents only read in this version: the route knows one
// command, so no caller can write a bookmark through it; the developer writes them in a window.

const dbTimeout = 2 * time.Second

// workspaceReader gives the workspace meta and the tab of a terminal's block.
type workspaceReader func(blockId string) (waveobj.MetaMapType, string, error)

type routeLink struct {
	read workspaceReader
}

func (l *routeLink) route() localroute.Route {
	return localroute.Route{
		Id:     molten.BookmarksRoute,
		Policy: localroute.Policy{Default: localroute.AllowLocal},
		Handler: func(_ context.Context, command string, caller localroute.Caller, data any) (any, error) {
			return l.handle(command, caller, data)
		},
	}
}

func (l *routeLink) handle(command string, caller localroute.Caller, data any) (any, error) {
	if command != molten.BookmarksListCommand {
		return nil, fmt.Errorf("unknown bookmarks command %q: agents only list bookmarks", command)
	}
	var req molten.BookmarksRequest
	if err := utilfn.ReUnmarshal(&req, data); err != nil {
		return nil, err
	}
	if req.BlockId == "" {
		return nil, fmt.Errorf("no terminal: run molten bookmarks in a MoltenTerm terminal")
	}
	if caller.IsLocalTerminal && req.BlockId != caller.BlockId {
		return nil, fmt.Errorf("a terminal reads its own workspace's bookmarks only")
	}
	meta, tabId, err := l.read(req.BlockId)
	if err != nil {
		return nil, err
	}
	project, ok := ProjectOf(meta, tabId)
	if !ok {
		return nil, fmt.Errorf("this workspace has no project yet: bookmarks belong to a project")
	}
	list := Read(meta, project.Id)
	if list == nil {
		list = []molten.Bookmark{}
	}
	return molten.BookmarksView{Project: project, Bookmarks: list}, nil
}

func readBlockWorkspace(blockId string) (waveobj.MetaMapType, string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), dbTimeout)
	defer cancel()
	tabId, err := wstore.DBFindTabForBlockId(ctx, blockId)
	if err != nil {
		return nil, "", err
	}
	wsId, err := wstore.DBFindWorkspaceForTabId(ctx, tabId)
	if err != nil {
		return nil, "", err
	}
	ws, err := wstore.DBGet[*waveobj.Workspace](ctx, wsId)
	if err != nil {
		return nil, "", err
	}
	if ws == nil {
		return nil, "", fmt.Errorf("no such workspace")
	}
	return ws.Meta, tabId, nil
}

// StartRoute registers the route; wavesrv calls it once.
func StartRoute() {
	link := &routeLink{read: readBlockWorkspace}
	if _, err := localroute.Register(wshutil.DefaultRouter, link.route()); err != nil {
		log.Printf("molten: bookmarks route not started: %v\n", err)
	}
}
