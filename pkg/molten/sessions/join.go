// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package sessions builds the durable sessions (FR-SHELL-020, DS-SHELL-021): every durable terminal still running,
// local or SSH, joined with its pane, its workspace, its connection, its agent and its folder. wavesrv keeps the last
// list, publishes it when it changes (molten:sessions) and serves it with the actions on it (show, end, clean up,
// reconnect) on a router leaf. The Sessions view, Welcome back (#157) and `molten session` (#159) read this model.
package sessions

import (
	"path/filepath"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/remote/conncontroller"
	"github.com/wavetermdev/waveterm/pkg/shellexec"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const (
	jobStatusRunning    = "running"
	jobKindShell        = "shell"
	shellStateRunning   = "running-command"
	atPromptSuffix      = " at prompt"
	defaultShellName    = "shell"
	localJobCwdVarName  = "MOLTEN_JOB_CWD"
	launcherShellArgIdx = 2
)

// ProcInfo is what the local process table says of a session no pane shows: what runs in its foreground, its agent,
// its shell's folder.
type ProcInfo struct {
	Running bool
	Command string
	Agent   string
	Cwd     string
}

type HostStatus struct {
	Status string
	Error  string
}

// Snapshot is everything a build reads, gathered by a Sources; Join turns it into the list without reading anything.
type Snapshot struct {
	Jobs   []*waveobj.Job
	Blocks map[string]*waveobj.Block
	// The tab holding each block, and the workspace holding each tab.
	BlockTab     map[string]string
	Tabs         map[string]*waveobj.Tab
	TabWorkspace map[string]string
	// In Wave's order (the rail's).
	Workspaces []*waveobj.Workspace
	RTInfo     map[string]*waveobj.ObjRTInfo
	// By job: the job's route (connected, connecting, disconnected).
	JobConn map[string]string
	// By connection name.
	Hosts map[string]HostStatus
	// By job: when its output last reached MoltenTerm (Unix milliseconds).
	LastOutput map[string]int64
	// By block.
	Agents map[string]molten.AgentStateInfo
	// By job, for local sessions no pane shows.
	Procs map[string]ProcInfo
	// By folder asked (a worktree link, a shell's folder): the linked worktree it is in, nil when none.
	Worktrees map[string]*molten.SessionWorktree
}

type pane struct {
	block     *waveobj.Block
	tabId     string
	workspace *waveobj.Workspace
	wsOrder   int
	// Why the job is not in it ("" when it is).
	reason string
}

// IsLive tells whether a job is a running session: its manager runs and its command has not exited.
func IsLive(job *waveobj.Job) bool {
	if job == nil || (job.JobKind != "" && job.JobKind != jobKindShell) {
		return false
	}
	return job.JobManagerStatus == jobStatusRunning && job.CmdExitTs == 0
}

func isLocal(job *waveobj.Job) bool {
	return conncontroller.IsLocalConnName(job.Connection)
}

func workspaceIndex(s *Snapshot, wsId string) (*waveobj.Workspace, int) {
	for i, ws := range s.Workspaces {
		if ws != nil && ws.OID == wsId {
			return ws, i
		}
	}
	return nil, -1
}

// paneOf finds the pane a job shows in, or why it shows in none.
func paneOf(s *Snapshot, job *waveobj.Job) pane {
	if job.AttachedBlockId == "" {
		return pane{reason: molten.SessionReasonDetached, wsOrder: -1}
	}
	block := s.Blocks[job.AttachedBlockId]
	if block == nil {
		return pane{reason: molten.SessionReasonPaneGone, wsOrder: -1}
	}
	tabId := s.BlockTab[block.OID]
	if tabId == "" || s.Tabs[tabId] == nil {
		return pane{reason: molten.SessionReasonPaneGone, wsOrder: -1}
	}
	ws, order := workspaceIndex(s, s.TabWorkspace[tabId])
	if ws == nil {
		return pane{reason: molten.SessionReasonPaneGone, wsOrder: -1}
	}
	if block.JobId != job.OID {
		return pane{reason: molten.SessionReasonReplaced, wsOrder: -1}
	}
	return pane{block: block, tabId: tabId, workspace: ws, wsOrder: order}
}

// NeedsProcess tells whether a build reads a session's processes: a local one no pane shows (a pane has the agent
// states and the shell integration).
func NeedsProcess(s *Snapshot, job *waveobj.Job) bool {
	return IsLive(job) && isLocal(job) && job.CmdPid > 0 && paneOf(s, job).reason != ""
}

// WorktreeQueries lists the folders a build needs resolved to a worktree: the links of the panes, the folders of the
// local sessions no pane shows.
func WorktreeQueries(s *Snapshot) []string {
	seen := map[string]bool{}
	var rtn []string
	add := func(path string) {
		if path == "" || seen[path] {
			return
		}
		seen[path] = true
		rtn = append(rtn, path)
	}
	for _, job := range s.Jobs {
		if !IsLive(job) {
			continue
		}
		p := paneOf(s, job)
		if p.reason == "" {
			add(p.block.Meta.GetString(molten.WorktreeMetaKey, ""))
			continue
		}
		if isLocal(job) {
			add(procFolder(s, job))
		}
	}
	return rtn
}

func procFolder(s *Snapshot, job *waveobj.Job) string {
	if cwd := s.Procs[job.OID].Cwd; cwd != "" {
		return cwd
	}
	return job.CmdEnv[localJobCwdVarName]
}

// shellName names a session's shell: the shell integration's, else the shell a local job's launcher starts, else the
// job's command.
func shellName(job *waveobj.Job, rt *waveobj.ObjRTInfo) string {
	if rt != nil && rt.ShellType != "" {
		return rt.ShellType
	}
	if isLocal(job) && len(job.CmdArgs) > launcherShellArgIdx {
		return filepath.Base(job.CmdArgs[launcherShellArgIdx])
	}
	if job.Cmd != "" {
		return filepath.Base(job.Cmd)
	}
	return defaultShellName
}

func joinOne(s *Snapshot, job *waveobj.Job) molten.DurableSession {
	ds := molten.DurableSession{
		Id:             job.OID,
		ShortId:        molten.ShortSessionId(job.OID),
		Connection:     job.Connection,
		StartedAt:      job.CmdStartTs,
		LastOutputAt:   s.LastOutput[job.OID],
		WorkspaceOrder: -1,
		CanEnd:         true,
	}
	local := isLocal(job)
	if local {
		ds.Connection = ""
	}
	host := s.Hosts[job.Connection]
	ds.ConnState = molten.SessionConnState(local, host.Status, s.JobConn[job.OID])
	if !local && ds.ConnState != molten.SessionConnConnected {
		ds.ConnError = host.Error
	}

	p := paneOf(s, job)
	ds.Shown = p.reason == ""
	ds.Reason = p.reason
	if job.TerminateOnReconnect {
		ds.Reason = molten.SessionReasonEnding
	} else if local && !shellexec.LocalJobCompatible(job) {
		ds.Reason = molten.SessionReasonOlderVersion
	}
	ds.CanShow = ds.Reason != molten.SessionReasonOlderVersion && ds.Reason != molten.SessionReasonEnding
	// An end that failed (its host unreachable, or a local error) can always be asked again.

	if ds.Shown {
		fillShown(s, job, p, &ds)
	} else {
		fillHidden(s, job, &ds)
	}
	return ds
}

func fillShown(s *Snapshot, job *waveobj.Job, p pane, ds *molten.DurableSession) {
	ds.WorkspaceId = p.workspace.OID
	ds.WorkspaceName = p.workspace.Name
	ds.WorkspaceColor = p.workspace.Color
	ds.WorkspaceOrder = p.wsOrder
	ds.TabId = p.tabId
	ds.TabName = s.Tabs[p.tabId].Name
	ds.BlockId = p.block.OID
	ds.Folder = p.block.Meta.GetString(waveobj.MetaKey_CmdCwd, "")
	if link := p.block.Meta.GetString(molten.WorktreeMetaKey, ""); link != "" {
		ds.Worktree = s.Worktrees[link]
		if ds.Worktree == nil {
			ds.Worktree = &molten.SessionWorktree{Path: link}
		}
	}
	if info, ok := s.Agents[p.block.OID]; ok && !info.Cleared && info.Agent != "" {
		ds.Agent = info.Agent
		ds.AgentName = info.AgentName
		ds.AgentState = info.State
	}
	rt := s.RTInfo[p.block.OID]
	if rt != nil && rt.ShellState == shellStateRunning && rt.ShellLastCmd != "" {
		ds.Command = rt.ShellLastCmd
	} else if cmd := p.block.Meta.GetString(waveobj.MetaKey_Cmd, ""); cmd != "" {
		ds.Command = cmd
	} else {
		ds.Command = shellName(job, rt) + atPromptSuffix
	}
}

// fillHidden: no hook reaches a session no pane shows, so its agent is the process tree's, idle; a remote one says
// only its command.
func fillHidden(s *Snapshot, job *waveobj.Job, ds *molten.DurableSession) {
	if !isLocal(job) {
		ds.Command = filepath.Base(job.Cmd)
		if ds.Command == "" || ds.Command == "." {
			ds.Command = defaultShellName
		}
		return
	}
	proc := s.Procs[job.OID]
	ds.Folder = procFolder(s, job)
	ds.Worktree = s.Worktrees[ds.Folder]
	if proc.Agent != "" {
		ds.Agent = proc.Agent
		ds.AgentName = molten.AgentDisplayName(proc.Agent)
		ds.AgentState = molten.AgentStateIdle
	}
	if proc.Running && proc.Command != "" {
		ds.Command = proc.Command
	} else {
		ds.Command = shellName(job, nil) + atPromptSuffix
	}
}

// Join builds the list of live sessions, in the rail's order of their workspaces (sessions no pane shows last), then
// oldest first.
func Join(s *Snapshot) molten.DurableSessionsData {
	rtn := molten.DurableSessionsData{Sessions: []molten.DurableSession{}}
	for _, job := range s.Jobs {
		if !IsLive(job) {
			continue
		}
		ds := joinOne(s, job)
		if ds.Agent != "" {
			rtn.RunningAgents++
		}
		rtn.Sessions = append(rtn.Sessions, ds)
	}
	sort.SliceStable(rtn.Sessions, func(i, j int) bool {
		a, b := rtn.Sessions[i], rtn.Sessions[j]
		if a.WorkspaceOrder != b.WorkspaceOrder {
			if a.WorkspaceOrder < 0 || b.WorkspaceOrder < 0 {
				return b.WorkspaceOrder < 0
			}
			return a.WorkspaceOrder < b.WorkspaceOrder
		}
		if a.StartedAt != b.StartedAt {
			return a.StartedAt < b.StartedAt
		}
		return strings.Compare(a.Id, b.Id) < 0
	})
	return rtn
}
