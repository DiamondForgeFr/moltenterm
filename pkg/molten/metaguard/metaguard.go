// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package metaguard keeps the object meta the window trusts out of a terminal's reach (NFR-FORK-001, #1821). Wave's
// GetMeta, SetMeta and WorkspaceList trust any terminal, so any agent, while MoltenTerm keeps user-trusted data in
// object meta: the workspace's project folder, bookmarks, project views and pins, the tabs' pins and views. The caller
// is read from the link a request came in on (#662), never from what the request says.
package metaguard

import (
	"fmt"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

const moltenKeyPrefix = "molten:"

// fileKeyPrefix covers the file panel's file and filter keys, which fileconfine and filesearch already confine and
// stamp with who asked (FR-FILE-001, FR-FILE-002).
const fileKeyPrefix = "molten:file"

// ProjectLinkKeys are the workspace keys `molten project link / unlink / logo` write and `molten project show` and the
// agent launch read: the only workspace meta a terminal reaches, on its own workspace.
var ProjectLinkKeys = map[string]bool{
	molten.ProjectMetaKey:                true,
	molten.ProjectRepoMetaKey:            true,
	molten.ProjectLogoMetaKey:            true,
	molten.ProjectLogoOfferMetaKey:       true,
	molten.WorkspaceRecentFoldersMetaKey: true,
}

// Caller is who asked, as the router proves it.
type Caller struct {
	// Trusted: a window, Electron main, a frontend route on the windows' websocket, or wavesrv itself.
	Trusted bool
	// Local: a terminal of this computer on its own leaf; BlockId is its block ("" when its token named none).
	Local   bool
	BlockId string
	// WorkspaceId is the workspace of BlockId, filled by the caller of CallerOf when a rule needs it.
	WorkspaceId string
}

// CallerOf reads who sent source through ingressLinkId. A remote connection, a forged source or an unknown link is
// an untrusted Caller that is not Local.
func CallerOf(router *wshutil.WshRouter, source string, ingressLinkId baseds.LinkId) Caller {
	if router == nil || source == "" || ingressLinkId == baseds.NoLinkId {
		return Caller{}
	}
	caller := localroute.Resolve(router, source, ingressLinkId)
	if caller.IsUi() {
		return Caller{Trusted: true}
	}
	if caller.IsLocalTerminal {
		return Caller{Local: true, BlockId: caller.BlockId}
	}
	// The frontend's own clients (a terminal's feblock route answering wsh, the builder) live on the windows' websocket.
	if router.IsWindowSource(ingressLinkId, source) {
		return Caller{Trusted: true}
	}
	// wavesrv's own clients are leaves of its router; no token names these routes.
	if source == wshutil.DefaultRoute || strings.HasPrefix(source, wshutil.RoutePrefix_Bare) {
		if _, ok := router.LeafSourceBlockId(ingressLinkId, source); ok {
			return Caller{Trusted: true}
		}
	}
	return Caller{}
}

func (c Caller) ownsWorkspace(workspaceId string) bool {
	return c.Local && c.BlockId != "" && c.WorkspaceId != "" && c.WorkspaceId == workspaceId
}

func sortedKeys(keys []string) string {
	sort.Strings(keys)
	return strings.Join(keys, ", ")
}

// CheckWrite tells whether c may write meta on oref, with an error naming what is refused.
func CheckWrite(c Caller, oref waveobj.ORef, meta waveobj.MetaMapType) error {
	if c.Trusted {
		return nil
	}
	switch oref.OType {
	case waveobj.OType_Workspace:
		return checkWorkspaceWrite(c, oref, meta)
	case waveobj.OType_Block:
		if c.Local && c.BlockId != "" && c.BlockId == oref.OID {
			return nil
		}
		var refused []string
		for key := range meta {
			if !strings.HasPrefix(key, moltenKeyPrefix) || strings.HasPrefix(key, molten.BrowserOpenKeyPrefix) || strings.HasPrefix(key, molten.BrowserCloseKeyPrefix) || strings.HasPrefix(key, fileKeyPrefix) {
				continue
			}
			refused = append(refused, key)
		}
		if len(refused) > 0 {
			return fmt.Errorf("refused: a terminal cannot set MoltenTerm's %s on another block (%s); the MoltenTerm window does", sortedKeys(refused), oref)
		}
		return nil
	}
	var refused []string
	for key := range meta {
		if strings.HasPrefix(key, moltenKeyPrefix) {
			refused = append(refused, key)
		}
	}
	if len(refused) > 0 {
		return fmt.Errorf("refused: a terminal cannot set MoltenTerm's %s on %s; the MoltenTerm window does", sortedKeys(refused), oref)
	}
	return nil
}

func checkWorkspaceWrite(c Caller, oref waveobj.ORef, meta waveobj.MetaMapType) error {
	if !c.ownsWorkspace(oref.OID) {
		return fmt.Errorf("refused: a terminal cannot change the meta of %s; the MoltenTerm window does (a terminal links only its own workspace to a project, with molten project link)", oref)
	}
	var refused []string
	for key := range meta {
		if !ProjectLinkKeys[key] {
			refused = append(refused, key)
		}
	}
	if len(refused) > 0 {
		return fmt.Errorf("refused: a terminal cannot set %s on its workspace; the MoltenTerm window does (a terminal sets only the project link, with molten project link)", sortedKeys(refused))
	}
	return nil
}

// ReadMeta is the meta c gets for oref: everything but a workspace's, of which a terminal reads only its own
// workspace's project link.
func ReadMeta(c Caller, oref waveobj.ORef, meta waveobj.MetaMapType) (waveobj.MetaMapType, error) {
	if c.Trusted || oref.OType != waveobj.OType_Workspace {
		return meta, nil
	}
	if !c.ownsWorkspace(oref.OID) {
		return nil, fmt.Errorf("refused: a terminal cannot read the meta of %s; it reads only its own workspace's project link (molten project show)", oref)
	}
	return projectLinkMeta(meta), nil
}

// ListedWorkspaceMeta is the meta a workspace list hands c for workspaceId: none for a terminal, but its own
// workspace's project link.
func ListedWorkspaceMeta(c Caller, workspaceId string, meta waveobj.MetaMapType) waveobj.MetaMapType {
	if c.Trusted {
		return meta
	}
	if !c.ownsWorkspace(workspaceId) {
		return nil
	}
	return projectLinkMeta(meta)
}

func projectLinkMeta(meta waveobj.MetaMapType) waveobj.MetaMapType {
	rtn := waveobj.MetaMapType{}
	for key, value := range meta {
		if ProjectLinkKeys[key] {
			rtn[key] = value
		}
	}
	return rtn
}
