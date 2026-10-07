// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// The stored copy of a workspace's imported icon (FR-SHELL-031, DS-SHELL-038) follows the workspace: replaced, it
// leaves one file; removed or deleted with the workspace, none; a reset (#222) keeps it, as it keeps the meta.

const workspaceIconSweepTimeout = 10 * time.Second

// One import, removal or sweep at a time: two imports racing for one workspace would otherwise each delete the
// other's file.
var workspaceIconLock sync.Mutex

func withWorkspaceIconLock[T any](fn func() (T, error)) (T, error) {
	workspaceIconLock.Lock()
	defer workspaceIconLock.Unlock()
	return fn()
}

func workspaceIconName(ws *waveobj.Workspace) string {
	if ws == nil {
		return ""
	}
	return ws.Meta.GetString(molten.WorkspaceIconMetaKey, "")
}

func setWorkspaceIconMeta(ctx context.Context, workspaceId string, name string) error {
	var value any
	if name != "" {
		value = name
	}
	oref := waveobj.MakeORef(waveobj.OType_Workspace, workspaceId)
	return wstore.UpdateObjectMeta(ctx, oref, waveobj.MetaMapType{molten.WorkspaceIconMetaKey: value}, false)
}

// Copies the image at path in as the workspace's icon. The new file is written first, then the meta, then the
// previous file is deleted, so the workspace always points to a file that exists. Returns the refusal shown to the
// user ("" when imported); err is for failures that are not the image's fault.
func ImportWorkspaceIcon(ctx context.Context, workspaceId string, path string) (string, error) {
	return withWorkspaceIconLock(func() (string, error) {
		ws, err := GetWorkspace(ctx, workspaceId)
		if err != nil {
			return "", fmt.Errorf("error getting workspace: %w", err)
		}
		dir := molten.WorkspaceIconsDir()
		previous := workspaceIconName(ws)
		name, err := molten.ImportWorkspaceIconFile(dir, ws.OID, path)
		if reason := molten.IconRefusalReason(err); reason != "" {
			return reason, nil
		}
		if err != nil {
			return "", err
		}
		if err := setWorkspaceIconMeta(ctx, ws.OID, name); err != nil {
			if name != previous {
				molten.RemoveWorkspaceIconFile(dir, name)
			}
			return "", fmt.Errorf("error saving the workspace icon: %w", err)
		}
		if previous != "" && previous != name {
			if err := molten.RemoveWorkspaceIconFile(dir, previous); err != nil {
				log.Printf("error removing the previous icon %q of workspace %q: %v\n", previous, ws.OID, err)
			}
		}
		return "", nil
	})
}

// Back to the built-in icon and colour, which stayed set on the workspace throughout.
func RemoveWorkspaceIcon(ctx context.Context, workspaceId string) error {
	_, err := withWorkspaceIconLock(func() (bool, error) {
		ws, err := GetWorkspace(ctx, workspaceId)
		if err != nil {
			return false, fmt.Errorf("error getting workspace: %w", err)
		}
		previous := workspaceIconName(ws)
		if previous == "" {
			return false, nil
		}
		if err := setWorkspaceIconMeta(ctx, ws.OID, ""); err != nil {
			return false, fmt.Errorf("error saving the workspace icon: %w", err)
		}
		if err := molten.RemoveWorkspaceIconFile(molten.WorkspaceIconsDir(), previous); err != nil {
			log.Printf("error removing the icon %q of workspace %q: %v\n", previous, ws.OID, err)
		}
		return true, nil
	})
	return err
}

// Called once the workspace is gone from the database.
func moltenRemoveDeletedWorkspaceIcon(ws *waveobj.Workspace) {
	name := workspaceIconName(ws)
	if name == "" {
		return
	}
	withWorkspaceIconLock(func() (bool, error) {
		if err := molten.RemoveWorkspaceIconFile(molten.WorkspaceIconsDir(), name); err != nil {
			log.Printf("error removing the icon %q of deleted workspace %q: %v\n", name, ws.OID, err)
		}
		return true, nil
	})
}

func sweepWorkspaceIcons() {
	ctx, cancelFn := context.WithTimeout(context.Background(), workspaceIconSweepTimeout)
	defer cancelFn()
	withWorkspaceIconLock(func() (bool, error) {
		workspaces, err := wstore.DBGetAllObjsByType[*waveobj.Workspace](ctx, waveobj.OType_Workspace)
		if err != nil {
			log.Printf("error listing workspaces for the icon sweep: %v\n", err)
			return false, err
		}
		referenced := make(map[string]bool)
		for _, ws := range workspaces {
			if name := workspaceIconName(ws); name != "" {
				referenced[name] = true
			}
		}
		for _, name := range molten.SweepWorkspaceIcons(molten.WorkspaceIconsDir(), referenced) {
			log.Printf("removed unreferenced workspace icon %q\n", name)
		}
		return true, nil
	})
}

// Files left by a crash between an import and its meta, or by a workspace deleted while wavesrv was down.
func StartWorkspaceIconSweep() {
	go func() {
		defer func() {
			panichandler.PanicHandler("StartWorkspaceIconSweep", recover())
		}()
		sweepWorkspaceIcons()
	}()
}
