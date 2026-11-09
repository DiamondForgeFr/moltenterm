// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package sessions

import (
	"fmt"
	"strconv"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/shellexec"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const testHost = "me@box"

type world struct {
	s *Snapshot
}

func makeWorld() *world {
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
	return &world{s: s}
}

func (w *world) workspace(id string, name string, color string, tabs ...string) {
	w.s.Workspaces = append(w.s.Workspaces, &waveobj.Workspace{OID: id, Name: name, Color: color, TabIds: tabs})
	for _, tab := range tabs {
		w.s.Tabs[tab] = &waveobj.Tab{OID: tab, Name: "T " + tab}
		w.s.TabWorkspace[tab] = id
	}
}

func localJob(id string, started int64) *waveobj.Job {
	return &waveobj.Job{
		OID:              id,
		Connection:       "local",
		JobManagerStatus: "running",
		Cmd:              "/bin/zsh",
		CmdArgs:          []string{"-c", "launcher", "/bin/zsh", "-l"},
		CmdEnv:           map[string]string{shellexec.LocalJobProtocolVarName: strconv.Itoa(shellexec.LocalJobProtocol), localJobCwdVarName: "/home/me/start"},
		CmdPid:           100,
		CmdStartTs:       started,
	}
}

func remoteJob(id string, started int64) *waveobj.Job {
	return &waveobj.Job{OID: id, Connection: testHost, JobManagerStatus: "running", Cmd: "/usr/bin/bash", CmdStartTs: started}
}

// pane puts job in a new block of tab.
func (w *world) pane(job *waveobj.Job, blockId string, tab string, meta waveobj.MetaMapType) {
	job.AttachedBlockId = blockId
	w.s.Blocks[blockId] = &waveobj.Block{OID: blockId, JobId: job.OID, Meta: meta}
	w.s.BlockTab[blockId] = tab
	w.s.Jobs = append(w.s.Jobs, job)
}

func find(t *testing.T, data molten.DurableSessionsData, id string) molten.DurableSession {
	t.Helper()
	for _, s := range data.Sessions {
		if s.Id == id {
			return s
		}
	}
	t.Fatalf("session %s not in the list", id)
	return molten.DurableSession{}
}

func TestJoinShownLocalWithAgent(t *testing.T) {
	w := makeWorld()
	w.workspace("ws1", "Work", "#f00", "tab1")
	job := localJob("job-local-1", 1000)
	w.pane(job, "b1", "tab1", waveobj.MetaMapType{waveobj.MetaKey_CmdCwd: "/home/me/app", molten.WorktreeMetaKey: "/home/me/app-wt"})
	w.s.JobConn[job.OID] = "connected"
	w.s.LastOutput[job.OID] = 5000
	w.s.Agents["b1"] = molten.AgentStateInfo{BlockId: "b1", Agent: "claude", AgentName: "Claude Code", State: "waiting"}
	w.s.Worktrees["/home/me/app-wt"] = &molten.SessionWorktree{Path: "/home/me/app-wt", Branch: "feat"}
	w.s.RTInfo["b1"] = &waveobj.ObjRTInfo{ShellState: "running-command", ShellLastCmd: "claude --continue", ShellType: "zsh"}

	data := Join(w.s)
	s := find(t, data, job.OID)
	if !s.Shown || s.Reason != "" || !s.CanShow || !s.CanEnd {
		t.Fatalf("shown flags: %+v", s)
	}
	if s.Connection != "" || s.ConnState != molten.SessionConnConnected {
		t.Fatalf("local connection: %+v", s)
	}
	if s.Agent != "claude" || s.AgentName != "Claude Code" || s.AgentState != "waiting" || s.Command != "claude --continue" {
		t.Fatalf("agent and command: %+v", s)
	}
	if s.Folder != "/home/me/app" || s.Worktree == nil || s.Worktree.Branch != "feat" {
		t.Fatalf("folder and worktree: %+v", s)
	}
	if s.WorkspaceId != "ws1" || s.WorkspaceName != "Work" || s.WorkspaceColor != "#f00" || s.TabId != "tab1" || s.BlockId != "b1" || s.WorkspaceOrder != 0 {
		t.Fatalf("pane: %+v", s)
	}
	if s.StartedAt != 1000 || s.LastOutputAt != 5000 || s.ShortId != "job-loca" {
		t.Fatalf("times and id: %+v", s)
	}
	if data.RunningAgents != 1 {
		t.Fatalf("running agents: %d", data.RunningAgents)
	}
}

// #2120: a shown session's tab is recorded on its job; once the pane is gone, the session belongs to that tab's
// workspace while the tab exists, and to none once it is gone.
func TestJoinHomeWorkspaceOfPaneGoneSessions(t *testing.T) {
	t.Parallel()
	w := makeWorld()
	w.workspace("ws1", "Work", "#f00", "tab1")
	w.workspace("ws2", "Other", "#0f0", "tab2")
	shown := localJob("job-shown", 1000)
	w.pane(shown, "b1", "tab1", waveobj.MetaMapType{})
	recorded := localJob("job-recorded", 1100)
	w.pane(recorded, "b2", "tab2", waveobj.MetaMapType{})
	recorded.Meta = waveobj.MetaMapType{molten.SessionTabMetaKey: "tab2"}
	if got := TabsToRecord(w.s); len(got) != 1 || got["job-shown"] != "tab1" {
		t.Fatalf("tabs to record %v, want job-shown in tab1 only", got)
	}

	gone := localJob("job-gone", 2000)
	gone.AttachedBlockId = "b-closed"
	gone.Meta = waveobj.MetaMapType{molten.SessionTabMetaKey: "tab1"}
	tabGone := localJob("job-tabgone", 2100)
	tabGone.AttachedBlockId = "b-closed2"
	tabGone.Meta = waveobj.MetaMapType{molten.SessionTabMetaKey: "tab-closed"}
	unrecorded := localJob("job-unrecorded", 2200)
	unrecorded.AttachedBlockId = "b-closed3"
	replaced := localJob("job-replaced", 2300)
	w.pane(replaced, "b2", "tab2", waveobj.MetaMapType{})
	w.s.Blocks["b2"].JobId = recorded.OID
	w.s.Jobs = append(w.s.Jobs, gone, tabGone, unrecorded)

	data := Join(w.s)
	for id, want := range map[string]string{"job-gone": "ws1", "job-tabgone": "", "job-unrecorded": "", "job-replaced": "ws2"} {
		s := find(t, data, id)
		if s.Shown || s.WorkspaceId != "" || s.HomeWorkspaceId != want {
			t.Errorf("%s: shown %v workspace %q home %q, want home %q", id, s.Shown, s.WorkspaceId, s.HomeWorkspaceId, want)
		}
	}
	if s := find(t, data, "job-shown"); s.HomeWorkspaceId != "" || s.WorkspaceId != "ws1" {
		t.Errorf("shown session: workspace %q home %q", s.WorkspaceId, s.HomeWorkspaceId)
	}
}

// FR-BOSS-009, AC26 (#2033): Brokk's own session is no session of the developer's, so the Sessions view, the Agents and
// Sessions panels and the count of running agents never list it.
func TestJoinLeavesBrokksOwnSessionOut(t *testing.T) {
	w := makeWorld()
	w.workspace("ws1", "Work", "#f00", "tab1", "tab-brokk")
	mine := localJob("job-mine", 1000)
	w.pane(mine, "b1", "tab1", waveobj.MetaMapType{})
	w.s.Agents["b1"] = molten.AgentStateInfo{BlockId: "b1", Agent: "claude", AgentName: "Claude Code", State: "working"}
	brokk := localJob("job-brokk", 2000)
	w.pane(brokk, "b-brokk", "tab-brokk", waveobj.MetaMapType{molten.OwnSessionMetaKey: true})
	w.s.Agents["b-brokk"] = molten.AgentStateInfo{BlockId: "b-brokk", Agent: "claude", AgentName: "Claude Code", State: "working", Own: true}

	data := Join(w.s)
	if len(data.Sessions) != 1 || data.Sessions[0].Id != "job-mine" {
		t.Fatalf("sessions %+v, want the developer's only", data.Sessions)
	}
	if data.RunningAgents != 1 {
		t.Errorf("running agents %d, want his session left out of the count", data.RunningAgents)
	}
}

// After a restart the shell integration has not spoken yet: the shell is named, not "at prompt".
func TestJoinShownBeforeShellIntegration(t *testing.T) {
	w := makeWorld()
	w.workspace("ws1", "Work", "", "tab1")
	job := localJob("restored", 1)
	w.pane(job, "b1", "tab1", nil)
	if s := find(t, Join(w.s), "restored"); s.Command != "zsh" {
		t.Fatalf("command before the shell integration: %q", s.Command)
	}
}

func TestJoinShownRemote(t *testing.T) {
	w := makeWorld()
	w.workspace("ws1", "Work", "#f00", "tab1")
	job := remoteJob("job-ssh", 1000)
	w.pane(job, "b1", "tab1", waveobj.MetaMapType{waveobj.MetaKey_CmdCwd: "/srv/app", molten.WorktreeMetaKey: "/srv/gone"})
	w.s.Hosts[testHost] = HostStatus{Status: "error", Error: "dial tcp: timeout"}
	w.s.RTInfo["b1"] = &waveobj.ObjRTInfo{ShellState: "ready", ShellType: "bash"}

	s := find(t, Join(w.s), job.OID)
	if s.Connection != testHost || s.ConnState != molten.SessionConnDisconnected || s.ConnError != "dial tcp: timeout" {
		t.Fatalf("remote connection: %+v", s)
	}
	if s.Command != "bash at prompt" {
		t.Fatalf("command at the prompt: %q", s.Command)
	}
	// A link to a worktree git cannot read (removed) still shows its path.
	if s.Worktree == nil || s.Worktree.Path != "/srv/gone" || s.Worktree.Branch != "" {
		t.Fatalf("unresolved worktree: %+v", s.Worktree)
	}
}

func TestJoinReasons(t *testing.T) {
	w := makeWorld()
	w.workspace("ws1", "Work", "#f00", "tab1")

	detached := localJob("detached", 1)
	w.s.Jobs = append(w.s.Jobs, detached)

	blockGone := localJob("blockgone", 2)
	blockGone.AttachedBlockId = "nothere"
	w.s.Jobs = append(w.s.Jobs, blockGone)

	tabGone := localJob("tabgone", 3)
	w.pane(tabGone, "b-tabgone", "deadtab", nil)

	replaced := localJob("replaced", 4)
	w.pane(replaced, "b-replaced", "tab1", nil)
	w.s.Blocks["b-replaced"].JobId = "someotherjob"

	older := localJob("older", 5)
	older.CmdEnv = map[string]string{}
	w.pane(older, "b-older", "tab1", nil)

	ending := remoteJob("ending", 6)
	ending.TerminateOnReconnect = true
	w.s.Jobs = append(w.s.Jobs, ending)

	data := Join(w.s)
	want := map[string]struct {
		shown   bool
		reason  string
		canShow bool
		canEnd  bool
	}{
		"detached":  {false, molten.SessionReasonDetached, true, true},
		"blockgone": {false, molten.SessionReasonPaneGone, true, true},
		"tabgone":   {false, molten.SessionReasonPaneGone, true, true},
		"replaced":  {false, molten.SessionReasonReplaced, true, true},
		"older":     {true, molten.SessionReasonOlderVersion, false, true},
		"ending":    {false, molten.SessionReasonEnding, false, true},
	}
	for id, wnt := range want {
		s := find(t, data, id)
		if s.Shown != wnt.shown || s.Reason != wnt.reason || s.CanShow != wnt.canShow || s.CanEnd != wnt.canEnd {
			t.Fatalf("%s: got shown=%v reason=%q canshow=%v canend=%v", id, s.Shown, s.Reason, s.CanShow, s.CanEnd)
		}
	}
}

// Ended jobs and debug task jobs are no sessions.
func TestJoinExcludesEndedJobs(t *testing.T) {
	w := makeWorld()
	done := localJob("done", 1)
	done.JobManagerStatus = "done"
	exited := localJob("exited", 2)
	exited.CmdExitTs = 99
	initJob := localJob("init", 3)
	initJob.JobManagerStatus = "init"
	task := localJob("task", 4)
	task.JobKind = "task"
	w.s.Jobs = []*waveobj.Job{done, exited, initJob, task}
	if data := Join(w.s); len(data.Sessions) != 0 {
		t.Fatalf("ended jobs listed: %+v", data.Sessions)
	}
}

func TestJoinHiddenLocalFromProcesses(t *testing.T) {
	w := makeWorld()
	running := localJob("running", 1)
	atPrompt := localJob("atprompt", 2)
	unknown := localJob("unknown", 3)
	w.s.Jobs = []*waveobj.Job{running, atPrompt, unknown}
	w.s.Procs["running"] = ProcInfo{Running: true, Command: "codex --full-auto", Agent: "codex", Cwd: "/home/me/wt"}
	w.s.Procs["atprompt"] = ProcInfo{Cwd: "/home/me/plain"}
	w.s.Worktrees["/home/me/wt"] = &molten.SessionWorktree{Path: "/home/me/wt", Branch: "fix"}

	data := Join(w.s)
	s := find(t, data, "running")
	if s.Agent != "codex" || s.AgentName != "Codex" || s.AgentState != molten.AgentStateIdle || s.Command != "codex --full-auto" {
		t.Fatalf("agent from the process tree: %+v", s)
	}
	if s.Folder != "/home/me/wt" || s.Worktree == nil || s.Worktree.Branch != "fix" {
		t.Fatalf("folder from the process: %+v", s)
	}
	p := find(t, data, "atprompt")
	if p.Command != "zsh at prompt" || p.Agent != "" || p.Folder != "/home/me/plain" || p.Worktree != nil {
		t.Fatalf("at the prompt: %+v", p)
	}
	// Without the process (unreadable), the folder the job started in.
	u := find(t, data, "unknown")
	if u.Folder != "/home/me/start" {
		t.Fatalf("start folder: %+v", u)
	}
	if data.RunningAgents != 1 {
		t.Fatalf("running agents: %d", data.RunningAgents)
	}
}

func TestJoinHiddenRemoteSaysItsCommand(t *testing.T) {
	w := makeWorld()
	w.s.Jobs = []*waveobj.Job{remoteJob("r", 1)}
	s := find(t, Join(w.s), "r")
	if s.Command != "bash" || s.Folder != "" || s.Agent != "" {
		t.Fatalf("remote session no pane shows: %+v", s)
	}
}

func TestJoinOrder(t *testing.T) {
	w := makeWorld()
	w.workspace("wsA", "A", "", "ta")
	w.workspace("wsB", "B", "", "tb")
	b2 := localJob("b-new", 20)
	w.pane(b2, "bb2", "tb", nil)
	a1 := localJob("a-old", 10)
	w.pane(a1, "ba1", "ta", nil)
	hidden := localJob("hidden", 1)
	w.s.Jobs = append(w.s.Jobs, hidden)
	b1 := localJob("b-old", 5)
	w.pane(b1, "bb1", "tb", nil)

	data := Join(w.s)
	var got []string
	for _, s := range data.Sessions {
		got = append(got, s.Id)
	}
	if fmt.Sprint(got) != "[a-old b-old b-new hidden]" {
		t.Fatalf("order: %v", got)
	}
}

func TestNeedsProcessAndQueries(t *testing.T) {
	w := makeWorld()
	w.workspace("ws1", "Work", "", "tab1")
	shown := localJob("shown", 1)
	w.pane(shown, "b1", "tab1", waveobj.MetaMapType{molten.WorktreeMetaKey: "/wt"})
	hidden := localJob("hidden", 2)
	remote := remoteJob("remote", 3)
	w.s.Jobs = append(w.s.Jobs, hidden, remote)
	w.s.Procs["hidden"] = ProcInfo{Cwd: "/cwd"}

	if NeedsProcess(w.s, shown) || !NeedsProcess(w.s, hidden) || NeedsProcess(w.s, remote) {
		t.Fatalf("processes are read for the local sessions no pane shows only")
	}
	if got := fmt.Sprint(WorktreeQueries(w.s)); got != "[/wt /cwd]" {
		t.Fatalf("worktree queries: %s", got)
	}
}

func BenchmarkJoin20(b *testing.B) {
	w := makeWorld()
	var tabs []string
	for i := 0; i < 5; i++ {
		tabs = append(tabs, fmt.Sprintf("tab%d", i))
	}
	w.workspace("ws1", "Work", "#f00", tabs...)
	now := time.Now().UnixMilli()
	for i := 0; i < 20; i++ {
		job := localJob(fmt.Sprintf("job-%02d", i), now-int64(i)*1000)
		if i%4 == 3 {
			w.s.Jobs = append(w.s.Jobs, job)
			w.s.Procs[job.OID] = ProcInfo{Running: true, Command: "claude", Agent: "claude", Cwd: "/tmp"}
			continue
		}
		blockId := fmt.Sprintf("b%02d", i)
		w.pane(job, blockId, tabs[i%len(tabs)], waveobj.MetaMapType{waveobj.MetaKey_CmdCwd: "/tmp"})
		w.s.Agents[blockId] = molten.AgentStateInfo{BlockId: blockId, Agent: "claude", State: "working"}
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		Join(w.s)
	}
}
