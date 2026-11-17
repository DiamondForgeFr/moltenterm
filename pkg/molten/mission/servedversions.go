// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"context"
	"fmt"
	"net"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	gnet "github.com/shirou/gopsutil/v4/net"
	goproc "github.com/shirou/gopsutil/v4/process"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/proctree"
	"github.com/wavetermdev/waveterm/pkg/molten/projectviews"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// The versions served on this computer and the stop of one (FR-BRW-017, DS-BRW-024, #2326). The web page panel's
// version card lists every checkout a process listening on a local TCP port runs in, by the test context's own
// resolution (port → process → folder → Panes.Get), so the developer sees the versions agents serve, switches between
// them and stops one. A stop reaches the processes listening on that port inside that checkout and what they started
// inside it, never anything else, and only in a project linked to MoltenTerm.

const (
	ServedVersionsCommand = "moltenmissionservedversions"
	ServedStopCommand     = "moltenmissionservedstop"

	// The listeners could not be read (no lsof, no socket table): the card says so instead of "none".
	ServedVersionsUnreadable = "unreadable"

	// Why a stop stopped nothing, worded by the window.
	ServedStopRefusedGone           = "gone"
	ServedStopRefusedMoved          = "moved"
	ServedStopRefusedNoRepo         = "norepo"
	ServedStopRefusedUnknownProject = "unknownproject"
	ServedStopRefusedSelf           = "self"
	ServedStopRefusedAgent          = "agent"
	// The process table cannot be read (an unsupported platform, a read error): nothing tells wavesrv's own processes,
	// the agents or a reused pid apart, so nothing is stopped.
	ServedStopRefusedUnknown = "unknown"

	// A busy computer slows lsof down: the list and the stop's own reads wait longer than a navigation's lookup.
	servedListenTimeout     = 10 * time.Second
	servedStopListenTimeout = 15 * time.Second
	servedArgsTimeout       = 2 * time.Second
	// Longer than the card's 5 s poll, so a poll reuses the last read; opening the card and a stop read afresh.
	servedListenMaxAge    = 6 * time.Second
	servedKnownTimeout    = 5 * time.Second
	servedAncestorTimeout = 5 * time.Second
	servedMaxAncestors    = 256
	// The listening processes resolved per answer: a computer with more servers lists the lowest pids.
	servedMaxProcesses = 256
	servedStopGrace    = 5 * time.Second
	servedStopPoll     = 150 * time.Millisecond
)

// The debuggers' default ports (node --inspect, Delve, debugpy): a debugger is not a version of the app.
var servedDebugPorts = map[int]bool{9229: true, 2345: true, 5678: true}

type ServedVersionsRequest struct {
	// The workspace's projects as linked: each version names the one it belongs to.
	WorkspaceDirs []string `json:"workspacedirs,omitempty"`
	Fresh         bool     `json:"fresh,omitempty"`
}

type ServedServer struct {
	Port    int    `json:"port"`
	Pid     int32  `json:"pid"`
	Process string `json:"process,omitempty"`
}

// ServedVersion is a checkout with at least one listening server, described as the test context describes one.
type ServedVersion struct {
	Root     string         `json:"root"`
	Project  string         `json:"project"`
	Name     string         `json:"name,omitempty"`
	Worktree bool           `json:"worktree,omitempty"`
	Branch   string         `json:"branch,omitempty"`
	Sha      string         `json:"sha,omitempty"`
	Detached bool           `json:"detached,omitempty"`
	Dirty    bool           `json:"dirty,omitempty"`
	Ticket   int            `json:"ticket,omitempty"`
	Pr       *TestContextPr `json:"pr,omitempty"`
	FuturePr bool           `json:"futurepr,omitempty"`
	// ProjectDir: the workspace project the checkout belongs to, as linked; "" for another project.
	ProjectDir string `json:"projectdir,omitempty"`
	// Linked: a project linked to a workspace (any of them), the only ones whose servers a stop reaches.
	Linked bool `json:"linked,omitempty"`
	// Servers, by port.
	Servers []ServedServer `json:"servers"`
}

type ServedVersions struct {
	Versions []ServedVersion `json:"versions"`
	Unknown  string          `json:"unknown,omitempty"`
	At       int64           `json:"at"`
}

type ServedStopRequest struct {
	Port int    `json:"port"`
	Pid  int32  `json:"pid"`
	Root string `json:"root"`
}

type ServedStopResult struct {
	// Stopped: the processes signalled, the listeners first.
	Stopped []int32 `json:"stopped"`
	// Refused: why nothing was stopped (ServedStopRefused*); Folder: the folder the refusal names; Agent: the coding
	// agent whose own process listens there.
	Refused string `json:"refused,omitempty"`
	Folder  string `json:"folder,omitempty"`
	Agent   string `json:"agent,omitempty"`
	// Still: something listens on the port again (a supervisor started it again, or a process ignored the signals).
	Still bool `json:"still,omitempty"`
}

type listenSocket struct {
	pid  int32
	port int
}

type socketsAnswer struct {
	sockets []listenSocket
	err     error
	readAt  time.Time
}

type servedTarget struct {
	pid     int32
	startMs int64
}

// listeningSockets lists every TCP listener of this computer a page reaches by localhost (any address or a loopback
// one): lsof on macOS, the system's socket table through gopsutil elsewhere, as listeningPids does for one port.
func listeningSockets(ctx context.Context) ([]listenSocket, error) {
	if runtime.GOOS == "darwin" {
		return lsofListeningSockets(ctx)
	}
	conns, err := gnet.ConnectionsWithContext(ctx, "tcp")
	if err != nil {
		return nil, err
	}
	return socketsOf(conns), nil
}

func socketsOf(conns []gnet.ConnectionStat) []listenSocket {
	seen := map[listenSocket]bool{}
	rtn := []listenSocket{}
	for _, conn := range conns {
		s := listenSocket{pid: conn.Pid, port: int(conn.Laddr.Port)}
		if conn.Status != "LISTEN" || s.pid <= 0 || s.port <= 0 || !reachableHere(conn.Laddr.IP) || seen[s] {
			continue
		}
		seen[s] = true
		rtn = append(rtn, s)
	}
	return rtn
}

func reachableHere(ip string) bool {
	ip = strings.Trim(ip, "[]")
	if ip == "" || ip == "*" || ip == "0.0.0.0" || ip == "::" {
		return true
	}
	parsed := net.ParseIP(ip)
	return parsed != nil && parsed.IsLoopback()
}

func lsofListeningSockets(ctx context.Context) ([]listenSocket, error) {
	lsof := "/usr/sbin/lsof"
	if _, err := exec.LookPath(lsof); err != nil {
		return nil, fmt.Errorf("lsof is not available: %w", err)
	}
	out, err := exec.CommandContext(ctx, lsof, "-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pn").Output()
	// lsof exits 1 when nothing listens.
	if err != nil && len(out) == 0 {
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			return []listenSocket{}, nil
		}
		return nil, err
	}
	return parseLsofSockets(string(out)), nil
}

// parseLsofSockets reads lsof's field output: a `p<pid>` line, then an `n<address>:<port>` line per socket.
func parseLsofSockets(out string) []listenSocket {
	seen := map[listenSocket]bool{}
	rtn := []listenSocket{}
	var pid int32
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		switch line[0] {
		case 'p':
			n, err := strconv.ParseInt(line[1:], 10, 32)
			pid = 0
			if err == nil && n > 0 {
				pid = int32(n)
			}
		case 'n':
			at := strings.LastIndex(line, ":")
			if pid <= 0 || at < 1 {
				continue
			}
			port, err := strconv.Atoi(line[at+1:])
			s := listenSocket{pid: pid, port: port}
			if err != nil || port <= 0 || port > 65535 || !reachableHere(line[1:at]) || seen[s] {
				continue
			}
			seen[s] = true
			rtn = append(rtn, s)
		}
	}
	return rtn
}

// knownProjectDirs: every project folder and repository linked to a workspace (FR-SHELL-105), the projects MoltenTerm
// may stop a server of.
func knownProjectDirs(ctx context.Context) ([]string, error) {
	workspaces, err := wstore.DBGetAllObjsByType[*waveobj.Workspace](ctx, waveobj.OType_Workspace)
	if err != nil {
		return nil, err
	}
	dirs := []string{}
	for _, ws := range workspaces {
		for _, p := range projectviews.ReadProjects(ws.Meta) {
			if p.Dir != "" {
				dirs = append(dirs, p.Dir)
			}
			if repo := molten.ProjectRepoOf(p.Dir, p.Repo); repo != "" && repo != p.Dir {
				dirs = append(dirs, repo)
			}
		}
	}
	return dirs, nil
}

// agentOfProcess names the coding agent a process is (Claude Code's version-named binary, codex, an agent on node...),
// "" for any other: an agent's own port (its IDE or MCP link) is neither a version of the app nor a server to stop.
func agentOfProcess(p *proctree.Proc) string {
	if p == nil {
		return ""
	}
	found, ok := molten.FindAgentProcess([]*proctree.Proc{p}, readServedArgs)
	if !ok {
		return ""
	}
	return found.Agent
}

// The executable comes from proctree: gopsutil hands libproc a buffer on the goroutine's stack on macOS (#249).
func readServedArgs(pid int32) (string, []string) {
	ctx, cancel := context.WithTimeout(context.Background(), servedArgsTimeout)
	defer cancel()
	args, _ := (&goproc.Process{Pid: pid}).CmdlineSliceWithContext(ctx)
	return proctree.Exe(pid), args
}

func signalServed(pid int32, kill bool) error {
	if kill {
		return killProcess(int(pid))
	}
	return stopProcess(int(pid))
}

func (c *TestContexts) cachedSockets() (socketsAnswer, bool) {
	c.lock.Lock()
	defer c.lock.Unlock()
	return c.socketsAt, !c.socketsAt.readAt.IsZero() && c.now().Sub(c.socketsAt.readAt) < servedListenMaxAge
}

func (c *TestContexts) storeSockets(answer socketsAnswer) {
	c.lock.Lock()
	defer c.lock.Unlock()
	c.socketsAt = answer
}

// listenSockets: one read at a time. A caller that waited behind another read takes its answer when that read ended
// after the caller asked, so several windows' polls and fresh asks arriving together run lsof once.
func (c *TestContexts) listenSockets(fresh bool) ([]listenSocket, error) {
	asked := c.now()
	c.socketsRead.Lock()
	defer c.socketsRead.Unlock()
	if answer, ok := c.cachedSockets(); ok && (!fresh || !answer.readAt.Before(asked)) {
		return answer.sockets, answer.err
	}
	ctx, cancel := context.WithTimeout(context.Background(), servedListenTimeout)
	defer cancel()
	sockets, err := c.sockets(ctx)
	c.storeSockets(socketsAnswer{sockets: sockets, err: err, readAt: c.now()})
	return sockets, err
}

// ownProcesses: wavesrv and the processes above it (MoltenTerm's own window process): never a version, never stopped.
func (c *TestContexts) ownProcesses(table *proctree.Table) map[int32]bool {
	rtn := map[int32]bool{c.self: true}
	pid := c.self
	for i := 0; i < proctree.MaxDepth; i++ {
		p := table.Get(pid)
		if p == nil || p.Ppid <= 1 || p.Ppid == pid {
			break
		}
		pid = p.Ppid
		rtn[pid] = true
	}
	return rtn
}

func (c *TestContexts) readProcs() *proctree.Table {
	if c.procs == nil {
		return nil
	}
	table, err := c.procs()
	if err != nil {
		return nil
	}
	return table
}

// servedState is the checkout a process runs in: its folder must lie inside the tree Panes.Get found (never the one
// repository below a folder outside any, #961).
func (c *TestContexts) servedState(pid int32) (string, PaneState, bool) {
	cwd := c.cwd(pid)
	if cwd == "" || !filepath.IsAbs(cwd) {
		return cwd, PaneState{}, false
	}
	state, err := c.panes.Get(PaneRequest{Dir: cwd})
	if err != nil || state.Root == "" || state.Below || !pathInside(realPath(cwd), realPath(state.Root)) {
		return cwd, PaneState{}, false
	}
	return cwd, state, true
}

func (c *TestContexts) processName(pid int32) string {
	name := filepath.Base(c.exe(pid))
	if name == "." || name == string(filepath.Separator) {
		return ""
	}
	return name
}

// Versions lists the checkouts served on this computer, each with its servers.
func (c *TestContexts) Versions(req ServedVersionsRequest) (ServedVersions, error) {
	answer := ServedVersions{Versions: []ServedVersion{}, At: c.now().UnixMilli()}
	sockets, err := c.listenSockets(req.Fresh)
	if err != nil {
		answer.Unknown = ServedVersionsUnreadable
		return answer, nil
	}
	table := c.readProcs()
	own := c.ownProcesses(table)
	ports := map[int32][]int{}
	pids := []int32{}
	agents := map[int32]bool{}
	for _, s := range sockets {
		if own[s.pid] || agents[s.pid] || servedDebugPorts[s.port] {
			continue
		}
		if _, seen := ports[s.pid]; !seen {
			if c.agentTooling(table, s.pid) {
				agents[s.pid] = true
				continue
			}
			pids = append(pids, s.pid)
		}
		ports[s.pid] = append(ports[s.pid], s.port)
	}
	known := c.knownDirs()
	slices.Sort(pids)
	if len(pids) > servedMaxProcesses {
		pids = pids[:servedMaxProcesses]
	}
	byRoot := map[string]*ServedVersion{}
	taken := map[string]map[int]bool{}
	for _, pid := range pids {
		_, state, ok := c.servedState(pid)
		if !ok {
			continue
		}
		key := realPath(state.Root)
		version := byRoot[key]
		if version == nil {
			version = c.servedVersion(state, req.WorkspaceDirs)
			version.Linked = isKnownProject(state, known)
			byRoot[key] = version
			taken[key] = map[int]bool{}
		}
		process := c.processName(pid)
		for _, port := range ports[pid] {
			// Several processes on one port (a server and its workers): the lowest pid, the parent, names it.
			if taken[key][port] {
				continue
			}
			taken[key][port] = true
			version.Servers = append(version.Servers, ServedServer{Port: port, Pid: pid, Process: process})
		}
	}
	for _, version := range byRoot {
		sort.Slice(version.Servers, func(i, j int) bool { return version.Servers[i].Port < version.Servers[j].Port })
		answer.Versions = append(answer.Versions, *version)
	}
	sortServedVersions(answer.Versions)
	return answer, nil
}

func (c *TestContexts) servedVersion(state PaneState, workspaceDirs []string) *ServedVersion {
	projectDir := ""
	for _, dir := range workspaceDirs {
		if dir != "" && filepath.IsAbs(dir) && realPath(dir) == realPath(state.Project) {
			projectDir = dir
			break
		}
	}
	described := TestContext{}
	c.describe(&described, state, projectDir)
	return &ServedVersion{
		Root: state.Root, Project: state.Project, Name: state.Name, Worktree: state.Worktree,
		Branch: described.Branch, Sha: described.Sha, Detached: described.Detached, Dirty: described.Dirty,
		Ticket: described.Ticket, Pr: described.Pr, FuturePr: described.FuturePr, ProjectDir: projectDir,
		Servers: []ServedServer{},
	}
}

// sortServedVersions: by project, its main checkout first, then by branch.
func sortServedVersions(versions []ServedVersion) {
	sort.SliceStable(versions, func(i, j int) bool {
		a, b := versions[i], versions[j]
		if a.Project != b.Project {
			return a.Project < b.Project
		}
		if a.Worktree != b.Worktree {
			return !a.Worktree
		}
		if a.Branch != b.Branch {
			return a.Branch < b.Branch
		}
		return a.Root < b.Root
	})
}

// agentTooling: the process is a coding agent, or one an agent started itself (its MCP servers, its IDE link): an
// agent's own tooling is not a version of the app. A server an agent starts runs under the shell of its command tool,
// not directly under the agent.
func (c *TestContexts) agentTooling(table *proctree.Table, pid int32) bool {
	p := table.Get(pid)
	if c.agentOf(p) != "" {
		return true
	}
	return p != nil && p.Ppid > 1 && p.Ppid != pid && c.agentOf(table.Get(p.Ppid)) != ""
}

// knownDirs: the folders and repositories of the projects linked to a workspace; nil when they cannot be read.
func (c *TestContexts) knownDirs() []string {
	if c.known == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), servedKnownTimeout)
	defer cancel()
	dirs, err := c.known(ctx)
	if err != nil {
		return nil
	}
	return dirs
}

// isKnownProject: the checkout's repository is a project linked to MoltenTerm, or lies inside a linked project folder.
func isKnownProject(state PaneState, dirs []string) bool {
	project, root := realPath(state.Project), realPath(state.Root)
	for _, dir := range dirs {
		if dir == "" || !filepath.IsAbs(dir) {
			continue
		}
		linked := realPath(dir)
		if linked == root || pathInside(project, linked) {
			return true
		}
	}
	return false
}

// insideRoot: the process runs in the checkout (its folder resolved against symlinks).
func (c *TestContexts) insideRoot(pid int32, root string) bool {
	cwd := c.cwd(pid)
	return cwd != "" && filepath.IsAbs(cwd) && pathInside(realPath(cwd), root)
}

// Stop stops the server a version card names: the processes listening on the port inside that checkout and the
// processes they started inside it. Every check is made again on the system's state now, not on what the card showed.
func (c *TestContexts) Stop(req ServedStopRequest) (ServedStopResult, error) {
	rtn := ServedStopResult{Stopped: []int32{}}
	if req.Port <= 0 || req.Port > 65535 || req.Pid <= 0 {
		return rtn, fmt.Errorf("a server is named by its port and its process (got port %d, pid %d)", req.Port, req.Pid)
	}
	if err := checkDir(req.Root); err != nil {
		return rtn, err
	}
	pids, err := c.stopListeners(req.Port)
	if err != nil {
		return rtn, fmt.Errorf("the processes listening on port %d cannot be read: %w", req.Port, err)
	}
	// Read after the listeners: a listener the lookup found is in the table, with its start time.
	table := c.readProcs()
	if table == nil {
		rtn.Refused = ServedStopRefusedUnknown
		return rtn, nil
	}
	own := c.ownProcesses(table)
	if own[req.Pid] {
		rtn.Refused = ServedStopRefusedSelf
		return rtn, nil
	}
	if !slices.Contains(pids, req.Pid) {
		rtn.Refused = ServedStopRefusedGone
		return rtn, nil
	}
	if agent := c.agentOf(table.Get(req.Pid)); agent != "" {
		rtn.Refused, rtn.Agent = ServedStopRefusedAgent, molten.AgentDisplayName(agent)
		return rtn, nil
	}
	cwd, state, ok := c.servedState(req.Pid)
	if !ok {
		rtn.Refused, rtn.Folder = ServedStopRefusedNoRepo, cwd
		return rtn, nil
	}
	root := realPath(req.Root)
	if realPath(state.Root) != root {
		rtn.Refused, rtn.Folder = ServedStopRefusedMoved, state.Root
		return rtn, nil
	}
	if !isKnownProject(state, c.knownDirs()) {
		rtn.Refused, rtn.Folder = ServedStopRefusedUnknownProject, state.Root
		return rtn, nil
	}
	// Each target is checked again just before the signal: the same process (start time), still running.
	targets := c.running(c.stopTargets(pids, root, own, table))
	for _, target := range targets {
		if c.signal(target.pid, false) == nil {
			rtn.Stopped = append(rtn.Stopped, target.pid)
		}
	}
	c.awaitStopped(targets)
	c.storeSockets(socketsAnswer{})
	after, err := c.stopListeners(req.Port)
	rtn.Still = err == nil && len(after) > 0
	return rtn, nil
}

// stopListeners reads the port's listeners for a stop: always fresh, and waiting longer than a navigation's lookup.
func (c *TestContexts) stopListeners(port int) ([]int32, error) {
	ctx, cancel := context.WithTimeout(context.Background(), servedStopListenTimeout)
	defer cancel()
	pids, err := c.listeners(ctx, port)
	c.storeListen(port, listenAnswer{pids: pids, err: err, readAt: c.now()})
	return pids, err
}

// stopTargets: the port's listeners inside the checkout, then what they started inside it, each once, with its start
// time so a reused pid is never signalled later. A coding agent and everything below it are left alone (an agent
// running in a terminal of a code-server or of a test MoltenTerm started from the worktree), so are wavesrv's own
// processes, and a process whose start time is unknown cannot be told from a reused pid: it is left too.
func (c *TestContexts) stopTargets(pids []int32, root string, own map[int32]bool, table *proctree.Table) []servedTarget {
	seen := map[int32]bool{}
	// pruned: a process whose subtree is never walked into.
	pruned := map[int32]bool{}
	targets := []servedTarget{}
	add := func(p *proctree.Proc) bool {
		if p == nil || seen[p.Pid] {
			return false
		}
		seen[p.Pid] = true
		if own[p.Pid] || c.agentOf(p) != "" {
			pruned[p.Pid] = true
			return false
		}
		if p.StartMs <= 0 || !c.insideRoot(p.Pid, root) {
			return false
		}
		targets = append(targets, servedTarget{pid: p.Pid, startMs: p.StartMs})
		return true
	}
	listeners := append([]int32(nil), pids...)
	slices.Sort(listeners)
	served := []int32{}
	for _, pid := range listeners {
		if add(table.Get(pid)) {
			served = append(served, pid)
		}
	}
	for _, pid := range served {
		// Descendants comes nearest first: a parent is decided before its children.
		for _, kid := range table.Descendants(pid) {
			if pruned[kid.Ppid] {
				pruned[kid.Pid] = true
				continue
			}
			add(kid)
		}
	}
	return targets
}

// awaitStopped waits for the targets to end, then kills those still the same processes after the grace.
func (c *TestContexts) awaitStopped(targets []servedTarget) {
	deadline := c.now().Add(c.stopGrace)
	left := c.running(targets)
	for len(left) > 0 && c.now().Before(deadline) {
		time.Sleep(servedStopPoll)
		left = c.running(left)
	}
	if len(left) == 0 {
		return
	}
	for _, target := range c.running(left) {
		c.signal(target.pid, true)
	}
	deadline = c.now().Add(c.stopGrace)
	for len(left) > 0 && c.now().Before(deadline) {
		time.Sleep(servedStopPoll)
		left = c.running(left)
	}
}

// running: the targets still alive, each the same process as when it was found (start time) and no zombie. Without a
// readable process table none is known to be the same: none is signalled again.
func (c *TestContexts) running(targets []servedTarget) []servedTarget {
	table := c.readProcs()
	rtn := []servedTarget{}
	if table == nil {
		return rtn
	}
	for _, target := range targets {
		if target.startMs > 0 && table.Same(target.pid, target.startMs) {
			rtn = append(rtn, target)
		}
	}
	return rtn
}
