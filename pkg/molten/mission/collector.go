// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Mission Control's collector (DS-MC-001): one place in wavesrv reads git and GitHub for the linked projects, caches
// the result, and publishes it. Every tab runs its own renderer: the panels only ask and display, so a second tab
// never runs the collection twice.
package mission

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentcontinuity/checkpoint"
	"github.com/wavetermdev/waveterm/pkg/molten/agenthandoff"
	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/molten/browseragent"
	"github.com/wavetermdev/waveterm/pkg/molten/browsers"
	"github.com/wavetermdev/waveterm/pkg/molten/companion"
	"github.com/wavetermdev/waveterm/pkg/molten/gitwatch"
	"github.com/wavetermdev/waveterm/pkg/molten/railorder"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

// must match the names in frontend/moltenterm-shell/mission/mission-client.ts
const (
	RouteId                 = "molten:mission"
	GetCommand              = "moltenmissionget"
	RefreshCommand          = "moltenmissionrefresh"
	RunCommand              = "moltenmissionrun"
	RunsCommand             = "moltenmissionruns"
	LogCommand              = "moltenmissionlog"
	CancelCommand           = "moltenmissioncancel"
	CloseCommand            = "moltenmissionclose"
	TrustCommand            = "moltenmissiontrust"
	CiStateCommand          = "moltenmissioncistate"
	CiRunCommand            = "moltenmissioncirun"
	CiLogCommand            = "moltenmissioncilog"
	CiCancelCommand         = "moltenmissioncicancel"
	CiStatusCommand         = "moltenmissioncistatus"
	BuildsCommand           = "moltenmissionbuilds"
	ReleaseCommand          = "moltenmissionrelease"
	ReleaseStartCommand     = "moltenmissionreleasestart"
	ReleaseEndCommand       = "moltenmissionreleaseend"
	ReleaseFactsCommand     = "moltenmissionreleasefacts"
	ReleaseStepCommand      = "moltenmissionreleasestep"
	ReleaseRerunCommand     = "moltenmissionreleasererun"
	ReleaseNotesCommand     = "moltenmissionreleasenotes"
	ReleaseSaveCommand      = "moltenmissionreleasenotessave"
	ReleaseMilestoneCommand = "moltenmissionreleasemilestone"
	BranchesPlanCommand     = "moltenmissionbranchesplan"
	BranchesCleanCommand    = "moltenmissionbranchesclean"
	BranchesAutoDeleteCmd   = "moltenmissionbranchesautodelete"
	WorkCommand             = "moltenmissionwork"
	GitInitCommand          = "moltenmissiongitinit"
	UpdateEvent             = "molten:mission:update"
	RunEvent                = "molten:mission:run"
	CiEvent                 = "molten:mission:ci"
	DefaultMaxAgeSec        = 60
	collectTimeout          = 2 * time.Minute
	fetchEvery              = 5 * time.Minute
	minForcedInterval       = 10 * time.Second
	// NFR-MC-003: GitHub is read at most once a minute per project, however many panels ask.
	minGithubInterval = time.Minute
	// FR-PERF-011: the projects known at once (a status bar asks about every folder a terminal visits); past it, the
	// ones whose folder is gone, then the least recently asked, are forgotten (their cache file stays on disk).
	maxProjects = 64
	// A Mission Control view asks every 15 s while shown: a project asked by one this recently is re-read as soon as git
	// changes its repository.
	activeWindow = 45 * time.Second
	// A watched repository is read again without a change only to fetch (and for its tags, which are not watched).
	watchedGitMaxAge = fetchEvery
	// What keeps a linked project's pull requests known to the status bar without a Mission Control view (a passive
	// request): GitHub at most this often, git only after a change, never a fetch.
	passiveGithubInterval = 10 * time.Minute
	passiveGitMaxAge      = fetchEvery
	// The rail's Reviews counts (#688): a passive ask that reads GitHub this often, so a merge or a new PR shows
	// without opening the view.
	railGithubInterval = 2 * time.Minute
	// The programs wavesrv started for its own work since it started (FR-PERF-011), read by the performance harness.
	SpawnsCommand = "moltenmissionspawns"
)

type Snapshot struct {
	Dir        string          `json:"dir"`
	Missing    bool            `json:"missing,omitempty"`
	Git        *GitSnapshot    `json:"git,omitempty"`
	GitError   string          `json:"giterror,omitempty"`
	GitAt      int64           `json:"gitat,omitempty"`
	Github     *GithubSnapshot `json:"github,omitempty"`
	GithubAt   int64           `json:"githubat,omitempty"`
	Refreshing bool            `json:"refreshing,omitempty"`
	// Read and validated on every request (FR-MC-008): the agent writing the file sees the panels follow at once.
	Pipeline *molten.PipelineReport `json:"pipeline,omitempty"`
	// The branch pull requests target when the project declares one (FR-REV-001), read with the pipeline.
	PrTarget string `json:"prtarget,omitempty"`
	// The workflow files' names, sizes and times (#637): the Jobs tab reads them again when it moves.
	WorkflowsStamp string `json:"workflowsstamp,omitempty"`
}

type GetRequest struct {
	Dir       string `json:"dir"`
	MaxAgeSec int    `json:"maxagesec,omitempty"`
	// Passive: the status bar keeping a linked project warm, not a Mission Control view (FR-PERF-011).
	Passive bool `json:"passive,omitempty"`
}

type projectState struct {
	snap       Snapshot
	loaded     bool
	refreshing bool
	fetchedAt  time.Time
	forcedAt   time.Time
	// Invalidated while a refresh ran: that refresh may have read the repository before the change, so another follows.
	again bool
	// When anyone (usedAt) or a Mission Control view (activeAt) last asked.
	usedAt   time.Time
	activeAt time.Time
	// The repository watch's sequence the snapshot's git part was read at (gitWatched: read under a watch).
	gitSeq     uint64
	gitWatched bool
}

type Collector struct {
	lock     sync.Mutex
	cacheDir string
	run      Runner
	publish  func(Snapshot)
	now      func() time.Time
	projects map[string]*projectState
	watch    *gitwatch.Watcher
	exists   func(dir string) bool
}

func MakeCollector(cacheDir string, run Runner, publish func(Snapshot)) *Collector {
	return &Collector{
		cacheDir: cacheDir,
		run:      run,
		publish:  publish,
		now:      time.Now,
		projects: map[string]*projectState{},
		exists:   dirExists,
	}
}

func dirExists(dir string) bool {
	info, err := os.Stat(dir)
	return err == nil && info.IsDir()
}

// UseWatcher re-reads a project's git when its repository changes instead of on a timer (FR-PERF-011).
func (c *Collector) UseWatcher(watch *gitwatch.Watcher) {
	c.watch = watch
}

func (c *Collector) track(dir string) (uint64, bool) {
	if c.watch == nil {
		return 0, false
	}
	return c.watch.Track(dir)
}

// Size is the number of projects held in memory (tests, diagnostics).
func (c *Collector) Size() int {
	c.lock.Lock()
	defer c.lock.Unlock()
	return len(c.projects)
}

func CacheDir(dataDir string) string {
	return filepath.Join(dataDir, "molten", "mission")
}

// cacheKey names a project's files in MoltenTerm's data: its cache, its runs.
func cacheKey(dir string) string {
	sum := sha256.Sum256([]byte(dir))
	return hex.EncodeToString(sum[:8])
}

func (c *Collector) cacheFile(dir string) string {
	return filepath.Join(c.cacheDir, cacheKey(dir)+".json")
}

func (c *Collector) loadCache(dir string) Snapshot {
	snap := Snapshot{Dir: dir}
	data, err := os.ReadFile(c.cacheFile(dir))
	if err != nil {
		return snap
	}
	var cached Snapshot
	if json.Unmarshal(data, &cached) == nil && cached.Dir == dir {
		cached.Refreshing = false
		return cached
	}
	return snap
}

func (c *Collector) saveCache(snap Snapshot) {
	if c.cacheDir == "" {
		return
	}
	if err := os.MkdirAll(c.cacheDir, 0700); err != nil {
		return
	}
	data, err := json.Marshal(snap)
	if err != nil {
		return
	}
	tmp := c.cacheFile(snap.Dir) + ".tmp"
	if os.WriteFile(tmp, data, 0600) == nil {
		os.Rename(tmp, c.cacheFile(snap.Dir))
	}
}

func checkDir(dir string) error {
	if dir == "" || !filepath.IsAbs(dir) {
		return fmt.Errorf("a project folder must be an absolute path (got %q)", dir)
	}
	return nil
}

func (c *Collector) stateLocked(dir string) *projectState {
	state := c.projects[dir]
	if state == nil {
		if len(c.projects) >= maxProjects {
			c.evictLocked()
		}
		state = &projectState{}
		c.projects[dir] = state
	}
	state.usedAt = c.now()
	if !state.loaded {
		state.snap = c.loadCache(dir)
		state.loaded = true
	}
	return state
}

// evictLocked makes room for one project: the projects whose folder is gone first, else the least recently asked one.
// A project being refreshed stays (its refresh writes it back).
func (c *Collector) evictLocked() {
	var oldest string
	var oldestAt time.Time
	for dir, state := range c.projects {
		if state.refreshing {
			continue
		}
		if !c.exists(dir) {
			delete(c.projects, dir)
			continue
		}
		if oldest == "" || state.usedAt.Before(oldestAt) {
			oldest, oldestAt = dir, state.usedAt
		}
	}
	if len(c.projects) >= maxProjects && oldest != "" {
		delete(c.projects, oldest)
	}
}

type refreshPlan struct {
	git    bool
	fetch  bool
	github bool
	// The watch's sequence when the plan was made: the git read answers for it.
	seq     uint64
	watched bool
}

type refreshAsk struct {
	maxAge  time.Duration
	forced  bool
	passive bool
	// githubEvery, on a passive ask: GitHub this often instead of passiveGithubInterval, only for a project whose
	// origin is on GitHub and whose gh worked (railMayReadGithub).
	githubEvery time.Duration
	seq         uint64
	watched     bool
}

// railMayReadGithub is whether the rail's ask may call gh (#688, AC3): never before git named a GitHub origin, and
// never again once gh was missing or signed out; a Mission Control view asks again and the rail follows its answer.
func railMayReadGithub(snap Snapshot) bool {
	if snap.Git == nil || snap.Git.RemoteUrl == "" {
		return false
	}
	if snap.Github == nil {
		return true
	}
	return snap.Github.State != GithubStateNoGh && snap.Github.State != GithubStateLoggedOut && snap.Github.State != GithubStateNoRepo
}

// startRefreshLocked decides what to read again and marks the project as refreshing; the caller runs it outside the
// lock. A refresh already running is never doubled.
func (c *Collector) startRefreshLocked(state *projectState, ask refreshAsk) (refreshPlan, bool) {
	now := c.now()
	if state.refreshing {
		return refreshPlan{}, false
	}
	forced := ask.forced && !ask.passive
	if forced && now.Sub(state.forcedAt) < minForcedInterval {
		forced = false
	}
	gitAge := now.Sub(time.UnixMilli(state.snap.GitAt))
	githubAge := now.Sub(time.UnixMilli(state.snap.GithubAt))
	// Under a watch, git is read again when the repository changed; without one, when the last read is too old.
	watched := ask.watched && state.gitWatched && state.snap.GitAt != 0
	changed := watched && ask.seq != state.gitSeq
	gitMaxAge := ask.maxAge
	switch {
	case ask.passive && watched:
		// The status bar needs no history: under a watch, only a change is worth a read.
		gitMaxAge = time.Duration(1<<63 - 1)
	case ask.passive:
		gitMaxAge = passiveGitMaxAge
	case watched:
		gitMaxAge = max(ask.maxAge, watchedGitMaxAge)
	}
	plan := refreshPlan{
		git:     forced || changed || gitAge >= gitMaxAge,
		github:  githubAge >= minGithubInterval && (forced || githubAge >= ask.maxAge),
		seq:     ask.seq,
		watched: ask.watched,
	}
	if ask.passive {
		plan.github = githubAge >= passiveGithubInterval
		if ask.githubEvery > 0 {
			plan.github = githubAge >= ask.githubEvery && railMayReadGithub(state.snap)
		}
	}
	if !plan.git && !plan.github {
		return plan, false
	}
	plan.fetch = !ask.passive && plan.git && (forced || now.Sub(state.fetchedAt) >= fetchEvery)
	if forced {
		state.forcedAt = now
	}
	state.refreshing = true
	return plan, true
}

func (c *Collector) snapshotLocked(state *projectState) Snapshot {
	snap := state.snap
	snap.Refreshing = state.refreshing
	return snap
}

func (c *Collector) prepareGet(dir string, ask refreshAsk) (Snapshot, refreshPlan, bool) {
	c.lock.Lock()
	defer c.lock.Unlock()
	state := c.stateLocked(dir)
	if !c.exists(dir) {
		state.snap.Missing = true
		snap := c.snapshotLocked(state)
		if !state.refreshing {
			// A folder that is gone holds no memory; its cached answer is read again from disk if it comes back.
			delete(c.projects, dir)
		}
		return snap, refreshPlan{}, false
	}
	state.snap.Missing = false
	if !ask.passive {
		state.activeAt = c.now()
	}
	plan, start := c.startRefreshLocked(state, ask)
	return c.snapshotLocked(state), plan, start
}

// Get answers at once with what is known (cached data first, NFR-MC-002) and starts a refresh when it is older than
// maxAge (or, for a watched repository, when git changed it); the refreshed snapshot comes as an event.
func (c *Collector) Get(dir string, maxAge time.Duration, forced bool) (Snapshot, error) {
	return c.get(dir, refreshAsk{maxAge: maxAge, forced: forced})
}

// Warm answers like Get for a status bar that keeps a linked project's pull requests known without a Mission Control
// view (FR-PERF-011): git is read again only after a change, GitHub every passiveGithubInterval, nothing is fetched.
func (c *Collector) Warm(dir string) (Snapshot, error) {
	return c.get(dir, refreshAsk{maxAge: DefaultMaxAgeSec * time.Second, passive: true})
}

// WarmReviews answers like Warm for the rail's Reviews counts (#688): GitHub every railGithubInterval, for a GitHub
// project whose gh works. A Mission Control view keeps GitHub fresher: then this reads nothing.
func (c *Collector) WarmReviews(dir string) (Snapshot, error) {
	return c.get(dir, refreshAsk{maxAge: DefaultMaxAgeSec * time.Second, passive: true, githubEvery: railGithubInterval})
}

func (c *Collector) get(dir string, ask refreshAsk) (Snapshot, error) {
	if err := checkDir(dir); err != nil {
		return Snapshot{}, err
	}
	dir = filepath.Clean(dir)
	ask.seq, ask.watched = c.track(dir)
	snap, plan, start := c.prepareGet(dir, ask)
	if start {
		go c.refresh(dir, plan)
	}
	if !snap.Missing {
		report := molten.ValidatePipeline(dir)
		snap.Pipeline = &report
		snap.PrTarget = molten.PrTargetBranch(dir)
		snap.WorkflowsStamp = WorkflowsStamp(dir)
	}
	return snap, nil
}

// Cached answers with what the collector already knows of a project, without ever starting a refresh: the status bar
// asks about any folder a terminal goes to, and must not fetch or call gh in a repository nobody linked.
func (c *Collector) Cached(dir string) (Snapshot, bool) {
	c.lock.Lock()
	defer c.lock.Unlock()
	if state := c.projects[dir]; state != nil && state.loaded {
		state.usedAt = c.now()
		return c.snapshotLocked(state), true
	}
	if c.cacheDir == "" {
		return Snapshot{}, false
	}
	if _, err := os.Stat(c.cacheFile(dir)); err != nil {
		return Snapshot{}, false
	}
	return c.snapshotLocked(c.stateLocked(dir)), true
}

// Invalidate makes the next read of a project re-read its repository and fetch, and starts that read now: a run that
// ended may have made a commit or a tag (a release candidate cut) that the panels must show without waiting for the
// minute-long cache to expire. A refresh already running is followed by another one.
func (c *Collector) Invalidate(dir string) {
	if checkDir(dir) != nil {
		return
	}
	dir = filepath.Clean(dir)
	seq, watched := c.track(dir)
	if plan, start := c.prepareInvalidate(dir, seq, watched); start {
		go c.refresh(dir, plan)
	}
}

func (c *Collector) prepareInvalidate(dir string, seq uint64, watched bool) (refreshPlan, bool) {
	c.lock.Lock()
	defer c.lock.Unlock()
	state := c.stateLocked(dir)
	state.snap.GitAt = 0
	state.fetchedAt = time.Time{}
	if state.refreshing {
		state.again = true
		return refreshPlan{}, false
	}
	return c.startRefreshLocked(state, refreshAsk{maxAge: DefaultMaxAgeSec * time.Second, seq: seq, watched: watched})
}

// RepoChanged is the repository watch's listener: git changed a project's repository (a commit, a checkout). A project a
// Mission Control view looks at is read again now, without a fetch (FR-PERF-011-AC2); the others on their next request.
func (c *Collector) RepoChanged(root string) {
	seq, watched := c.track(root)
	if plan, start := c.prepareChanged(root, seq, watched); start {
		go c.refresh(root, plan)
	}
}

func (c *Collector) prepareChanged(dir string, seq uint64, watched bool) (refreshPlan, bool) {
	c.lock.Lock()
	defer c.lock.Unlock()
	state := c.projects[dir]
	if state == nil || !state.loaded || c.now().Sub(state.activeAt) >= activeWindow {
		return refreshPlan{}, false
	}
	if state.refreshing {
		state.again = true
		return refreshPlan{}, false
	}
	return c.startRefreshLocked(state, refreshAsk{maxAge: DefaultMaxAgeSec * time.Second, seq: seq, watched: watched})
}

// takeAgain reports an invalidation that came during the refresh that just ended, and starts the next one.
func (c *Collector) takeAgain(dir string) (refreshPlan, bool) {
	seq, watched := c.track(dir)
	c.lock.Lock()
	defer c.lock.Unlock()
	state := c.stateLocked(dir)
	if !state.again {
		return refreshPlan{}, false
	}
	state.again = false
	state.snap.GitAt = 0
	return c.startRefreshLocked(state, refreshAsk{maxAge: DefaultMaxAgeSec * time.Second, seq: seq, watched: watched})
}

func (c *Collector) refresh(dir string, plan refreshPlan) {
	defer func() {
		if r := recover(); r != nil {
			panichandler.PanicHandler("molten:mission:refresh", r)
			// A refresh that never ends would block every later one.
			c.applyRefresh(dir, refreshPlan{}, nil, nil, nil)
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), collectTimeout)
	defer cancel()
	var gitSnap *GitSnapshot
	var gitErr error
	if plan.git {
		gitSnap, gitErr = CollectGit(ctx, c.run, dir, plan.fetch)
	}
	var githubSnap *GithubSnapshot
	if plan.github {
		githubSnap = CollectGithub(ctx, c.run, dir)
	}
	snap := c.applyRefresh(dir, plan, gitSnap, gitErr, githubSnap)
	report := molten.ValidatePipeline(dir)
	snap.Pipeline = &report
	snap.PrTarget = molten.PrTargetBranch(dir)
	snap.WorkflowsStamp = WorkflowsStamp(dir)
	c.saveCache(snap)
	if c.publish != nil {
		c.publish(snap)
	}
	if next, start := c.takeAgain(dir); start {
		go c.refresh(dir, next)
	}
}

func (c *Collector) applyRefresh(dir string, plan refreshPlan, gitSnap *GitSnapshot, gitErr error, githubSnap *GithubSnapshot) Snapshot {
	c.lock.Lock()
	defer c.lock.Unlock()
	state := c.stateLocked(dir)
	now := c.now()
	if plan.git {
		state.gitSeq, state.gitWatched = plan.seq, plan.watched
		state.snap.GitAt = now.UnixMilli()
		if gitErr != nil {
			state.snap.GitError = gitErr.Error()
		} else {
			state.snap.Git = gitSnap
			state.snap.GitError = ""
		}
		if plan.fetch {
			state.fetchedAt = now
		}
	}
	if plan.github {
		state.snap.Github = githubSnap
		state.snap.GithubAt = now.UnixMilli()
	}
	state.refreshing = false
	return c.snapshotLocked(state)
}

func publishSnapshot(snap Snapshot) {
	wps.Broker.Publish(wps.WaveEvent{
		Event:  UpdateEvent,
		Scopes: []string{snap.Dir},
		Data:   snap,
	})
}

func publishRun(rec RunRecord) {
	wps.Broker.Publish(wps.WaveEvent{
		Event:  RunEvent,
		Scopes: []string{rec.Dir},
		Data:   rec,
	})
}

func publishBuildNotice(rec RunRecord, input molten.NotificationInput) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	input.WorkspaceId = attention.ProjectWorkspace(ctx, rec.Dir)
	if err := attention.PublishNotification(ctx, input); err != nil {
		log.Printf("molten: telling the end of build %s: %v\n", rec.Id, err)
	}
}

func publishCiRun(rec CiRunRecord) {
	wps.Broker.Publish(wps.WaveEvent{
		Event:  CiEvent,
		Scopes: []string{rec.Dir},
		Data:   rec,
	})
}

// Starters are MoltenTerm parts started with Mission Control that it cannot import (they depend on packages that
// import this one); wavesrv's main package registers them.
var starters []func()

// UseStarter registers a part to start with Mission Control; called from an init function, before Start.
func UseStarter(start func()) {
	starters = append(starters, start)
}

// Start registers the collector on wavesrv's router; wavesrv calls it once at start.
func Start() {
	dataDir := wavebase.GetWaveDataDir()
	// The groups (FR-MC-026) follow every collector refresh and every CI run's end; set before the route takes requests.
	var groups *Groups
	// Where the merged PRs ship (#843) follows a git read: its fetch brings the tags.
	var reviews *Reviews
	collector := MakeCollector(CacheDir(dataDir), ExecRunner, func(snap Snapshot) {
		publishSnapshot(snap)
		go groups.Refreshed()
		go reviews.Refreshed(snap)
	})
	trust := MakeTrustStore(filepath.Join(CacheDir(dataDir), TrustFileName))
	runs := MakeRuns(RunsDir(dataDir), trust, func(rec RunRecord) {
		publishRun(rec)
		// A run that ends may have committed or tagged (a release cut): the overview shows it at once.
		if rec.State != RunStateRunning && !rec.Closed {
			collector.Invalidate(rec.Dir)
		}
	})
	var panes *Panes
	ci := MakeCi(CiDir(dataDir), trust, ExecRunner, func(rec CiRunRecord) {
		if panes != nil {
			// Before the event: the status bars ask again on it, and a run that starts shows as running.
			panes.CiChanged(rec.Dir)
		}
		publishCiRun(rec)
		if rec.Status != CiStateRunning {
			go groups.Refreshed()
		}
	})
	runs.UseCi(ci)
	runs.UseNotifier(publishBuildNotice)
	// The status bars and the collector read git again when the watch sees it change a repository (FR-PERF-011).
	watch := gitwatch.Default()
	collector.UseWatcher(watch)
	panes = MakePanes(ExecRunner, ci, collector)
	panes.UseWatcher(watch)
	watch.OnChange(func(root string) {
		publishPaneChanged(root)
		collector.RepoChanged(root)
	})
	groups = MakeGroups(collector, ci, runs, ExecRunner, WorkspaceLinks, publishGroups, notifyDependencies)
	groups.UseSync(MakeDepAcks(DepAcksDir(dataDir)), DepSyncTreesDir(dataDir))
	// The rail keeps a product's workspaces together (FR-MC-027), and a move changes the member order the groups show.
	// A project product takes the local rail groups' members it shows (FR-MC-032), with a notification.
	railorder.SetGrouping(ProductWorkspaces, func() { go groups.Reordered() }, func(displaced []railorder.Displaced) {
		go notifyRailGroups(displaced)
	})
	// What runs now is also work for the keep-awake (FR-SHELL-023).
	useCurrentWork(runs, ci)
	reviews = MakeReviews(collector, ExecRunner, publishReviews)
	reviews.notify = attention.PublishNotification
	if err := registerRoute(collector, runs, ci, panes, MakeWorktrees(ExecRunner, nil), groups, reviews); err != nil {
		log.Printf("molten: mission control collector not started: %v\n", err)
	}
	// The agent states (FR-SHELL-011) start with Mission Control, so wavesrv's startup keeps one MoltenTerm entry point.
	attention.StartAgentRoute()
	// The agent companion (FR-SHELL-018) follows the agents the states know.
	companion.Start()
	// The workspace task checkpoint (FR-CONT-007) updates from the agents' turns the companion reads.
	checkpoint.Start()
	// Pages handed off to the installed browser (FR-BRW-002).
	browsers.StartRoute(func() browsers.Settings {
		s := wconfig.GetWatcher().GetFullConfig().Settings
		return browsers.Settings{Installed: s.BrowserInstalled, Default: s.BrowserDefault, Sites: s.BrowserSites}
	}, func(sites map[string]string) error {
		if len(sites) == 0 {
			return wconfig.SetBaseConfigValue(waveobj.MetaMapType{wconfig.ConfigKey_BrowserSites: nil})
		}
		return wconfig.SetBaseConfigValue(waveobj.MetaMapType{wconfig.ConfigKey_BrowserSites: sites})
	})
	// The agent sessions of `molten mcp browser` (FR-BRW-008).
	browseragent.Start()
	// Handing work from one agent to another by first name (FR-CONT-015).
	agenthandoff.Start()
	for _, start := range starters {
		start()
	}
}
