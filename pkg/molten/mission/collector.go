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
	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/molten/browseragent"
	"github.com/wavetermdev/waveterm/pkg/molten/browsers"
	"github.com/wavetermdev/waveterm/pkg/molten/companion"
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
	WorkCommand             = "moltenmissionwork"
	UpdateEvent             = "molten:mission:update"
	RunEvent                = "molten:mission:run"
	CiEvent                 = "molten:mission:ci"
	DefaultMaxAgeSec        = 60
	collectTimeout          = 2 * time.Minute
	fetchEvery              = 5 * time.Minute
	minForcedInterval       = 10 * time.Second
	// NFR-MC-003: GitHub is read at most once a minute per project, however many panels ask.
	minGithubInterval = time.Minute
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
}

type GetRequest struct {
	Dir       string `json:"dir"`
	MaxAgeSec int    `json:"maxagesec,omitempty"`
}

type projectState struct {
	snap       Snapshot
	loaded     bool
	refreshing bool
	fetchedAt  time.Time
	forcedAt   time.Time
	// Invalidated while a refresh ran: that refresh may have read the repository before the change, so another follows.
	again bool
}

type Collector struct {
	lock     sync.Mutex
	cacheDir string
	run      Runner
	publish  func(Snapshot)
	now      func() time.Time
	projects map[string]*projectState
}

func MakeCollector(cacheDir string, run Runner, publish func(Snapshot)) *Collector {
	return &Collector{
		cacheDir: cacheDir,
		run:      run,
		publish:  publish,
		now:      time.Now,
		projects: map[string]*projectState{},
	}
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
		state = &projectState{}
		c.projects[dir] = state
	}
	if !state.loaded {
		state.snap = c.loadCache(dir)
		state.loaded = true
	}
	return state
}

type refreshPlan struct {
	git    bool
	fetch  bool
	github bool
}

// startRefreshLocked decides what to read again and marks the project as refreshing; the caller runs it outside the
// lock. A refresh already running is never doubled.
func (c *Collector) startRefreshLocked(state *projectState, maxAge time.Duration, forced bool) (refreshPlan, bool) {
	now := c.now()
	if state.refreshing {
		return refreshPlan{}, false
	}
	if forced && now.Sub(state.forcedAt) < minForcedInterval {
		forced = false
	}
	gitAge := now.Sub(time.UnixMilli(state.snap.GitAt))
	githubAge := now.Sub(time.UnixMilli(state.snap.GithubAt))
	plan := refreshPlan{
		git:    forced || gitAge >= maxAge,
		github: githubAge >= minGithubInterval && (forced || githubAge >= maxAge),
	}
	if !plan.git && !plan.github {
		return plan, false
	}
	plan.fetch = plan.git && (forced || now.Sub(state.fetchedAt) >= fetchEvery)
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

func (c *Collector) prepareGet(dir string, maxAge time.Duration, forced bool) (Snapshot, refreshPlan, bool) {
	c.lock.Lock()
	defer c.lock.Unlock()
	state := c.stateLocked(dir)
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		state.snap.Missing = true
		return c.snapshotLocked(state), refreshPlan{}, false
	}
	state.snap.Missing = false
	plan, start := c.startRefreshLocked(state, maxAge, forced)
	return c.snapshotLocked(state), plan, start
}

// Get answers at once with what is known (cached data first, NFR-MC-002) and starts a refresh when it is older than
// maxAge; the refreshed snapshot comes as an event.
func (c *Collector) Get(dir string, maxAge time.Duration, forced bool) (Snapshot, error) {
	if err := checkDir(dir); err != nil {
		return Snapshot{}, err
	}
	dir = filepath.Clean(dir)
	snap, plan, start := c.prepareGet(dir, maxAge, forced)
	if start {
		go c.refresh(dir, plan)
	}
	if !snap.Missing {
		report := molten.ValidatePipeline(dir)
		snap.Pipeline = &report
	}
	return snap, nil
}

// Cached answers with what the collector already knows of a project, without ever starting a refresh: the status bar
// asks about any folder a terminal goes to, and must not fetch or call gh in a repository nobody linked.
func (c *Collector) Cached(dir string) (Snapshot, bool) {
	c.lock.Lock()
	defer c.lock.Unlock()
	if state := c.projects[dir]; state != nil && state.loaded {
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
	if plan, start := c.prepareInvalidate(dir); start {
		go c.refresh(dir, plan)
	}
}

func (c *Collector) prepareInvalidate(dir string) (refreshPlan, bool) {
	c.lock.Lock()
	defer c.lock.Unlock()
	state := c.stateLocked(dir)
	state.snap.GitAt = 0
	state.fetchedAt = time.Time{}
	if state.refreshing {
		state.again = true
		return refreshPlan{}, false
	}
	return c.startRefreshLocked(state, DefaultMaxAgeSec*time.Second, false)
}

// takeAgain reports an invalidation that came during the refresh that just ended, and starts the next one.
func (c *Collector) takeAgain(dir string) (refreshPlan, bool) {
	c.lock.Lock()
	defer c.lock.Unlock()
	state := c.stateLocked(dir)
	if !state.again {
		return refreshPlan{}, false
	}
	state.again = false
	state.snap.GitAt = 0
	return c.startRefreshLocked(state, DefaultMaxAgeSec*time.Second, false)
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
	collector := MakeCollector(CacheDir(dataDir), ExecRunner, publishSnapshot)
	trust := MakeTrustStore(filepath.Join(CacheDir(dataDir), TrustFileName))
	runs := MakeRuns(RunsDir(dataDir), trust, func(rec RunRecord) {
		publishRun(rec)
		// A run that ends may have committed or tagged (a release cut): the overview shows it at once.
		if rec.State != RunStateRunning && !rec.Closed {
			collector.Invalidate(rec.Dir)
		}
	})
	ci := MakeCi(CiDir(dataDir), trust, ExecRunner, publishCiRun)
	runs.UseCi(ci)
	runs.UseNotifier(publishBuildNotice)
	panes := MakePanes(ExecRunner, ci, collector)
	if err := registerRoute(collector, runs, ci, panes, MakeWorktrees(ExecRunner, nil)); err != nil {
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
	for _, start := range starters {
		start()
	}
}
