// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package bookmarks

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/contexts"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// `molten bookmarks list` reaches the bookmarks through a leaf of wavesrv's router answering a plain command name,
// like `molten material` (nothing is declared in pkg/wshrpc). Agents only read in this version: the route knows one
// command, so no caller can write a bookmark through it; the developer writes them in a window. A terminal reads what
// its own place sees (its project, its workspace, its context, the app) and nothing of the other places.

const dbTimeout = 2 * time.Second

// terminalSite is what the route reads of a terminal's surroundings: its workspace, the tab it is in, and the client
// whose meta holds the bookmarks and the contexts.
type terminalSite struct {
	workspaceId   string
	workspaceName string
	workspaceMeta waveobj.MetaMapType
	tabId         string
	clientMeta    waveobj.MetaMapType
}

type siteReader func(blockId string) (terminalSite, error)

type routeLink struct {
	read siteReader
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
	site, err := l.read(req.BlockId)
	if err != nil {
		return nil, err
	}
	return viewOf(site), nil
}

func viewOf(site terminalSite) molten.BookmarksView {
	list := contexts.ReadContexts(site.clientMeta)
	contextId := contexts.ContextOf(list, site.workspaceMeta)
	contextName := ""
	for _, c := range list {
		if c.Id == contextId {
			contextName = c.Name
		}
	}
	here := Here{ContextId: contextId, WorkspaceId: site.workspaceId}
	names := Names{Context: contextName, Workspace: site.workspaceName}
	view := molten.BookmarksView{Workspace: nameOr(site.workspaceName, site.workspaceId), Context: nameOr(contextName, contextId)}
	if project, ok := ProjectOf(site.workspaceMeta, site.tabId); ok {
		view.Project = project
		here.ProjectId = project.Id
		names.Project = project.Name
	}
	view.Bookmarks = VisibleFrom(ReadStore(site.clientMeta), here, names)
	return view
}

func readBlockSite(blockId string) (terminalSite, error) {
	ctx, cancel := context.WithTimeout(context.Background(), dbTimeout)
	defer cancel()
	tabId, err := wstore.DBFindTabForBlockId(ctx, blockId)
	if err != nil {
		return terminalSite{}, err
	}
	wsId, err := wstore.DBFindWorkspaceForTabId(ctx, tabId)
	if err != nil {
		return terminalSite{}, err
	}
	ws, err := wstore.DBGet[*waveobj.Workspace](ctx, wsId)
	if err != nil {
		return terminalSite{}, err
	}
	if ws == nil {
		return terminalSite{}, fmt.Errorf("no such workspace")
	}
	site := terminalSite{workspaceId: ws.OID, workspaceName: ws.Name, workspaceMeta: ws.Meta, tabId: tabId}
	client, err := wstore.DBGetSingleton[*waveobj.Client](ctx)
	if err != nil && !errors.Is(err, wstore.ErrNotFound) {
		return terminalSite{}, err
	}
	if client != nil {
		site.clientMeta = client.Meta
	}
	return site, nil
}

// StartRoute registers the route; wavesrv calls it once.
func StartRoute() {
	link := &routeLink{read: readBlockSite}
	if _, err := localroute.Register(wshutil.DefaultRouter, link.route()); err != nil {
		log.Printf("molten: bookmarks route not started: %v\n", err)
	}
}
