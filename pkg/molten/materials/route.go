// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package materials

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/filestore"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentcontinuity/checkpoint"
	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// The windows and `molten material` reach the registry through a leaf of wavesrv's router answering plain command
// names, like the task checkpoint (nothing is declared in pkg/wshrpc). A terminal lists and declares for its own
// workspace's project; changing or deleting a material is the developer's, from a window.

const (
	dbTimeout     = 2 * time.Second
	sweepInterval = 6 * time.Hour
)

type routeLink struct {
	r *Registry
}

func (l *routeLink) route() localroute.Route {
	return localroute.Route{
		Id: molten.MaterialsRoute,
		Policy: localroute.Policy{
			Default: localroute.AllowUi,
			Commands: map[string]string{
				molten.MaterialsListCommand: localroute.AllowLocal,
				molten.MaterialGetCommand:   localroute.AllowLocal,
				molten.MaterialAddCommand:   localroute.AllowLocal,
			},
		},
		Handler: func(_ context.Context, command string, caller localroute.Caller, data any) (any, error) {
			return l.handle(command, caller, data)
		},
	}
}

func (l *routeLink) handle(command string, caller localroute.Caller, data any) (any, error) {
	var req molten.MaterialsRequest
	if err := utilfn.ReUnmarshal(&req, data); err != nil {
		return nil, err
	}
	if caller.IsLocalTerminal && req.BlockId != caller.BlockId {
		return nil, fmt.Errorf("a terminal reads its own workspace's materials only")
	}
	r := l.r
	switch command {
	case molten.MaterialsListCommand:
		key, err := l.drawerOf(req, caller)
		if err != nil {
			return nil, err
		}
		return r.View(key, req.All && caller.IsUi())
	case molten.MaterialGetCommand:
		// A window may name the material alone; a terminal reads its own project's.
		if caller.IsUi() && req.BlockId == "" && req.Project == "" && req.WorkspaceId == "" {
			return r.store.Get("", req.Id)
		}
		key, err := l.drawerOf(req, caller)
		if err != nil {
			return nil, err
		}
		return r.store.Get(key, req.Id)
	case molten.MaterialAddCommand:
		source := molten.MaterialSourceDeclared
		if caller.IsUi() {
			source = molten.MaterialSourceBrought
			if req.BlockId != "" {
				return nil, fmt.Errorf("a window adds to a workspace, not to a terminal")
			}
		}
		return r.Add(req.BlockId, req.WorkspaceId, req.Target, req.Cwd, req.Title, req.Requested && caller.IsUi(), source)
	case molten.MaterialRenameCommand:
		return r.store.Rename(req.Project, req.Id, req.Title)
	case molten.MaterialPinCommand:
		return r.store.Pin(req.Project, req.Id, req.Pinned)
	case molten.MaterialDeleteCopyCommand:
		trashId, err := r.store.DeleteCopy(req.Project, req.Id)
		if err != nil {
			return nil, err
		}
		return molten.MaterialDeleted{TrashId: trashId}, nil
	case molten.MaterialRestoreCommand:
		return r.store.Restore(req.Project, req.TrashId)
	case molten.MaterialCopyCommand:
		return r.Copy(req.Project, req.Id, req.Requested, req.AllowSecret)
	case molten.MaterialWorkFilesCommand:
		key, err := l.drawerOf(req, caller)
		if err != nil {
			return nil, err
		}
		return r.store.WorkFiles(key)
	}
	return nil, fmt.Errorf("unknown materials command %q", command)
}

// drawerOf: a terminal's own workspace's drawer; a window names a drawer or a workspace.
func (l *routeLink) drawerOf(req molten.MaterialsRequest, caller localroute.Caller) (string, error) {
	if req.BlockId != "" {
		bc := l.r.context(req.BlockId)
		if bc == nil {
			return "", fmt.Errorf("no such terminal")
		}
		return bc.key, nil
	}
	if !caller.IsUi() {
		return "", fmt.Errorf("no workspace: run molten material in a MoltenTerm terminal")
	}
	if req.Project != "" {
		if !validProjectKey(req.Project) {
			return "", fmt.Errorf("invalid project key")
		}
		return req.Project, nil
	}
	if req.WorkspaceId != "" {
		info, err := l.r.workspaceInfo(req.WorkspaceId)
		if err != nil {
			return "", err
		}
		key, _ := ProjectKey(info.Project)
		return key, nil
	}
	return "", fmt.Errorf("name a workspace or a project")
}

// View is a list's answer for a drawer, with all drawers when all is set.
func (r *Registry) View(key string, all bool) (molten.MaterialsView, error) {
	list, err := r.store.List(key)
	if err != nil {
		return molten.MaterialsView{}, err
	}
	project, err := r.store.Project(key)
	if err != nil {
		return molten.MaterialsView{}, err
	}
	work, _ := r.store.WorkFiles(key)
	v := molten.MaterialsView{Project: project, Materials: list, WorkFiles: len(work), Usage: r.store.Usage(key, r.limits)}
	if all {
		v.Projects = r.store.Projects()
	}
	return v, nil
}

func publishChanged(ev molten.MaterialsChanged) {
	wps.Broker.Publish(wps.WaveEvent{Event: molten.MaterialsEvent, Scopes: []string{ev.Project}, Data: ev})
}

// StoreRoot is <data dir>/molten/materials.
func StoreRoot() string {
	return filepath.Join(wavebase.GetWaveDataDir(), "molten", "materials")
}

var defaultLock sync.Mutex
var defaultRegistry *Registry

// Default is wavesrv's registry, nil before Start.
func Default() *Registry {
	defaultLock.Lock()
	defer defaultLock.Unlock()
	return defaultRegistry
}

var startOnce sync.Once

// Start opens the registry, takes the checkpoint updater's signals and registers the route; wavesrv calls it once,
// after the checkpoint.
func Start() {
	startOnce.Do(start)
}

func start() {
	home, _ := os.UserHomeDir()
	store := MakeStore(StoreRoot())
	store.SetOnChange(publishChanged)
	r := MakeRegistry(store, home, []string{wavebase.GetWaveDataDir(), wavebase.GetWaveConfigDir()})
	r.blockInfo = readBlockInfo
	r.workspaceOf = readWorkspaceInfo
	r.runOf = attention.AgentRun
	r.readTerm = readTermOutput
	defaultLock.Lock()
	defaultRegistry = r
	defaultLock.Unlock()
	go func() {
		defer func() {
			panichandler.PanicHandler("molten:materials:run", recover())
		}()
		r.Run(make(chan struct{}))
	}()
	go sweepLoop(r)
	checkpoint.SetMaterialsSink(r.Feed)
	if _, err := localroute.Register(wshutil.DefaultRouter, (&routeLink{r: r}).route()); err != nil {
		log.Printf("molten: materials route not started: %v\n", err)
		return
	}
	rpcClient := wshclient.GetBareRpcClient()
	rpcClient.EventListener.On(wps.Event_BlockClose, func(event *wps.WaveEvent) {
		if blockId, ok := event.Data.(string); ok && blockId != "" {
			r.ForgetBlock(blockId)
		}
	})
}

func sweepLoop(r *Registry) {
	defer func() {
		panichandler.PanicHandler("molten:materials:sweep", recover())
	}()
	for {
		r.store.Sweep(r.limits.TrashKeep)
		time.Sleep(sweepInterval)
	}
}

func readWorkspaceInfo(wsId string) (BlockInfo, error) {
	ctx, cancel := context.WithTimeout(context.Background(), dbTimeout)
	defer cancel()
	ws, err := wstore.DBGet[*waveobj.Workspace](ctx, wsId)
	if err != nil {
		return BlockInfo{}, err
	}
	if ws == nil {
		return BlockInfo{}, fmt.Errorf("no such workspace")
	}
	return BlockInfo{WorkspaceId: wsId, Project: workspaceProject(ws.Meta)}, nil
}

func workspaceProject(meta waveobj.MetaMapType) string {
	project := meta.GetString(molten.ProjectMetaKey, "")
	if project != "" {
		project = filepath.Clean(wavebase.ExpandHomeDirSafe(project))
	}
	return project
}

// readBlockInfo reads a pane's workspace, its project and whether it is a remote terminal.
func readBlockInfo(blockId string) (BlockInfo, error) {
	ctx, cancel := context.WithTimeout(context.Background(), dbTimeout)
	defer cancel()
	block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
	if err != nil {
		return BlockInfo{}, err
	}
	if block == nil {
		return BlockInfo{}, fmt.Errorf("block %s not found", blockId)
	}
	conn := block.Meta.GetString(waveobj.MetaKey_Connection, "")
	remote := !(conn == "" || conn == "local" || strings.HasPrefix(conn, "local:"))
	tabId, err := wstore.DBFindTabForBlockId(ctx, blockId)
	if err != nil {
		return BlockInfo{}, err
	}
	wsId, err := wstore.DBFindWorkspaceForTabId(ctx, tabId)
	if err != nil {
		return BlockInfo{}, err
	}
	info, err := readWorkspaceInfo(wsId)
	if err != nil {
		return BlockInfo{}, err
	}
	info.Remote = remote
	return info, nil
}

// readTermOutput reads a terminal's output from an offset (its first look: the last max bytes), returning what it read,
// where that started and where the output ends now.
func readTermOutput(blockId string, from int64, max int64) ([]byte, int64, int64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), dbTimeout)
	defer cancel()
	file, err := filestore.WFS.Stat(ctx, blockId, wavebase.BlockFile_Term)
	if err != nil {
		return nil, 0, 0, err
	}
	end := file.Size
	if from <= 0 || from > end || end-from > max {
		from = end - max
	}
	if from < 0 {
		from = 0
	}
	if from >= end {
		return nil, end, end, nil
	}
	start, data, err := filestore.WFS.ReadAt(ctx, blockId, wavebase.BlockFile_Term, from, end-from)
	if err != nil {
		return nil, 0, 0, err
	}
	return data, start, start + int64(len(data)), nil
}
