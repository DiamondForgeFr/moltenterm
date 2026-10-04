// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package sessions

import (
	"context"
	"sync"
	"time"

	goproc "github.com/shirou/gopsutil/v4/process"
	"github.com/wavetermdev/waveterm/pkg/filestore"
	"github.com/wavetermdev/waveterm/pkg/jobcontroller"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/molten/proctree"
	"github.com/wavetermdev/waveterm/pkg/remote/conncontroller"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const (
	buildTimeout    = 5 * time.Second
	procReadTimeout = 2 * time.Second
	// A folder's worktree (git) is looked up again after this.
	worktreeTTL = 30 * time.Second
	// The process table is read again for a build at most this often (the tick); builds in between reuse it.
	procReuseFor      = 4 * time.Second
	worktreeCacheSize = 256
)

type worktreeEntry struct {
	info *molten.SessionWorktree
	at   time.Time
}

// worktreeCache resolves folders to their linked worktree (two git calls), at most once per folder and TTL.
type worktreeCache struct {
	lock    sync.Mutex
	entries map[string]worktreeEntry
	now     func() time.Time
	resolve func(dir string) (molten.WorktreeInfo, error)
}

func makeWorktreeCache() *worktreeCache {
	return &worktreeCache{entries: map[string]worktreeEntry{}, now: time.Now, resolve: molten.ResolveWorktree}
}

func (c *worktreeCache) cached(dir string) (*molten.SessionWorktree, bool) {
	c.lock.Lock()
	defer c.lock.Unlock()
	e, ok := c.entries[dir]
	if !ok || c.now().Sub(e.at) > worktreeTTL {
		return nil, false
	}
	return e.info, true
}

func (c *worktreeCache) put(dir string, info *molten.SessionWorktree) {
	c.lock.Lock()
	defer c.lock.Unlock()
	if len(c.entries) >= worktreeCacheSize {
		for dir, e := range c.entries {
			if c.now().Sub(e.at) > worktreeTTL {
				delete(c.entries, dir)
			}
		}
	}
	if len(c.entries) >= worktreeCacheSize {
		c.entries = map[string]worktreeEntry{}
	}
	c.entries[dir] = worktreeEntry{info: info, at: c.now()}
}

func (c *worktreeCache) get(dir string) *molten.SessionWorktree {
	if info, ok := c.cached(dir); ok {
		return info
	}
	var info *molten.SessionWorktree
	if wt, err := c.resolve(dir); err == nil {
		info = &molten.SessionWorktree{Path: wt.Path, Branch: wt.Branch}
	}
	c.put(dir, info)
	return info
}

type procKey struct {
	pid     int32
	startMs int64
}

// liveSources reads wavesrv's store, its connections, the agent states and the local process table.
type liveSources struct {
	worktrees *worktreeCache
	// The last read of the process table, by shell process (a pid and its start time).
	procLock sync.Mutex
	procAt   time.Time
	procs    map[procKey]ProcInfo
}

func makeLiveSources() *liveSources {
	return &liveSources{worktrees: makeWorktreeCache(), procs: map[procKey]ProcInfo{}}
}

func (src *liveSources) Build() (molten.DurableSessionsData, error) {
	ctx, cancel := context.WithTimeout(context.Background(), buildTimeout)
	defer cancel()
	s, err := src.snapshot(ctx)
	if err != nil {
		return molten.DurableSessionsData{}, err
	}
	return Join(s), nil
}

func parentTabId(block *waveobj.Block) string {
	oref := waveobj.ParseORefNoErr(block.ParentORef)
	if oref == nil || oref.OType != waveobj.OType_Tab {
		return ""
	}
	return oref.OID
}

func (src *liveSources) snapshot(ctx context.Context) (*Snapshot, error) {
	jobs, err := wstore.DBGetAllObjsByType[*waveobj.Job](ctx, waveobj.OType_Job)
	if err != nil {
		return nil, err
	}
	s := &Snapshot{
		Blocks:       map[string]*waveobj.Block{},
		BlockTab:     map[string]string{},
		Tabs:         map[string]*waveobj.Tab{},
		TabWorkspace: map[string]string{},
		RTInfo:       map[string]*waveobj.ObjRTInfo{},
		JobConn:      map[string]string{},
		Hosts:        map[string]HostStatus{},
		LastOutput:   map[string]int64{},
		Agents:       map[string]molten.AgentStateInfo{},
		Procs:        map[string]ProcInfo{},
		Worktrees:    map[string]*molten.SessionWorktree{},
	}
	var blockIds []string
	for _, job := range jobs {
		if !IsLive(job) {
			continue
		}
		s.Jobs = append(s.Jobs, job)
		if job.AttachedBlockId != "" {
			blockIds = append(blockIds, job.AttachedBlockId)
		}
	}
	if len(s.Jobs) == 0 {
		return s, nil
	}
	if err := src.readPanes(ctx, s, blockIds); err != nil {
		return nil, err
	}
	for _, status := range conncontroller.GetAllConnStatus() {
		s.Hosts[status.Connection] = HostStatus{Status: status.Status, Error: status.Error}
	}
	for _, job := range s.Jobs {
		s.JobConn[job.OID] = jobcontroller.GetJobConnStatus(job.OID)
		if file, err := filestore.WFS.Stat(ctx, job.OID, jobcontroller.JobOutputFileName); err == nil && file != nil {
			s.LastOutput[job.OID] = file.ModTs
		}
	}
	for _, info := range attention.AgentStatesSnapshot() {
		s.Agents[info.BlockId] = info
	}
	src.readProcs(s)
	for _, dir := range WorktreeQueries(s) {
		s.Worktrees[dir] = src.worktrees.get(dir)
	}
	return s, nil
}

func (src *liveSources) readPanes(ctx context.Context, s *Snapshot, blockIds []string) error {
	workspaces, err := wstore.DBGetAllObjsByType[*waveobj.Workspace](ctx, waveobj.OType_Workspace)
	if err != nil {
		return err
	}
	s.Workspaces = workspaces
	for _, ws := range workspaces {
		for _, tabId := range ws.TabIds {
			s.TabWorkspace[tabId] = ws.OID
		}
	}
	if len(blockIds) == 0 {
		return nil
	}
	blocks, err := wstore.DBSelectMap[*waveobj.Block](ctx, blockIds)
	if err != nil {
		return err
	}
	var tabIds []string
	for id, block := range blocks {
		s.Blocks[id] = block
		if tabId := parentTabId(block); tabId != "" {
			s.BlockTab[id] = tabId
			tabIds = append(tabIds, tabId)
		}
		s.RTInfo[id] = wstore.GetRTInfo(waveobj.MakeORef(waveobj.OType_Block, id))
	}
	if len(tabIds) == 0 {
		return nil
	}
	tabs, err := wstore.DBSelectMap[*waveobj.Tab](ctx, tabIds)
	if err != nil {
		return err
	}
	for id, tab := range tabs {
		s.Tabs[id] = tab
	}
	return nil
}

func readProcessArgs(pid int32) (string, []string) {
	ctx, cancel := context.WithTimeout(context.Background(), procReadTimeout)
	defer cancel()
	p := &goproc.Process{Pid: pid}
	exe, _ := p.ExeWithContext(ctx)
	args, _ := p.CmdlineSliceWithContext(ctx)
	return exe, args
}

func readProcessCwd(pid int32) string {
	ctx, cancel := context.WithTimeout(context.Background(), procReadTimeout)
	defer cancel()
	cwd, err := (&goproc.Process{Pid: pid}).CwdWithContext(ctx)
	if err != nil {
		return ""
	}
	return cwd
}

// readProcs reads the process table once for the local sessions no pane shows: what runs in each one's foreground
// (its process name only: a command line can hold secrets, and the list reaches every window), its agent and its
// shell's folder. Only process metadata is read, never what a process prints. Builds close together reuse the last
// read.
func (src *liveSources) readProcs(s *Snapshot) {
	var due []*waveobj.Job
	for _, job := range s.Jobs {
		if NeedsProcess(s, job) {
			due = append(due, job)
		}
	}
	if len(due) == 0 {
		return
	}
	src.procLock.Lock()
	defer src.procLock.Unlock()
	if time.Since(src.procAt) < procReuseFor {
		missing := false
		for _, job := range due {
			info, ok := src.procs[procKey{int32(job.CmdPid), job.CmdStartTs}]
			if !ok {
				missing = true
				break
			}
			s.Procs[job.OID] = info
		}
		if !missing {
			return
		}
	}
	table, err := proctree.Read()
	if err != nil {
		return
	}
	src.procAt = time.Now()
	src.procs = map[procKey]ProcInfo{}
	for _, job := range due {
		pid := int32(job.CmdPid)
		if !table.Same(pid, job.CmdStartTs) {
			continue
		}
		info := ProcInfo{Cwd: readProcessCwd(pid)}
		fg := table.Foreground(pid)
		if table.Running(pid) {
			for _, p := range fg {
				if p.Pid != pid {
					info.Running = true
					info.Command = p.Name
					break
				}
			}
		}
		if agent, ok := molten.FindAgentProcess(fg, readProcessArgs); ok {
			info.Agent = agent.Agent
		}
		src.procs[procKey{pid, job.CmdStartTs}] = info
		s.Procs[job.OID] = info
	}
}
