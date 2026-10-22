// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	gnet "github.com/shirou/gopsutil/v4/net"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/proctree"
)

// The test context of a local app shown in the browser panel (FR-BRW-017, DS-BRW-024, #962): the process listening on
// the page's port, its folder, and from there what the status bar knows of that folder (Panes.Get: the tree, its
// branch, detached or not, its commit, its changes and its PR, shared with FR-SHELL-010 and #961). The PR's state and
// CI come from the collector's cache: a navigation never calls gh. Nothing is guessed: what cannot be found is said.

const (
	TestContextCommand = "moltenmissiontestcontext"

	TestContextNotLocal  = "notlocal"
	TestContextNoProcess = "noprocess"
	TestContextNoFolder  = "nofolder"
	TestContextNoRepo    = "norepo"

	testContextListenTimeout = 5 * time.Second
	// Listeners are read at most this often per port: the panel asks on every focus and every few seconds.
	testContextListenMaxAge = 2 * time.Second
	testContextMaxPorts     = 64
)

type TestContextRequest struct {
	Url string `json:"url"`
	// The workspace's linked project: the answer says whether the app belongs to it (Reviews shows that project).
	WorkspaceDir string `json:"workspacedir,omitempty"`
	Fresh        bool   `json:"fresh,omitempty"`
}

type TestContextPr struct {
	Number int    `json:"number"`
	Title  string `json:"title"`
	Url    string `json:"url"`
	Draft  bool   `json:"draft,omitempty"`
	// The CI summary of the PR's head (ReviewCheck* states), "" when the cached PR list has no checks.
	Ci string `json:"ci,omitempty"`
}

type TestContext struct {
	Url  string `json:"url"`
	Host string `json:"host"`
	Port int    `json:"port"`
	// Known: a process listening on the port runs from a git repository.
	Known bool `json:"known"`
	// Unknown: why not, a TestContext* code the window words.
	Unknown string `json:"unknown,omitempty"`
	// The listening process; several (a dev server and its workers) name the one whose folder was used.
	Pid     int32  `json:"pid,omitempty"`
	Process string `json:"process,omitempty"`
	Cwd     string `json:"cwd,omitempty"`
	// What the status bar knows of that folder.
	Root     string         `json:"root,omitempty"`
	Project  string         `json:"project,omitempty"`
	Name     string         `json:"name,omitempty"`
	Worktree bool           `json:"worktree,omitempty"`
	Branch   string         `json:"branch,omitempty"`
	Sha      string         `json:"sha,omitempty"`
	Detached bool           `json:"detached,omitempty"`
	Dirty    bool           `json:"dirty,omitempty"`
	Ticket   int            `json:"ticket,omitempty"`
	Pr       *TestContextPr `json:"pr,omitempty"`
	// PrKnown: the collector holds the project's open PRs, so "no PR" is a fact and not a gap.
	PrKnown bool `json:"prknown,omitempty"`
	// FuturePr: a work branch with no PR yet (the Reviews view's Upcoming).
	FuturePr bool `json:"futurepr,omitempty"`
	// SameProject: the workspace's project is the checkout's repository, so Reviews can show the PR.
	SameProject bool   `json:"sameproject,omitempty"`
	GitError    string `json:"giterror,omitempty"`
	At          int64  `json:"at,omitempty"`
}

type listenAnswer struct {
	pids   []int32
	err    error
	readAt time.Time
}

type TestContexts struct {
	lock      sync.Mutex
	panes     *Panes
	collector *Collector
	listeners func(ctx context.Context, port int) ([]int32, error)
	cwd       func(pid int32) string
	exe       func(pid int32) string
	now       func() time.Time
	listens   map[int]listenAnswer
}

func MakeTestContexts(panes *Panes, collector *Collector) *TestContexts {
	return &TestContexts{
		panes:     panes,
		collector: collector,
		listeners: listeningPids,
		cwd:       proctree.Cwd,
		exe:       proctree.Exe,
		now:       time.Now,
		listens:   map[int]listenAnswer{},
	}
}

// LocalAppTarget reads the host and port of a page served on this computer: localhost, a loopback address, a
// *.localhost or *.test name (local development names). The port defaults to the scheme's.
func LocalAppTarget(raw string) (string, int, bool) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return "", 0, false
	}
	host := strings.ToLower(u.Hostname())
	if !isLocalHost(host) {
		return "", 0, false
	}
	port := 80
	if u.Scheme == "https" {
		port = 443
	}
	if p := u.Port(); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil || n <= 0 || n > 65535 {
			return "", 0, false
		}
		port = n
	}
	return host, port, true
}

func isLocalHost(host string) bool {
	if host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".test") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func (c *TestContexts) cachedListen(port int) (listenAnswer, bool) {
	c.lock.Lock()
	defer c.lock.Unlock()
	answer, ok := c.listens[port]
	return answer, ok && c.now().Sub(answer.readAt) < testContextListenMaxAge
}

func (c *TestContexts) storeListen(port int, answer listenAnswer) {
	c.lock.Lock()
	defer c.lock.Unlock()
	if _, known := c.listens[port]; !known && len(c.listens) >= testContextMaxPorts {
		c.listens = map[int]listenAnswer{}
	}
	c.listens[port] = answer
}

func (c *TestContexts) pidsOn(port int, fresh bool) ([]int32, error) {
	if !fresh {
		if answer, ok := c.cachedListen(port); ok {
			return answer.pids, answer.err
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), testContextListenTimeout)
	defer cancel()
	pids, err := c.listeners(ctx, port)
	c.storeListen(port, listenAnswer{pids: pids, err: err, readAt: c.now()})
	return pids, err
}

// Get answers for a page's URL.
func (c *TestContexts) Get(req TestContextRequest) (TestContext, error) {
	host, port, ok := LocalAppTarget(req.Url)
	answer := TestContext{Url: req.Url, Host: host, Port: port, At: c.now().UnixMilli()}
	if !ok {
		answer.Unknown = TestContextNotLocal
		return answer, nil
	}
	pids, err := c.pidsOn(port, req.Fresh)
	if err != nil || len(pids) == 0 {
		answer.Unknown = TestContextNoProcess
		return answer, nil
	}
	pid, cwd, state := c.servingFolder(pids)
	answer.Pid = pid
	answer.Process = filepath.Base(c.exe(pid))
	if answer.Process == "." {
		answer.Process = ""
	}
	answer.Cwd = cwd
	if cwd == "" {
		answer.Unknown = TestContextNoFolder
		return answer, nil
	}
	if state.Root == "" {
		answer.Unknown = TestContextNoRepo
		return answer, nil
	}
	answer.Known = true
	c.describe(&answer, state, req.WorkspaceDir)
	return answer, nil
}

// servingFolder picks, among the processes listening on the port, the first (lowest pid: the parent of its workers)
// whose folder is in a git repository, else the first whose folder could be read.
func (c *TestContexts) servingFolder(pids []int32) (int32, string, PaneState) {
	sorted := append([]int32(nil), pids...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	var firstPid int32
	var firstCwd string
	for _, pid := range sorted {
		cwd := c.cwd(pid)
		if cwd == "" || !filepath.IsAbs(cwd) {
			continue
		}
		state, err := c.panes.Get(PaneRequest{Dir: cwd})
		if err != nil {
			continue
		}
		if state.Root != "" {
			return pid, cwd, state
		}
		if firstCwd == "" {
			firstPid, firstCwd = pid, cwd
		}
	}
	if firstCwd == "" {
		return sorted[0], "", PaneState{}
	}
	return firstPid, firstCwd, PaneState{}
}

func (c *TestContexts) describe(answer *TestContext, state PaneState, workspaceDir string) {
	answer.Root, answer.Project, answer.Name, answer.Worktree = state.Root, state.Project, state.Name, state.Worktree
	answer.Branch, answer.Sha, answer.Detached, answer.Dirty = state.Branch, state.Sha, state.Detached, state.Dirty
	answer.GitError = state.GitError
	if workspaceDir != "" && filepath.IsAbs(workspaceDir) {
		answer.SameProject = realPath(workspaceDir) == realPath(state.Project)
	}
	if answer.Branch != "" {
		answer.Ticket = TicketOfBranch(state.Project, answer.Branch)
	}
	gh := c.cachedGithub(state.Project)
	// git names a worktree's main checkout with symlinks resolved (/private/tmp on macOS), the workspace by the path
	// the user linked: the collector keeps the project under the latter.
	if gh == nil && answer.SameProject {
		gh = c.cachedGithub(workspaceDir)
	}
	answer.PrKnown = gh != nil && len(gh.Prs) > 0
	pr := state.Pr
	if pr == nil && gh != nil && answer.Branch != "" {
		pr = matchPullRequest(gh.Prs, answer.Branch)
	}
	if pr != nil {
		answer.Pr = &TestContextPr{Number: pr.Number, Title: pr.Title, Url: pr.Url, Draft: pr.Draft}
		if gh != nil {
			answer.Pr.Ci = cachedPrCi(gh.Prs, pr.Number)
		}
		return
	}
	answer.FuturePr = answer.PrKnown && answer.Branch != "" && !isBaseBranch(state.Project, answer.Branch)
}

func (c *TestContexts) cachedGithub(project string) *GithubSnapshot {
	if c.collector == nil || project == "" {
		return nil
	}
	snap, ok := c.collector.Cached(filepath.Clean(project))
	if !ok || snap.Github == nil || snap.Github.State != GithubStateOk {
		return nil
	}
	return snap.Github
}

// isBaseBranch: the trunk, the release branch or the PR target, which PRs merge into rather than come from.
func isBaseBranch(project string, branch string) bool {
	branches := molten.ResolvedBranches(project)
	return branch == branches.Trunk || branch == branches.Release || branch == molten.PrTargetBranch(project) ||
		branch == "main" || branch == "master"
}

func cachedPrCi(raw json.RawMessage, number int) string {
	var prs []struct {
		Number            int              `json:"number"`
		StatusCheckRollup []ghReviewRollup `json:"statusCheckRollup"`
	}
	if json.Unmarshal(raw, &prs) != nil {
		return ""
	}
	for _, pr := range prs {
		if pr.Number != number {
			continue
		}
		if len(pr.StatusCheckRollup) == 0 {
			return ""
		}
		return SummarizeReviewChecks(pr.StatusCheckRollup).State
	}
	return ""
}

// listeningPids lists the processes listening on a TCP port of this computer. macOS asks lsof for that port only (the
// system's own tool; gopsutil would list every socket of every process through it); elsewhere gopsutil reads the
// system's socket table (/proc on Linux, the TCP table on Windows).
func listeningPids(ctx context.Context, port int) ([]int32, error) {
	if runtime.GOOS == "darwin" {
		return lsofListeningPids(ctx, port)
	}
	conns, err := gnet.ConnectionsWithContext(ctx, "tcp")
	if err != nil {
		return nil, err
	}
	return listenersOf(conns, port), nil
}

func listenersOf(conns []gnet.ConnectionStat, port int) []int32 {
	seen := map[int32]bool{}
	var pids []int32
	for _, conn := range conns {
		if conn.Status != "LISTEN" || int(conn.Laddr.Port) != port || conn.Pid <= 0 || seen[conn.Pid] {
			continue
		}
		seen[conn.Pid] = true
		pids = append(pids, conn.Pid)
	}
	return pids
}

func lsofListeningPids(ctx context.Context, port int) ([]int32, error) {
	lsof := "/usr/sbin/lsof"
	if _, err := exec.LookPath(lsof); err != nil {
		return nil, fmt.Errorf("lsof is not available: %w", err)
	}
	out, err := exec.CommandContext(ctx, lsof, "-nP", fmt.Sprintf("-iTCP:%d", port), "-sTCP:LISTEN", "-t").Output()
	// lsof exits 1 when nothing listens.
	if err != nil && len(out) == 0 {
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			return nil, nil
		}
		return nil, err
	}
	return parsePidLines(string(out)), nil
}

func parsePidLines(out string) []int32 {
	seen := map[int32]bool{}
	var pids []int32
	for _, line := range strings.Split(out, "\n") {
		n, err := strconv.ParseInt(strings.TrimSpace(line), 10, 32)
		if err != nil || n <= 0 || seen[int32(n)] {
			continue
		}
		seen[int32(n)] = true
		pids = append(pids, int32(n))
	}
	return pids
}
