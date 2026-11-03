// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package metaguard keeps the object meta the window trusts out of a terminal's reach (NFR-FORK-001, #1821). Wave's
// GetMeta, SetMeta and WorkspaceList trust any terminal, so any agent, while MoltenTerm keeps user-trusted data in
// object meta: the workspace's project folder, bookmarks, project views and pins, the tabs' pins and views. The caller
// is read from the link a request came in on (#662), never from what the request says.
package metaguard

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
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
	// wavesrv's own clients (its bare client, the molten routes) are leaves it registered itself, not by a token.
	if router.IsInProcessSource(ingressLinkId, source) {
		return Caller{Trusted: true}
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
		if refused := refusedBlockKeys(meta); len(refused) > 0 {
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

// refusedBlockKeys are the molten:* keys a terminal may not write on a block other than its own: all but the browser
// panel's page requests and the file panel's keys.
func refusedBlockKeys(meta waveobj.MetaMapType) []string {
	var refused []string
	for key := range meta {
		if !strings.HasPrefix(key, moltenKeyPrefix) || strings.HasPrefix(key, molten.BrowserOpenKeyPrefix) || strings.HasPrefix(key, molten.BrowserCloseKeyPrefix) || strings.HasPrefix(key, fileKeyPrefix) {
			continue
		}
		refused = append(refused, key)
	}
	return refused
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
	if folder, ok := meta[molten.ProjectMetaKey].(string); ok && tooWideProjectFolder(folder) {
		return fmt.Errorf("refused: a terminal cannot make %s the project folder (it would open the whole disk or home folder to the file panel); the MoltenTerm window does", folder)
	}
	return nil
}

// tooWideProjectFolder: the root, the home folder or any folder above it as a project would void the file panel's
// confinement (FR-FILE-001); only the window links one. Links are resolved first, and names compare without case
// where the disk ignores it (macOS, Windows), so neither a symlink to / nor /USERS gets through.
func tooWideProjectFolder(folder string) bool {
	if folder == "" {
		return false
	}
	resolved := resolvePath(folder)
	if filepath.Dir(resolved) == resolved {
		return true
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return false
	}
	home = resolvePath(home)
	for dir := home; ; dir = filepath.Dir(dir) {
		if samePath(resolved, dir) {
			return true
		}
		if filepath.Dir(dir) == dir {
			return false
		}
	}
}

// resolvePath is path made absolute and clean with its links resolved; the part that does not exist yet stays as
// written.
func resolvePath(path string) string {
	abs, err := filepath.Abs(path)
	if err != nil {
		abs = filepath.Clean(path)
	}
	if real, err := filepath.EvalSymlinks(abs); err == nil {
		return real
	}
	return abs
}

func samePath(a string, b string) bool {
	if caseInsensitiveDisk {
		return strings.EqualFold(a, b)
	}
	return a == b
}

// caseInsensitiveDisk: macOS and Windows disks ignore case by default.
var caseInsensitiveDisk = runtime.GOOS == "darwin" || runtime.GOOS == "windows"

// CheckPublish tells whether c may publish event. Every event the window trusts (object updates, configuration,
// MoltenTerm's own) is published by wavesrv alone; a terminal publishes only badges, system info and the mods
// changed notice.
func CheckPublish(c Caller, event string) error {
	if c.Trusted || UntrustedEvents[event] {
		return nil
	}
	return fmt.Errorf("refused: a terminal cannot publish %q events; wavesrv alone does", event)
}

// UntrustedEvents are the events a terminal or a remote host publishes: `wsh badge` and `wsh tabindicator`, a remote
// connection's system info and finished-process badges, and `molten mod`'s change notice (MoltenModsChangedEvent in
// cmd/wsh), which only makes the windows reload the mod list.
var UntrustedEvents = map[string]bool{
	wps.Event_Badge:      true,
	wps.Event_SysInfo:    true,
	"molten:modschanged": true,
}

// CheckSubscribe tells whether c may receive object updates for the scopes it asks: a terminal receives only its own
// workspace's blocks and tabs, never a workspace, a window or the client (their meta holds what the window trusts).
// Other events are unchanged. inOwnWorkspace tells whether a block or tab is in c's workspace.
func CheckSubscribe(c Caller, req wps.SubscriptionRequest, inOwnWorkspace func(waveobj.ORef) bool) error {
	if c.Trusted || req.Event != wps.Event_WaveObjUpdate {
		return nil
	}
	if req.AllScopes || len(req.Scopes) == 0 {
		return fmt.Errorf("refused: a terminal cannot follow every object's updates; it follows only its own workspace's blocks and tabs")
	}
	for _, scope := range req.Scopes {
		otype, oid, _ := strings.Cut(scope, ":")
		oref := waveobj.MakeORef(otype, oid)
		if oid == "" || strings.ContainsAny(scope, "*?") || (otype != waveobj.OType_Block && otype != waveobj.OType_Tab) || !c.Local || c.WorkspaceId == "" || !inOwnWorkspace(oref) {
			return fmt.Errorf("refused: a terminal cannot follow the updates of %q; it follows only its own workspace's blocks and tabs", scope)
		}
	}
	return nil
}

// CheckCreateBlock tells whether c may create a block with meta in a tab: a local terminal only in its own
// workspace's tabs, and no caller with MoltenTerm keys but the ones `molten open`, BROWSER and the file panel use.
// A remote host's workspace is unknown: it keeps Wave's `wsh view` and `wsh web open` in any tab.
func CheckCreateBlock(c Caller, tabInOwnWorkspace bool, meta waveobj.MetaMapType) error {
	if c.Trusted {
		return nil
	}
	if c.Local && !tabInOwnWorkspace {
		return fmt.Errorf("refused: a terminal cannot open a panel in another workspace's tab; the MoltenTerm window does")
	}
	var refused []string
	for _, key := range refusedBlockKeys(meta) {
		if key != molten.BrowserAskMetaKey && key != molten.BrowserKeepFocusMetaKey {
			refused = append(refused, key)
		}
	}
	if len(refused) > 0 {
		return fmt.Errorf("refused: a terminal cannot open a panel with MoltenTerm's %s; the MoltenTerm window does", sortedKeys(refused))
	}
	return nil
}

// ReadBlockMeta is the meta c gets for a block: a terminal reads another workspace's blocks without their molten:*
// keys (a browser panel's open pages, for one); a remote host, whose workspace is unknown, reads no block's.
func ReadBlockMeta(c Caller, inOwnWorkspace bool, meta waveobj.MetaMapType) waveobj.MetaMapType {
	if c.Trusted || (c.Local && inOwnWorkspace) {
		return meta
	}
	rtn := waveobj.MetaMapType{}
	for key, value := range meta {
		if !strings.HasPrefix(key, moltenKeyPrefix) {
			rtn[key] = value
		}
	}
	return rtn
}

// CheckTabOrder tells whether c may set a workspace's tab list to next: a terminal only reorders the tabs it has
// (current). Adding another workspace's tab would move that tab, and its blocks, into the terminal's workspace and
// past every own-workspace rule.
func CheckTabOrder(c Caller, current []string, next []string) error {
	if c.Trusted {
		return nil
	}
	left := map[string]int{}
	for _, id := range current {
		left[id]++
	}
	for _, id := range next {
		if left[id] == 0 {
			return fmt.Errorf("refused: a terminal can only reorder its workspace's tabs (%s is not one of them, or is listed twice); the MoltenTerm window does the rest", id)
		}
		left[id]--
	}
	if len(next) != len(current) {
		return fmt.Errorf("refused: a terminal can only reorder its workspace's tabs, not add or drop any; the MoltenTerm window does")
	}
	return nil
}

// CheckOwnWorkspace tells whether c may act on a tab or the tab list of workspaceId: a terminal only in its own.
func CheckOwnWorkspace(c Caller, workspaceId string, what string) error {
	if c.Trusted || c.ownsWorkspace(workspaceId) {
		return nil
	}
	return fmt.Errorf("refused: a terminal cannot %s outside its own workspace; the MoltenTerm window does", what)
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
