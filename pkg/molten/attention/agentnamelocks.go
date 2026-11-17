// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package attention

import (
	"context"
	"log"
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentnames"
	"github.com/wavetermdev/waveterm/pkg/molten/projectviews"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// First names locked for a project (FR-CONT-014, DS-CONT-028, #2324). The allocator (pkg/molten/agentnames) holds the
// locks and never gives a locked name outside its project; this file reads a terminal's project, answers the windows'
// commands and keeps the locks in MoltenTerm's data folder, keyed by the project's folder and never in the project's
// own files.

const agentNamesDirName = "agentnames"

func agentNamesDir() string {
	return filepath.Join(wavebase.GetWaveDataDir(), "molten", agentNamesDirName)
}

func isLocalConnection(conn string) bool {
	return conn == "" || conn == "local" || strings.HasPrefix(conn, "local:")
}

// projectOfBlock is the project folder of a located terminal, "" for a terminal that is not local: its folder is
// another machine's.
func projectOfBlock(blockId string, wsId string) string {
	ctx, cancel := context.WithTimeout(context.Background(), agentLocateTimeout)
	defer cancel()
	block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
	if err != nil || block == nil || !isLocalConnection(block.Meta.GetString(waveobj.MetaKey_Connection, "")) {
		return ""
	}
	folder := block.Meta.GetString(waveobj.MetaKey_CmdCwd, "")
	if folder != "" {
		folder = filepath.Clean(wavebase.ExpandHomeDirSafe(folder))
	}
	var wsMeta waveobj.MetaMapType
	if wsId != "" {
		if ws, err := wstore.DBGet[*waveobj.Workspace](ctx, wsId); err == nil && ws != nil {
			wsMeta = ws.Meta
		}
	}
	return projectKeyOf(folder, wsMeta)
}

// projectKeyOf is the key a terminal's agent is locked names under: the repository the folder's workspace project works
// on (its folder when it has none of its own, as the Project sheet keeps the project's agent), so two projects that
// share a folder stay apart (#1777); else molten.ProjectDirOf, the rule the hand-offs name an agent's project by: the
// workspace's project when the folder is in it, else the folder's git root, else the folder.
func projectKeyOf(folder string, wsMeta waveobj.MetaMapType) string {
	if folder == "" {
		return molten.WorkspaceRepo(wsMeta)
	}
	projects := projectviews.ReadProjects(wsMeta)
	if id := projectviews.ProjectOfDir(projects, folder); id != "" {
		if p, ok := projectviews.FindProject(projects, id); ok && p.Dir != "" {
			return filepath.Clean(molten.ProjectRepoOf(p.Dir, p.Repo))
		}
	}
	return molten.ProjectDirOf(folder, wsMeta.GetString(molten.ProjectMetaKey, ""))
}

func publishAgentNameLocks() {
	wps.Broker.Publish(wps.WaveEvent{Event: molten.AgentNameLocksEvent})
}

// loadAgentNameLocks reads the locked names kept in the data folder. A read that fails is logged and leaves every name
// unlocked.
func loadAgentNameLocks(a *agentStates) {
	a.useNameStore(agentnames.MakeLockStore(agentNamesDir()))
}

func (a *agentStates) useNameStore(store *agentnames.LockStore) {
	locks, err := store.Load()
	if err != nil {
		log.Printf("molten: reading the locked first names: %v\n", err)
	}
	a.locksLock.Lock()
	defer a.locksLock.Unlock()
	a.nameStore = store
	a.names.SetLocks(locks)
}

func (a *agentStates) saveLocksLocked() error {
	if a.nameStore == nil {
		return nil
	}
	return a.nameStore.Save(a.names.Locks())
}

func (a *agentStates) nameLocksResult() molten.AgentNameLocksResult {
	locks := a.names.Locks()
	rtn := molten.AgentNameLocksResult{Locks: make([]molten.AgentNameLock, len(locks))}
	for i, l := range locks {
		rtn.Locks[i] = molten.AgentNameLock{Name: l.Name, Project: l.Project}
	}
	return rtn
}

func (a *agentStates) markNameHolders(names []string) {
	a.lock.Lock()
	defer a.lock.Unlock()
	for blockId, rec := range a.records {
		for _, name := range names {
			if strings.EqualFold(rec.firstName, name) {
				a.markDirtyLocked(blockId)
			}
		}
	}
}

// lockedNamesChanged republishes the agents that hold a name whose lock changed (their lock mark follows) and tells the
// windows to read the list again.
func (a *agentStates) lockedNamesChanged(names ...string) {
	a.markNameHolders(names)
	if a.onLocks != nil {
		a.onLocks()
	}
}

// nameAndProjectOf is the first name and the project of the agent in a terminal, "" for both when it has none.
func (a *agentStates) nameAndProjectOf(blockId string) (name string, project string) {
	a.lock.Lock()
	defer a.lock.Unlock()
	if rec := a.records[blockId]; rec != nil {
		return rec.firstName, rec.project
	}
	return "", ""
}

// lockName locks the first name of the agent in a terminal for that agent's project. The name and the project are the
// ones this process holds for the agent: a window only says which terminal.
func (a *agentStates) lockName(req molten.AgentNameLockRequest) molten.AgentNameLockResult {
	name, project := a.nameAndProjectOf(req.BlockId)
	if name == "" {
		return molten.AgentNameLockResult{Status: molten.AgentNameLockNoAgent}
	}
	if project == "" {
		return molten.AgentNameLockResult{Status: molten.AgentNameLockNoProject, Name: name}
	}
	a.locksLock.Lock()
	defer a.locksLock.Unlock()
	before := a.names.Locks()
	res := a.names.Lock(name, project, req.Move)
	rtn := molten.AgentNameLockResult{Name: res.Name, Project: project, From: res.From}
	switch res.Status {
	case agentnames.LockInvalid:
		rtn.Status, rtn.Name = molten.AgentNameLockNotLockable, name
		return rtn
	case agentnames.LockAlready:
		rtn.Status = molten.AgentNameLockAlready
		return rtn
	case agentnames.LockElsewhere:
		rtn.Status = molten.AgentNameLockElsewhere
		return rtn
	}
	if err := a.saveLocksLocked(); err != nil {
		log.Printf("molten: keeping the locked first names: %v\n", err)
		a.names.SetLocks(before)
		rtn.Status, rtn.From = molten.AgentNameLockFailed, ""
		return rtn
	}
	rtn.Status = molten.AgentNameLockDone
	a.lockedNamesChanged(res.Name)
	return rtn
}

// unlockName frees a locked name: the next draw may give it to anyone. An agent that holds it keeps it until its
// session ends.
func (a *agentStates) unlockName(req molten.AgentNameUnlockRequest) molten.AgentNameUnlockResult {
	a.locksLock.Lock()
	defer a.locksLock.Unlock()
	before := a.names.Locks()
	removed, ok := a.names.Unlock(req.Name)
	if !ok {
		return molten.AgentNameUnlockResult{Status: molten.AgentNameUnlockNone, Name: strings.TrimSpace(req.Name)}
	}
	if err := a.saveLocksLocked(); err != nil {
		log.Printf("molten: keeping the locked first names: %v\n", err)
		a.names.SetLocks(before)
		return molten.AgentNameUnlockResult{Status: molten.AgentNameUnlockFailed, Name: removed.Name}
	}
	a.lockedNamesChanged(removed.Name)
	return molten.AgentNameUnlockResult{Status: molten.AgentNameUnlockDone, Name: removed.Name}
}

// AgentNameLocks lists the locked first names, in the order they were locked (the hand-offs list the ones nobody holds,
// FR-CONT-015).
func AgentNameLocks() []molten.AgentNameLock {
	return defaultAgentStates.nameLocksResult().Locks
}
