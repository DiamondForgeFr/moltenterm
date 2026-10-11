// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/gitwatch"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

// The status bar's view of the focused pane (FR-SHELL-010, DS-SHELL-010): the branch, ahead count and dirty flag of
// the pane's tree, the local CI's verdict on its HEAD and the pull request the collector knows for its branch.

const (
	PaneCommand = "moltenmissionpane"
	// must match MissionPaneEvent in frontend/moltenterm-shell/pane-status.ts
	PaneEvent = "molten:mission:pane"
	// NFR: git is probed at most once a second per tree, however many windows ask.
	paneMinInterval   = time.Second
	paneProbeTimeout  = 10 * time.Second
	paneProjectMaxAge = 30 * time.Second
	paneMaxTrees      = 64
	paneMaxProjects   = 256
	paneMaxCi         = 256
	// The worktree a terminal is linked to but not in (FR-SHELL-016) only needs its branch: an older probe will do.
	paneLinkedMaxAge = 10 * time.Second
	// A watched tree (FR-PERF-011) is probed again when git changed it, on a fresh request (a prompt back, a cd), and
	// after this long for files edited outside a terminal (an editor's save, an agent's edit), which no git file shows.
	paneWatchedMaxAge = time.Minute
)

type PaneRequest struct {
	Dir string `json:"dir"`
	// Fresh asks for a probe made after the request (a cd, a prompt back): within the 1 s window, the answer waits for
	// the window's end instead of returning the last probe.
	Fresh bool `json:"fresh,omitempty"`
	// Worktree is the worktree the terminal is linked to (FR-SHELL-016): the answer says where it stands.
	Worktree string `json:"worktree,omitempty"`
}

// PaneLinked is the worktree a terminal is linked to, wherever its folder is now.
type PaneLinked struct {
	Path   string `json:"path"`
	Branch string `json:"branch,omitempty"`
	Sha    string `json:"sha,omitempty"`
	Dirty  bool   `json:"dirty,omitempty"`
	// Missing: removed outside MoltenTerm.
	Missing bool `json:"missing,omitempty"`
	// Inside: the asked folder is in the linked worktree (paths compared with symlinks resolved).
	Inside bool `json:"inside,omitempty"`
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
	Project string `json:"project,omitempty"`
	// Worktree: the tree is a linked worktree of the project, not its main tree (FR-SHELL-016).
	Worktree bool             `json:"worktree,omitempty"`
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
	Linked   *PaneLinked      `json:"linked,omitempty"`
}

type paneTree struct {
	// Held for the whole probe: requests for the same tree wait for one probe instead of starting their own.
	probeLock sync.Mutex
	state     PaneState
	probedAt  time.Time
	// When the last probe started: a fresh request is answered by any probe started after it arrived.
	startedAt time.Time
	usedAt    time.Time
	// Read once per tree, when git answered: a tree does not turn from main tree to worktree under the same path.
	project  string
	worktree bool
	// The watch's change sequence when the last probe started; watched is false for a tree probed without a watch.
	seq     uint64
	watched bool
	// The commits no remote has (a branch without upstream), with the HEAD and the sequence they were counted at.
	unpushed paneUnpushed
}

type paneUnpushed struct {
	count int
	sha   string
	seq   uint64
	known bool
}

type paneProject struct {
	name   string
	logo   string
	readAt time.Time
}

type paneCiKey struct {
	project string
	sha     string
}

type Panes struct {
	lock      sync.Mutex
	run       Runner
	ci        *Ci
	collector *Collector
	watch     *gitwatch.Watcher
	now       func() time.Time
	sleep     func(time.Duration)
	trees     map[string]*paneTree
	projects  map[string]*paneProject
	// The local CI's verdict by project and commit: it changes only when a CI run ends (CiChanged).
	ciVerdicts map[paneCiKey]string
}

func MakePanes(run Runner, ci *Ci, collector *Collector) *Panes {
	return &Panes{
		run:        run,
		ci:         ci,
		collector:  collector,
		now:        time.Now,
		sleep:      time.Sleep,
		trees:      map[string]*paneTree{},
		projects:   map[string]*paneProject{},
		ciVerdicts: map[paneCiKey]string{},
	}
}

// UseWatcher makes the panes answer from their last probe until the watch sees git change the tree (FR-PERF-011).
func (p *Panes) UseWatcher(watch *gitwatch.Watcher) {
	p.watch = watch
}

func (p *Panes) track(root string) (uint64, bool) {
	if p.watch == nil {
		return 0, false
	}
	return p.watch.Track(root)
}

// CiChanged forgets the verdicts known for a project: one of its CI runs ended.
func (p *Panes) CiChanged(project string) {
	p.lock.Lock()
	defer p.lock.Unlock()
	for key := range p.ciVerdicts {
		if key.project == project {
			delete(p.ciVerdicts, key)
		}
	}
}

func (p *Panes) cachedCi(key paneCiKey) (string, bool) {
	p.lock.Lock()
	defer p.lock.Unlock()
	verdict, ok := p.ciVerdicts[key]
	return verdict, ok
}

func (p *Panes) storeCi(key paneCiKey, verdict string) {
	p.lock.Lock()
	defer p.lock.Unlock()
	if len(p.ciVerdicts) >= paneMaxCi {
		p.ciVerdicts = map[paneCiKey]string{}
	}
	p.ciVerdicts[key] = verdict
}

func (p *Panes) ciVerdict(project string, sha string) string {
	if p.ci == nil || sha == "" {
		return ""
	}
	key := paneCiKey{project: project, sha: sha}
	if verdict, ok := p.cachedCi(key); ok {
		return verdict
	}
	verdict := ""
	if v, err := p.ci.Status(project, sha); err == nil {
		verdict = v.Status
	}
	p.storeCi(key, verdict)
	return verdict
}

// publishPaneChanged tells the status bars that git changed a tree: they ask again at once (FR-PERF-011-AC2).
func publishPaneChanged(root string) {
	wps.Broker.Publish(wps.WaveEvent{
		Event:  PaneEvent,
		Scopes: []string{root},
		Data:   map[string]string{"root": root},
	})
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
		// A tree being probed stays: a second entry for the same root would probe beside it.
		if !tree.probeLock.TryLock() {
			continue
		}
		tree.probeLock.Unlock()
		if oldest == "" || tree.usedAt.Before(oldestAt) {
			oldest, oldestAt = root, tree.usedAt
		}
	}
	if oldest != "" {
		delete(p.trees, oldest)
	}
}

type paneTreeKind struct {
	project  string
	worktree bool
}

type paneTreeRead struct {
	state     PaneState
	age       time.Duration
	startedAt time.Time
	kind      paneTreeKind
	seq       uint64
	watched   bool
	unpushed  paneUnpushed
}

func (p *Panes) readTree(tree *paneTree) paneTreeRead {
	p.lock.Lock()
	defer p.lock.Unlock()
	read := paneTreeRead{
		state:     tree.state,
		startedAt: tree.startedAt,
		kind:      paneTreeKind{project: tree.project, worktree: tree.worktree},
		seq:       tree.seq,
		watched:   tree.watched,
		unpushed:  tree.unpushed,
	}
	if tree.probedAt.IsZero() {
		read.age = time.Duration(1<<63 - 1)
		return read
	}
	read.age = p.now().Sub(tree.probedAt)
	return read
}

func (p *Panes) writeTree(tree *paneTree, probe paneProbe, startedAt time.Time, seq uint64, watched bool) {
	p.lock.Lock()
	defer p.lock.Unlock()
	tree.state = probe.state
	if probe.kindKnown {
		tree.project = probe.state.Project
		tree.worktree = probe.state.Worktree
	}
	tree.startedAt = startedAt
	tree.probedAt = p.now()
	tree.seq, tree.watched = seq, watched
	tree.unpushed = probe.unpushed
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
	if _, known := p.projects[dir]; !known && len(p.projects) >= paneMaxProjects {
		p.evictOldestProjectLocked()
	}
	p.projects[dir] = info
}

func (p *Panes) evictOldestProjectLocked() {
	var oldest string
	var oldestAt time.Time
	for dir, info := range p.projects {
		if oldest == "" || info.readAt.Before(oldestAt) {
			oldest, oldestAt = dir, info.readAt
		}
	}
	delete(p.projects, oldest)
}

// Get answers for the tree holding dir, probing git when the last probe is older than a second.
func (p *Panes) Get(req PaneRequest) (PaneState, error) {
	if err := checkDir(req.Dir); err != nil {
		return PaneState{}, err
	}
	state := p.getTree(filepath.Clean(req.Dir), req.Fresh, paneMinInterval)
	state.Dir = req.Dir
	p.addAnswerTime(&state)
	if req.Worktree != "" && filepath.IsAbs(req.Worktree) {
		// The first tree's lock is released by now: two terminals linked crosswise wait for no one.
		state.Linked = p.linked(filepath.Clean(req.Worktree), state)
	}
	return state, nil
}

// addAnswerTime adds what changes without git touching the tree, read on every answer: the local CI's verdict on the
// HEAD and the pull request the collector knows for the branch (both cached: no git for them).
func (p *Panes) addAnswerTime(state *PaneState) {
	if state.Root == "" || state.GitError != "" {
		return
	}
	state.Ci = p.ciVerdict(state.Project, state.Sha)
	state.Pr = nil
	if p.collector != nil && state.Branch != "" {
		if snap, ok := p.collector.Cached(state.Project); ok && snap.Github != nil {
			state.Pr = matchPullRequest(snap.Github.Prs, state.Branch)
		}
	}
}

// upToDate tells whether the last probe still answers a plain request: without a watch, while it is younger than
// maxAge; with one, while git changed nothing in the tree and it is younger than paneWatchedMaxAge.
func upToDate(read paneTreeRead, seq uint64, watched bool, maxAge time.Duration) bool {
	if watched && read.watched {
		return read.seq == seq && read.age < paneWatchedMaxAge
	}
	return read.age < maxAge
}

// getTree answers from a probe still up to date; fresh asks for a probe started after the request, and requests
// waiting together share one.
func (p *Panes) getTree(dir string, fresh bool, maxAge time.Duration) PaneState {
	root := molten.FindGitRoot(dir)
	if root == "" {
		name, logo := p.projectInfo(dir)
		return PaneState{Name: name, Logo: logo, At: p.now().UnixMilli()}
	}
	asked := p.now()
	tree := p.treeFor(root)
	tree.probeLock.Lock()
	defer tree.probeLock.Unlock()
	read := p.readTree(tree)
	if fresh && !read.startedAt.IsZero() && !read.startedAt.Before(asked) {
		return read.state
	}
	seq, watched := p.track(root)
	if !fresh && upToDate(read, seq, watched, maxAge) {
		return read.state
	}
	if read.age < paneMinInterval {
		p.sleep(paneMinInterval - read.age)
		// git may have changed the tree meanwhile: the probe answers for the sequence it starts at.
		seq, watched = p.track(root)
	}
	startedAt := p.now()
	probe := p.probe(root, read, seq, watched)
	p.writeTree(tree, probe, startedAt, seq, watched)
	return probe.state
}

// linked describes the worktree a terminal is linked to: the tree just read when the terminal is in it, the cached
// probe of the worktree otherwise. A worktree removed outside MoltenTerm is missing: a stat, no git.
func (p *Panes) linked(path string, current PaneState) *PaneLinked {
	if molten.WorktreeMissing(path) {
		return &PaneLinked{Path: path, Missing: true}
	}
	inside := current.Root != "" && realPath(current.Root) == realPath(path)
	state := current
	if !inside {
		state = p.getTree(path, false, paneLinkedMaxAge)
	}
	if state.Root == "" || realPath(state.Root) != realPath(path) || !state.Worktree {
		return &PaneLinked{Path: path, Missing: true}
	}
	branch := state.Branch
	if branch == "" && state.Detached {
		branch = shortSha(state.Sha)
	}
	return &PaneLinked{Path: path, Branch: branch, Sha: state.Sha, Dirty: state.Dirty, Inside: inside}
}

func (p *Panes) git(ctx context.Context, dir string, args ...string) (string, error) {
	// --no-optional-locks: a status from the status bar must never hold the index lock a user's git command needs.
	out, err := p.run(ctx, dir, "git", append([]string{"--no-optional-locks"}, args...)...)
	return strings.TrimSpace(string(out)), err
}

// The main checkout keeps the path the user knows it by: git answers with symlinks resolved (/private/var on macOS),
// which would not match the workspace's linked project. Only a worktree or a submodule (a .git file) asks git, and git
// tells them apart (FR-SHELL-016): a linked worktree's git folder is not its common folder.
// The second result tells whether git answered: a failed answer is not kept, the next probe asks again.
func (p *Panes) mainCheckout(ctx context.Context, root string) (paneTreeKind, bool) {
	if !molten.IsWorktreeCheckout(root) {
		return paneTreeKind{project: root}, true
	}
	// The .git file and the worktree's commondir file say what rev-parse would, without a process (FR-PERF-011).
	var common string
	var linked bool
	if dirs, err := gitwatch.ReadDirs(root); err == nil {
		common, linked = dirs.CommonDir, dirs.Linked()
	} else {
		out, err := p.git(ctx, root, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir")
		if err != nil {
			return paneTreeKind{project: root}, false
		}
		_, common, linked = molten.ParseGitDirs(out)
	}
	if !linked || filepath.Base(common) != ".git" {
		return paneTreeKind{project: root, worktree: linked}, true
	}
	return paneTreeKind{project: filepath.Dir(common), worktree: true}, true
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

type paneProbe struct {
	state     PaneState
	kindKnown bool
	unpushed  paneUnpushed
}

// probe runs git status. The commits no remote has are counted again only when the HEAD or the refs moved since they
// were, for a watched tree; on every probe otherwise.
func (p *Panes) probe(root string, read paneTreeRead, seq uint64, watched bool) paneProbe {
	ctx, cancel := context.WithTimeout(context.Background(), paneProbeTimeout)
	defer cancel()
	state := PaneState{Root: root, At: p.now().UnixMilli()}
	kind, kindKnown := read.kind, true
	if kind.project == "" {
		kind, kindKnown = p.mainCheckout(ctx, root)
	}
	project := kind.project
	state.Project = project
	state.Worktree = kind.worktree
	state.Name, state.Logo = p.projectInfo(project)
	out, err := p.git(ctx, root, "status", "--porcelain=v2", "--branch", "--untracked-files=normal")
	if err != nil {
		state.GitError = err.Error()
		return paneProbe{state: state, kindKnown: kindKnown}
	}
	st := parsePaneStatus(out)
	state.Sha, state.Branch, state.Detached = st.sha, st.branch, st.detached
	state.Upstream, state.Ahead, state.Behind, state.Dirty = st.upstream, st.ahead, st.behind, st.dirty
	var unpushed paneUnpushed
	if state.Sha != "" && state.Upstream == "" {
		last := read.unpushed
		if watched && last.known && last.sha == state.Sha && last.seq == seq {
			unpushed = last
		} else {
			unpushed = paneUnpushed{count: p.unpushed(ctx, root), sha: state.Sha, seq: seq, known: watched}
		}
		state.Ahead = unpushed.count
	}
	return paneProbe{state: state, kindKnown: kindKnown, unpushed: unpushed}
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
