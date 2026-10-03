// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// The status bar's view of the focused pane (FR-SHELL-010, DS-SHELL-010): the branch, ahead count and dirty flag of
// the pane's tree, the local CI's verdict on its HEAD and the pull request the collector knows for its branch.

const (
	PaneCommand = "moltenmissionpane"
	// NFR: git is probed at most once a second per tree, however many windows ask.
	paneMinInterval   = time.Second
	paneProbeTimeout  = 10 * time.Second
	paneProjectMaxAge = 30 * time.Second
	paneMaxTrees      = 64
)

type PaneRequest struct {
	Dir string `json:"dir"`
	// Fresh asks for a probe made after the request (a cd, a prompt back): within the 1 s window, the answer waits for
	// the window's end instead of returning the last probe.
	Fresh bool `json:"fresh,omitempty"`
}

type PanePullRequest struct {
	Number int    `json:"number"`
	Title  string `json:"title"`
	Url    string `json:"url"`
	Draft  bool   `json:"draft,omitempty"`
}

type PaneState struct {
	// The folder asked about, as sent: the panel matches answers to its request with it.
	Dir string `json:"dir"`
	// The tree's top folder; empty outside a git repository.
	Root string `json:"root,omitempty"`
	// The main checkout the tree belongs to (a worktree belongs to its repository's), where Mission Control keeps the
	// project's CI verdicts and collector snapshot.
	Project  string           `json:"project,omitempty"`
	Name     string           `json:"name,omitempty"`
	Logo     string           `json:"logo,omitempty"`
	Branch   string           `json:"branch,omitempty"`
	Sha      string           `json:"sha,omitempty"`
	Detached bool             `json:"detached,omitempty"`
	Upstream string           `json:"upstream,omitempty"`
	Ahead    int              `json:"ahead,omitempty"`
	Behind   int              `json:"behind,omitempty"`
	Dirty    bool             `json:"dirty,omitempty"`
	Ci       string           `json:"ci,omitempty"`
	Pr       *PanePullRequest `json:"pr,omitempty"`
	GitError string           `json:"giterror,omitempty"`
	At       int64            `json:"at,omitempty"`
}

type paneTree struct {
	// Held for the whole probe: requests for the same tree wait for one probe instead of starting their own.
	probeLock sync.Mutex
	state     PaneState
	probedAt  time.Time
	usedAt    time.Time
	project   string
}

type paneProject struct {
	name   string
	logo   string
	readAt time.Time
}

type Panes struct {
	lock      sync.Mutex
	run       Runner
	ci        *Ci
	collector *Collector
	now       func() time.Time
	sleep     func(time.Duration)
	trees     map[string]*paneTree
	projects  map[string]*paneProject
}

func MakePanes(run Runner, ci *Ci, collector *Collector) *Panes {
	return &Panes{
		run:       run,
		ci:        ci,
		collector: collector,
		now:       time.Now,
		sleep:     time.Sleep,
		trees:     map[string]*paneTree{},
		projects:  map[string]*paneProject{},
	}
}

func (p *Panes) treeFor(root string) *paneTree {
	p.lock.Lock()
	defer p.lock.Unlock()
	tree := p.trees[root]
	if tree == nil {
		if len(p.trees) >= paneMaxTrees {
			p.evictOldestLocked()
		}
		tree = &paneTree{}
		p.trees[root] = tree
	}
	tree.usedAt = p.now()
	return tree
}

func (p *Panes) evictOldestLocked() {
	var oldest string
	var oldestAt time.Time
	for root, tree := range p.trees {
		if oldest == "" || tree.usedAt.Before(oldestAt) {
			oldest, oldestAt = root, tree.usedAt
		}
	}
	delete(p.trees, oldest)
}

func (p *Panes) readTree(tree *paneTree) (PaneState, time.Duration, string) {
	p.lock.Lock()
	defer p.lock.Unlock()
	if tree.probedAt.IsZero() {
		return tree.state, paneMinInterval, tree.project
	}
	return tree.state, p.now().Sub(tree.probedAt), tree.project
}

func (p *Panes) writeTree(tree *paneTree, state PaneState) {
	p.lock.Lock()
	defer p.lock.Unlock()
	tree.state = state
	tree.project = state.Project
	tree.probedAt = p.now()
}

func (p *Panes) projectInfo(dir string) (string, string) {
	cached := p.cachedProject(dir)
	if cached != nil && p.now().Sub(cached.readAt) < paneProjectMaxAge {
		return cached.name, cached.logo
	}
	info := molten.ReadProject(dir)
	next := &paneProject{name: info.Name, readAt: p.now()}
	if logos := molten.FindProjectLogos(dir); len(logos) > 0 {
		next.logo = logos[0]
	}
	p.storeProject(dir, next)
	return next.name, next.logo
}

func (p *Panes) cachedProject(dir string) *paneProject {
	p.lock.Lock()
	defer p.lock.Unlock()
	return p.projects[dir]
}

func (p *Panes) storeProject(dir string, info *paneProject) {
	p.lock.Lock()
	defer p.lock.Unlock()
	p.projects[dir] = info
}

// Get answers for the tree holding dir, probing git when the last probe is older than a second.
func (p *Panes) Get(req PaneRequest) (PaneState, error) {
	if err := checkDir(req.Dir); err != nil {
		return PaneState{}, err
	}
	dir := filepath.Clean(req.Dir)
	root := molten.FindGitRoot(dir)
	if root == "" {
		name, logo := p.projectInfo(dir)
		return PaneState{Dir: req.Dir, Name: name, Logo: logo, At: p.now().UnixMilli()}, nil
	}
	tree := p.treeFor(root)
	tree.probeLock.Lock()
	defer tree.probeLock.Unlock()
	state, age, project := p.readTree(tree)
	if age < paneMinInterval {
		if !req.Fresh {
			state.Dir = req.Dir
			return state, nil
		}
		p.sleep(paneMinInterval - age)
	}
	state = p.probe(root, project)
	p.writeTree(tree, state)
	state.Dir = req.Dir
	return state, nil
}

func (p *Panes) git(ctx context.Context, dir string, args ...string) (string, error) {
	// --no-optional-locks: a status from the status bar must never hold the index lock a user's git command needs.
	out, err := p.run(ctx, dir, "git", append([]string{"--no-optional-locks"}, args...)...)
	return strings.TrimSpace(string(out)), err
}

// The main checkout keeps the path the user knows it by: git answers with symlinks resolved (/private/var on macOS),
// which would not match the workspace's linked project. Only a worktree (a .git file) asks git.
func (p *Panes) mainCheckout(ctx context.Context, root string) string {
	if info, err := os.Stat(filepath.Join(root, ".git")); err != nil || info.IsDir() {
		return root
	}
	common, err := p.git(ctx, root, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil || common == "" {
		return root
	}
	common = filepath.Clean(common)
	if filepath.Base(common) == ".git" {
		return filepath.Dir(common)
	}
	return root
}

type paneGitStatus struct {
	sha      string
	branch   string
	detached bool
	upstream string
	ahead    int
	behind   int
	dirty    bool
}

// parsePaneStatus reads `git status --porcelain=v2 --branch`.
func parsePaneStatus(out string) paneGitStatus {
	var st paneGitStatus
	for _, line := range strings.Split(out, "\n") {
		if line == "" {
			continue
		}
		if !strings.HasPrefix(line, "# ") {
			st.dirty = true
			continue
		}
		fields := strings.Fields(line[2:])
		if len(fields) < 2 {
			continue
		}
		switch fields[0] {
		case "branch.oid":
			if fields[1] != "(initial)" {
				st.sha = fields[1]
			}
		case "branch.head":
			if fields[1] == "(detached)" {
				st.detached = true
			} else {
				st.branch = fields[1]
			}
		case "branch.upstream":
			st.upstream = fields[1]
		case "branch.ab":
			if len(fields) >= 3 {
				st.ahead, _ = strconv.Atoi(strings.TrimPrefix(fields[1], "+"))
				st.behind, _ = strconv.Atoi(strings.TrimPrefix(fields[2], "-"))
			}
		}
	}
	return st
}

func (p *Panes) probe(root string, project string) PaneState {
	ctx, cancel := context.WithTimeout(context.Background(), paneProbeTimeout)
	defer cancel()
	state := PaneState{Root: root, At: p.now().UnixMilli()}
	if project == "" {
		project = p.mainCheckout(ctx, root)
	}
	state.Project = project
	state.Name, state.Logo = p.projectInfo(project)
	out, err := p.git(ctx, root, "status", "--porcelain=v2", "--branch", "--untracked-files=normal")
	if err != nil {
		state.GitError = err.Error()
		return state
	}
	st := parsePaneStatus(out)
	state.Sha, state.Branch, state.Detached = st.sha, st.branch, st.detached
	state.Upstream, state.Ahead, state.Behind, state.Dirty = st.upstream, st.ahead, st.behind, st.dirty
	if state.Sha != "" && state.Upstream == "" {
		state.Ahead = p.unpushed(ctx, root)
	}
	if p.ci != nil && state.Sha != "" {
		if verdict, err := p.ci.Status(project, state.Sha); err == nil {
			state.Ci = verdict.Status
		}
	}
	if p.collector != nil && state.Branch != "" {
		if snap, ok := p.collector.Cached(project); ok && snap.Github != nil {
			state.Pr = matchPullRequest(snap.Github.Prs, state.Branch)
		}
	}
	return state
}

// Without an upstream, the commits no remote has; nothing when the repository has no remote at all.
func (p *Panes) unpushed(ctx context.Context, root string) int {
	remotes, err := p.git(ctx, root, "remote")
	if err != nil || remotes == "" {
		return 0
	}
	out, err := p.git(ctx, root, "rev-list", "--count", "HEAD", "--not", "--remotes")
	if err != nil {
		return 0
	}
	count, _ := strconv.Atoi(out)
	return count
}

func matchPullRequest(raw json.RawMessage, branch string) *PanePullRequest {
	if len(raw) == 0 {
		return nil
	}
	var prs []struct {
		Number      int    `json:"number"`
		Title       string `json:"title"`
		Url         string `json:"url"`
		HeadRefName string `json:"headRefName"`
		IsDraft     bool   `json:"isDraft"`
	}
	if json.Unmarshal(raw, &prs) != nil {
		return nil
	}
	for _, pr := range prs {
		if pr.HeadRefName == branch {
			return &PanePullRequest{Number: pr.Number, Title: pr.Title, Url: pr.Url, Draft: pr.IsDraft}
		}
	}
	return nil
}
