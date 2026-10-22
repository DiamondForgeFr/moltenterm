// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

// The Reviews view's Launch (FR-REV-031, DS-REV-018): one version of a project served on this computer at a time. A
// launch checks the version out (the main checkout detached at its head, or the branch's worktree), runs the recipe's
// preparation in order, starts its servers each in a session of its own and waits for their ports. Its state and the
// log of each step live in <data>/molten/launch/<project>/ and survive a wavesrv restart: the servers keep running and
// are followed again. Nothing starts unasked: every start, stop and retry is a click in a window.

const (
	LaunchPlanCommand  = "moltenmissionlaunchplan"
	LaunchStartCommand = "moltenmissionlaunchstart"
	LaunchStopCommand  = "moltenmissionlaunchstop"
	LaunchRetryCommand = "moltenmissionlaunchretry"
	LaunchStateCommand = "moltenmissionlaunchstate"
	LaunchLogCommand   = "moltenmissionlaunchlog"
	LaunchEvent        = "molten:mission:launch"

	// must match LaunchTargetKind in frontend/moltenterm-shell/reviews/reviews-launch-model.ts
	LaunchTargetPr     = "pr"
	LaunchTargetBranch = "branch"
	LaunchTargetTrunk  = "trunk"

	LaunchStateStarting = "starting"
	LaunchStateRunning  = "running"
	LaunchStateFailed   = "failed"
	LaunchStateStopped  = "stopped"

	LaunchStepPending = "pending"
	LaunchStepRunning = "running"
	LaunchStepDone    = "done"
	LaunchStepFailed  = "failed"
	LaunchStepStopped = "stopped"

	LaunchStepCheckout = "checkout"
	LaunchStepPrepare  = "prepare"
	LaunchStepServer   = "server"

	launchStateFile      = "state.json"
	launchLogsDir        = "logs"
	launchCheckoutId     = "checkout"
	launchReadyTimeout   = 3 * time.Minute
	launchStopGrace      = 10 * time.Second
	launchPollInterval   = 300 * time.Millisecond
	launchWatchInterval  = 2 * time.Second
	launchGitTimeout     = 2 * time.Minute
	launchMaxDirty       = 20
	launchHoldersTimeout = 5 * time.Second
)

// must match LaunchTarget in frontend/moltenterm-shell/reviews/reviews-launch-model.ts
type LaunchTarget struct {
	Kind    string `json:"kind"`
	Number  int    `json:"number,omitempty"`
	Branch  string `json:"branch,omitempty"`
	Title   string `json:"title,omitempty"`
	HeadOid string `json:"headoid,omitempty"`
}

// must match LaunchStep in frontend/moltenterm-shell/reviews/reviews-launch-model.ts
type LaunchStep struct {
	Id         string      `json:"id"`
	Kind       string      `json:"kind"`
	Title      string      `json:"title,omitempty"`
	Run        string      `json:"run,omitempty"`
	Cwd        string      `json:"cwd,omitempty"`
	Port       int         `json:"port,omitempty"`
	State      string      `json:"state"`
	Pid        int         `json:"pid,omitempty"`
	StartedAt  int64       `json:"startedat,omitempty"`
	FinishedAt int64       `json:"finishedat,omitempty"`
	Error      string      `json:"error,omitempty"`
	ErrorText  *uimsg.Text `json:"errortext,omitempty"`
}

// must match LaunchState in frontend/moltenterm-shell/reviews/reviews-launch-model.ts
type LaunchState struct {
	Dir    string       `json:"dir"`
	Id     string       `json:"id"`
	Target LaunchTarget `json:"target"`
	// The folder served: the project's main checkout, or the branch's worktree.
	ServeDir string       `json:"servedir"`
	Worktree bool         `json:"worktree,omitempty"`
	Commit   string       `json:"commit,omitempty"`
	State    string       `json:"state"`
	Steps    []LaunchStep `json:"steps"`
	Url      string       `json:"url,omitempty"`
	// The branch the main checkout was on before a launch detached it: what Back to the trunk leaves for.
	Previous string `json:"previous,omitempty"`
	// The stash the uncommitted changes were set aside in.
	Stash     string      `json:"stash,omitempty"`
	StartedAt int64       `json:"startedat"`
	ReadyAt   int64       `json:"readyat,omitempty"`
	Error     string      `json:"error,omitempty"`
	ErrorText *uimsg.Text `json:"errortext,omitempty"`
}

type LaunchPortHolder struct {
	Port int    `json:"port"`
	Pid  int    `json:"pid,omitempty"`
	Name string `json:"name,omitempty"`
}

type LaunchPlanRequest struct {
	Dir    string       `json:"dir"`
	Target LaunchTarget `json:"target"`
}

// must match LaunchPlan in frontend/moltenterm-shell/reviews/reviews-launch-model.ts
type LaunchPlan struct {
	Dir string `json:"dir"`
	// The version that stops, when one runs or starts.
	Running *LaunchState  `json:"running,omitempty"`
	Recipe  *LaunchRecipe `json:"recipe,omitempty"`
	// The folder the version is served from, and whether it is the branch's worktree (left as it is).
	ServeDir string `json:"servedir"`
	Worktree bool   `json:"worktree,omitempty"`
	// The checkout's branch now ("" when detached) and short commit: what the switch leaves.
	Branch string `json:"branch,omitempty"`
	Commit string `json:"commit,omitempty"`
	// Tracked files with uncommitted changes in the checkout that switches, at most launchMaxDirty, and their count.
	Dirty      []string `json:"dirty"`
	DirtyCount int      `json:"dirtycount"`
	// Processes other than the launch's own servers listening on the recipe's ports.
	Holders []LaunchPortHolder `json:"holders"`
}

type LaunchStartRequest struct {
	Dir    string       `json:"dir"`
	Target LaunchTarget `json:"target"`
	// Set the uncommitted changes aside in a stash; without it, they block the switch.
	Stash bool `json:"stash,omitempty"`
	// Stop the processes holding the recipe's ports; without it, they block the launch.
	StopPorts bool `json:"stopports,omitempty"`
}

type LaunchDirRequest struct {
	Dir string `json:"dir"`
}

type LaunchLogRequest struct {
	Dir  string `json:"dir"`
	Step string `json:"step"`
	From int64  `json:"from,omitempty"`
}

type launchRun struct {
	cancel context.CancelFunc
	done   chan struct{}
}

type Launches struct {
	lock    sync.Mutex
	baseDir string
	recipes *launchRecipes
	git     Runner
	publish func(LaunchState)
	now     func() time.Time
	// The processes listening on a local port; tests replace it.
	holders      func(ctx context.Context, port int) ([]LaunchPortHolder, error)
	readyTimeout time.Duration
	states       map[string]*LaunchState
	runs         map[string]*launchRun
	// The servers this wavesrv started, by pid: their end is known at once.
	exited   map[int]chan struct{}
	watching map[string]bool
	// Servers being stopped on purpose: their end is not a failure.
	stopping map[int]bool
}

func LaunchDir(dataDir string) string {
	return filepath.Join(dataDir, "molten", "launch")
}

func MakeLaunches(baseDir string, git Runner, publish func(LaunchState)) *Launches {
	return &Launches{baseDir: baseDir, recipes: &launchRecipes{file: filepath.Join(baseDir, launchRecipesFile)}, git: git,
		publish: publish, now: time.Now, holders: lsofHolders, readyTimeout: launchReadyTimeout,
		states: map[string]*LaunchState{}, runs: map[string]*launchRun{}, exited: map[int]chan struct{}{},
		watching: map[string]bool{}, stopping: map[int]bool{}}
}

func publishLaunch(state LaunchState) {
	wps.Broker.Publish(wps.WaveEvent{Event: LaunchEvent, Scopes: []string{state.Dir}, Data: state})
}

func (l *Launches) projectDir(dir string) string {
	return filepath.Join(l.baseDir, cacheKey(filepath.Clean(dir)))
}

func (l *Launches) logFile(dir string, step string) string {
	return filepath.Join(l.projectDir(dir), launchLogsDir, step+".log")
}

func copyLaunchState(state *LaunchState) *LaunchState {
	if state == nil {
		return nil
	}
	rtn := *state
	rtn.Steps = append([]LaunchStep{}, state.Steps...)
	return &rtn
}

func (l *Launches) writeStateLocked(state *LaunchState) {
	if err := os.MkdirAll(l.projectDir(state.Dir), 0700); err != nil {
		return
	}
	data, err := json.Marshal(state)
	if err != nil {
		return
	}
	file := filepath.Join(l.projectDir(state.Dir), launchStateFile)
	if os.WriteFile(file+".tmp", data, 0600) == nil {
		os.Rename(file+".tmp", file)
	}
}

// loadLocked reads a project's last launch once; a launch wavesrv was running when it stopped is followed again.
func (l *Launches) loadLocked(dir string) *LaunchState {
	dir = filepath.Clean(dir)
	if state, ok := l.states[dir]; ok {
		return state
	}
	l.states[dir] = nil
	data, err := os.ReadFile(filepath.Join(l.projectDir(dir), launchStateFile))
	if err != nil {
		return nil
	}
	var state LaunchState
	if json.Unmarshal(data, &state) != nil || filepath.Clean(state.Dir) != dir {
		return nil
	}
	if state.State == LaunchStateStarting {
		l.failLocked(&state, -1, uimsg.Make("mission.launch.interrupted"), "MoltenTerm stopped while the version was starting")
	}
	if state.State == LaunchStateRunning {
		for _, step := range state.Steps {
			if step.Kind == LaunchStepServer && step.Pid > 0 && !processAlive(step.Pid) {
				l.failLocked(&state, -1, uimsg.Make("mission.launch.lost"), "a server of the version stopped while MoltenTerm was closed")
				break
			}
		}
	}
	l.states[dir] = &state
	if state.State == LaunchStateRunning {
		l.watchLocked(dir)
	}
	return &state
}

// failLocked ends a launch in failure; at is the failed step, -1 for the launch as a whole.
func (l *Launches) failLocked(state *LaunchState, at int, text *uimsg.Text, english string) {
	state.State = LaunchStateFailed
	state.Error, state.ErrorText = english, text
	if at >= 0 && at < len(state.Steps) {
		step := &state.Steps[at]
		step.State = LaunchStepFailed
		step.Error, step.ErrorText = english, text
		step.FinishedAt = l.now().UnixMilli()
	}
}

func (l *Launches) setState(dir string, change func(state *LaunchState)) LaunchState {
	l.lock.Lock()
	state := l.loadLocked(dir)
	if state == nil {
		l.lock.Unlock()
		return LaunchState{}
	}
	change(state)
	l.writeStateLocked(state)
	rtn := *copyLaunchState(state)
	l.lock.Unlock()
	if l.publish != nil {
		l.publish(rtn)
	}
	return rtn
}

// State is a project's last launch; Dir is empty when it never launched anything.
func (l *Launches) State(req LaunchDirRequest) (LaunchState, error) {
	if err := checkDir(req.Dir); err != nil {
		return LaunchState{}, err
	}
	l.lock.Lock()
	defer l.lock.Unlock()
	state := copyLaunchState(l.loadLocked(req.Dir))
	if state == nil {
		return LaunchState{Steps: []LaunchStep{}}, nil
	}
	return *state, nil
}

func (l *Launches) gitOut(ctx context.Context, dir string, args ...string) (string, error) {
	out, err := l.git(ctx, dir, "git", args...)
	return strings.TrimSpace(string(out)), err
}

// worktreeOf is the folder of the linked worktree holding branch, "" when none does.
func (l *Launches) worktreeOf(ctx context.Context, dir string, branch string) string {
	out, err := l.gitOut(ctx, dir, "worktree", "list", "--porcelain")
	if err != nil || branch == "" {
		return ""
	}
	path := ""
	for _, line := range strings.Split(out, "\n") {
		if value, ok := strings.CutPrefix(line, "worktree "); ok {
			path = value
			continue
		}
		if value, ok := strings.CutPrefix(line, "branch "); ok && value == "refs/heads/"+branch && filepath.Clean(path) != filepath.Clean(dir) {
			return path
		}
	}
	return ""
}

func (l *Launches) servedDir(ctx context.Context, dir string, recipe *LaunchRecipe, target LaunchTarget) (string, bool) {
	if recipe == nil || recipe.Where != molten.PipelineLaunchWhereWorktree || target.Kind == LaunchTargetTrunk {
		return dir, false
	}
	if worktree := l.worktreeOf(ctx, dir, target.Branch); worktree != "" {
		return worktree, true
	}
	return dir, false
}

func (l *Launches) dirtyFiles(ctx context.Context, dir string) ([]string, error) {
	out, err := l.gitOut(ctx, dir, "status", "--porcelain", "--untracked-files=no")
	if err != nil {
		return nil, err
	}
	rtn := []string{}
	for _, line := range strings.Split(out, "\n") {
		if strings.TrimSpace(line) != "" {
			rtn = append(rtn, strings.TrimSpace(line))
		}
	}
	return rtn, nil
}

// lsofHolders lists the processes listening on a local TCP port.
func lsofHolders(ctx context.Context, port int) ([]LaunchPortHolder, error) {
	out, err := ExecRunner(ctx, "", "lsof", "-nP", "-iTCP:"+strconv.Itoa(port), "-sTCP:LISTEN", "-Fpc")
	if err != nil && len(out) == 0 {
		var missing *MissingProgramError
		if errors.As(err, &missing) {
			return nil, err
		}
		// lsof exits 1 when nothing listens.
		return nil, nil
	}
	rtn := []LaunchPortHolder{}
	var current *LaunchPortHolder
	for _, line := range strings.Split(string(out), "\n") {
		if len(line) < 2 {
			continue
		}
		switch line[0] {
		case 'p':
			pid, _ := strconv.Atoi(line[1:])
			rtn = append(rtn, LaunchPortHolder{Port: port, Pid: pid})
			current = &rtn[len(rtn)-1]
		case 'c':
			if current != nil {
				current.Name = line[1:]
			}
		}
	}
	return rtn, nil
}

func portAccepts(port int) bool {
	for _, host := range []string{"127.0.0.1", "::1"} {
		conn, err := net.DialTimeout("tcp", net.JoinHostPort(host, strconv.Itoa(port)), 500*time.Millisecond)
		if err == nil {
			conn.Close()
			return true
		}
	}
	return false
}

// foreignHolders are the processes on the recipe's ports that are not the given servers (process group leaders).
func (l *Launches) foreignHolders(ctx context.Context, recipe *LaunchRecipe, own map[int]bool) []LaunchPortHolder {
	rtn := []LaunchPortHolder{}
	if recipe == nil {
		return rtn
	}
	for _, server := range recipe.Servers {
		if server.Port <= 0 {
			continue
		}
		holders, err := l.holders(ctx, server.Port)
		if err != nil {
			if portAccepts(server.Port) {
				rtn = append(rtn, LaunchPortHolder{Port: server.Port})
			}
			continue
		}
		seen := map[int]bool{}
		for _, holder := range holders {
			if seen[holder.Pid] || own[holder.Pid] || own[processGroupOf(holder.Pid)] {
				continue
			}
			seen[holder.Pid] = true
			rtn = append(rtn, holder)
		}
	}
	return rtn
}

func ownServers(state *LaunchState) map[int]bool {
	rtn := map[int]bool{}
	if state == nil {
		return rtn
	}
	for _, step := range state.Steps {
		if step.Kind == LaunchStepServer && step.Pid > 0 && (step.State == LaunchStepRunning || step.State == LaunchStepDone) {
			rtn[step.Pid] = true
		}
	}
	return rtn
}

func launchActive(state *LaunchState) bool {
	return state != nil && (state.State == LaunchStateStarting || state.State == LaunchStateRunning)
}

// Plan says what a Launch replaces and loses, before the developer confirms it.
func (l *Launches) Plan(req LaunchPlanRequest) (LaunchPlan, error) {
	if err := checkDir(req.Dir); err != nil {
		return LaunchPlan{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	recipe := l.recipes.get(req.Dir)
	l.lock.Lock()
	current := copyLaunchState(l.loadLocked(req.Dir))
	l.lock.Unlock()
	rtn := LaunchPlan{Dir: req.Dir, Recipe: recipe, Dirty: []string{}, Holders: []LaunchPortHolder{}}
	if launchActive(current) {
		rtn.Running = current
	}
	rtn.ServeDir, rtn.Worktree = l.servedDir(ctx, req.Dir, recipe, req.Target)
	rtn.Branch, _ = l.gitOut(ctx, rtn.ServeDir, "symbolic-ref", "--short", "-q", "HEAD")
	rtn.Commit, _ = l.gitOut(ctx, rtn.ServeDir, "rev-parse", "--short", "HEAD")
	if !rtn.Worktree {
		dirty, err := l.dirtyFiles(ctx, rtn.ServeDir)
		if err != nil {
			return rtn, uimsg.Errorf(uimsg.Make("mission.launch.gitFailed", "detail", err.Error()), "reading the checkout: %w", err)
		}
		rtn.DirtyCount = len(dirty)
		if len(dirty) > launchMaxDirty {
			dirty = dirty[:launchMaxDirty]
		}
		rtn.Dirty = dirty
	}
	rtn.Holders = l.foreignHolders(ctx, recipe, ownServers(current))
	return rtn, nil
}

func launchSteps(recipe *LaunchRecipe) []LaunchStep {
	steps := []LaunchStep{{Id: launchCheckoutId, Kind: LaunchStepCheckout, State: LaunchStepPending}}
	for _, step := range recipe.Prepare {
		steps = append(steps, LaunchStep{Id: "prepare-" + step.Id, Kind: LaunchStepPrepare, Title: step.Title, Run: step.Run, Cwd: step.Cwd, State: LaunchStepPending})
	}
	for _, server := range recipe.Servers {
		steps = append(steps, LaunchStep{Id: "server-" + server.Id, Kind: LaunchStepServer, Title: server.Title, Run: server.Run, Cwd: server.Cwd, Port: server.Port, State: LaunchStepPending})
	}
	return steps
}

func launchUrl(recipe *LaunchRecipe) string {
	if recipe.Url != "" {
		return recipe.Url
	}
	for _, server := range recipe.Servers {
		if server.Port > 0 {
			return fmt.Sprintf("http://localhost:%d", server.Port)
		}
	}
	return ""
}

func checkLaunchTarget(target LaunchTarget) error {
	switch target.Kind {
	case LaunchTargetPr:
		if target.Number <= 0 || target.Branch == "" {
			return fmt.Errorf("a pull request launch names its number and branch")
		}
	case LaunchTargetBranch:
		if target.Branch == "" {
			return fmt.Errorf("a branch launch names its branch")
		}
	case LaunchTargetTrunk:
	default:
		return fmt.Errorf("unknown launch target %q", target.Kind)
	}
	if strings.HasPrefix(target.Branch, "-") || strings.ContainsAny(target.Branch, " \t\n~^:?*[\\") {
		return fmt.Errorf("%q is not a branch name", target.Branch)
	}
	return nil
}

// Start replaces the project's running version with target. The checks a confirmation answers (uncommitted changes,
// busy ports) are made again here: a launch never goes further than what the developer confirmed.
func (l *Launches) Start(req LaunchStartRequest) (LaunchState, error) {
	if err := checkDir(req.Dir); err != nil {
		return LaunchState{}, err
	}
	if err := checkLaunchTarget(req.Target); err != nil {
		return LaunchState{}, err
	}
	recipe := l.recipes.get(req.Dir)
	if recipe == nil {
		return LaunchState{}, uimsg.Errorf(uimsg.Make("mission.launch.noRecipe"), "the project has no confirmed launch recipe")
	}
	plan, err := l.Plan(LaunchPlanRequest{Dir: req.Dir, Target: req.Target})
	if err != nil {
		return LaunchState{}, err
	}
	if plan.DirtyCount > 0 && !req.Stash {
		return LaunchState{}, uimsg.Errorf(uimsg.Make("mission.launch.dirty", "count", strconv.Itoa(plan.DirtyCount)),
			"%d files have uncommitted changes in %s", plan.DirtyCount, plan.ServeDir)
	}
	if len(plan.Holders) > 0 && !req.StopPorts {
		return LaunchState{}, uimsg.Errorf(uimsg.Make("mission.launch.portsBusy", "ports", holderPorts(plan.Holders)),
			"other processes listen on port %s", holderPorts(plan.Holders))
	}
	if req.Target.Kind == LaunchTargetTrunk && req.Target.Branch == "" {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		req.Target.Branch, _ = resolveTrunk(ctx, l.git, req.Dir)
		cancel()
		if req.Target.Branch == "" {
			return LaunchState{}, uimsg.Errorf(uimsg.Make("mission.launch.noTrunk"), "the project's trunk is unknown")
		}
	}
	previous := l.stopActive(req.Dir)
	now := l.now()
	state := &LaunchState{Dir: filepath.Clean(req.Dir), Id: newRunId(now), Target: req.Target, ServeDir: plan.ServeDir, Worktree: plan.Worktree,
		State: LaunchStateStarting, Steps: launchSteps(recipe), Url: launchUrl(recipe), StartedAt: now.UnixMilli()}
	if previous != nil && previous.Previous != "" && !previous.Worktree {
		state.Previous = previous.Previous
	}
	os.RemoveAll(filepath.Join(l.projectDir(req.Dir), launchLogsDir))
	os.MkdirAll(filepath.Join(l.projectDir(req.Dir), launchLogsDir), 0700)
	l.lock.Lock()
	l.states[state.Dir] = state
	l.writeStateLocked(state)
	rtn := *copyLaunchState(state)
	l.lock.Unlock()
	if l.publish != nil {
		l.publish(rtn)
	}
	l.startRun(state.Dir, launchOptions{stash: req.Stash, stopPorts: req.StopPorts, previous: previous}, 0)
	return rtn, nil
}

func holderPorts(holders []LaunchPortHolder) string {
	seen := map[int]bool{}
	ports := []int{}
	for _, holder := range holders {
		if !seen[holder.Port] {
			seen[holder.Port] = true
			ports = append(ports, holder.Port)
		}
	}
	sort.Ints(ports)
	parts := []string{}
	for _, port := range ports {
		parts = append(parts, strconv.Itoa(port))
	}
	return strings.Join(parts, ", ")
}

type launchOptions struct {
	stash     bool
	stopPorts bool
	// The version this launch replaces: its servers are stopped first.
	previous *LaunchState
}

func (l *Launches) startRun(dir string, opts launchOptions, from int) {
	ctx, cancel := context.WithCancel(context.Background())
	run := &launchRun{cancel: cancel, done: make(chan struct{})}
	l.lock.Lock()
	l.runs[dir] = run
	l.lock.Unlock()
	go func() {
		defer func() {
			panichandler.PanicHandler("molten:mission:launch", recover())
		}()
		defer close(run.done)
		defer cancel()
		l.run(ctx, dir, opts, from)
		l.lock.Lock()
		if l.runs[dir] == run {
			delete(l.runs, dir)
		}
		l.lock.Unlock()
	}()
}

// stopActive cancels the launch on its way, stops the running version's servers, and returns that version.
func (l *Launches) stopActive(dir string) *LaunchState {
	dir = filepath.Clean(dir)
	l.lock.Lock()
	run := l.runs[dir]
	l.lock.Unlock()
	if run != nil {
		run.cancel()
		<-run.done
	}
	l.lock.Lock()
	state := copyLaunchState(l.loadLocked(dir))
	l.lock.Unlock()
	if state == nil {
		return nil
	}
	l.stopServers(state)
	return state
}

func (l *Launches) markStopping(pid int, stopping bool) {
	l.lock.Lock()
	defer l.lock.Unlock()
	if stopping {
		l.stopping[pid] = true
		return
	}
	delete(l.stopping, pid)
}

func (l *Launches) isStopping(pid int) bool {
	l.lock.Lock()
	defer l.lock.Unlock()
	return l.stopping[pid]
}

func (l *Launches) exitedChan(pid int) chan struct{} {
	l.lock.Lock()
	defer l.lock.Unlock()
	return l.exited[pid]
}

// stopGroup stops a server's process group: SIGTERM, then SIGKILL after the grace.
func (l *Launches) stopGroup(pid int) {
	if pid <= 0 {
		return
	}
	l.markStopping(pid, true)
	stopRunGroup(pid)
	deadline := time.Now().Add(launchStopGrace)
	exited := l.exitedChan(pid)
	for time.Now().Before(deadline) {
		if exited != nil {
			select {
			case <-exited:
				return
			case <-time.After(launchPollInterval):
			}
			continue
		}
		if !processAlive(pid) {
			return
		}
		time.Sleep(launchPollInterval)
	}
	killRunGroup(pid)
}

func (l *Launches) stopServers(state *LaunchState) {
	var wg sync.WaitGroup
	for _, step := range state.Steps {
		if step.Kind != LaunchStepServer || step.Pid <= 0 || (step.State != LaunchStepRunning && step.State != LaunchStepDone) {
			continue
		}
		wg.Add(1)
		go func(pid int) {
			defer wg.Done()
			l.stopGroup(pid)
		}(step.Pid)
	}
	wg.Wait()
	l.setState(state.Dir, func(s *LaunchState) {
		if s.Id != state.Id {
			return
		}
		for i := range s.Steps {
			if s.Steps[i].State == LaunchStepRunning || (s.Steps[i].Kind == LaunchStepServer && s.Steps[i].State == LaunchStepDone) {
				s.Steps[i].State = LaunchStepStopped
				s.Steps[i].FinishedAt = l.now().UnixMilli()
			}
		}
		if launchActive(s) {
			s.State = LaunchStateStopped
		}
	})
}

// Stop stops the project's version; the checkout stays as it is.
func (l *Launches) Stop(req LaunchDirRequest) (LaunchState, error) {
	if err := checkDir(req.Dir); err != nil {
		return LaunchState{}, err
	}
	l.stopActive(req.Dir)
	return l.State(req)
}

// Retry runs a failed launch again from its failed step.
func (l *Launches) Retry(req LaunchDirRequest) (LaunchState, error) {
	if err := checkDir(req.Dir); err != nil {
		return LaunchState{}, err
	}
	dir := filepath.Clean(req.Dir)
	l.lock.Lock()
	state := l.loadLocked(dir)
	running := l.runs[dir] != nil
	l.lock.Unlock()
	if state == nil || state.State != LaunchStateFailed || running {
		return LaunchState{}, uimsg.Errorf(uimsg.Make("mission.launch.notFailed"), "no failed launch to retry")
	}
	from := 0
	for i, step := range state.Steps {
		if step.State != LaunchStepDone {
			from = i
			break
		}
	}
	if l.recipes.get(dir) == nil {
		return LaunchState{}, uimsg.Errorf(uimsg.Make("mission.launch.noRecipe"), "the project has no confirmed launch recipe")
	}
	rtn := l.setState(dir, func(s *LaunchState) {
		s.State = LaunchStateStarting
		s.Error, s.ErrorText = "", nil
		for i := from; i < len(s.Steps); i++ {
			if s.Steps[i].State == LaunchStepRunning {
				continue
			}
			s.Steps[i].State = LaunchStepPending
			s.Steps[i].Error, s.Steps[i].ErrorText = "", nil
			s.Steps[i].Pid = 0
		}
	})
	l.startRun(dir, launchOptions{}, from)
	return rtn, nil
}

// ReadLog reads a step's log from an offset.
func (l *Launches) ReadLog(req LaunchLogRequest) (LogChunk, error) {
	if err := checkDir(req.Dir); err != nil {
		return LogChunk{}, err
	}
	if !pipelineStepIdOk(req.Step) {
		return LogChunk{}, fmt.Errorf("unknown step %q", req.Step)
	}
	file, err := os.Open(l.logFile(req.Dir, req.Step))
	if os.IsNotExist(err) {
		return LogChunk{}, nil
	}
	if err != nil {
		return LogChunk{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return LogChunk{}, err
	}
	from := req.From
	if from < 0 || from > info.Size() {
		from = 0
	}
	if info.Size()-from > maxLogRead {
		from = info.Size() - maxLogRead
	}
	file.Seek(from, io.SeekStart)
	data, _ := io.ReadAll(io.LimitReader(file, maxLogRead))
	return LogChunk{Text: string(data), Size: from + int64(len(data))}, nil
}

func pipelineStepIdOk(id string) bool {
	if id == "" || strings.Contains(id, "..") {
		return false
	}
	return !strings.ContainsAny(id, `/\`)
}

func (l *Launches) openLog(dir string, step string) (*os.File, error) {
	if err := os.MkdirAll(filepath.Join(l.projectDir(dir), launchLogsDir), 0700); err != nil {
		return nil, err
	}
	return os.OpenFile(l.logFile(dir, step), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
}

func (l *Launches) stepState(dir string, id string, i int, change func(step *LaunchStep)) {
	l.setState(dir, func(s *LaunchState) {
		if s.Id != id || i >= len(s.Steps) {
			return
		}
		change(&s.Steps[i])
	})
}

func (l *Launches) fail(dir string, id string, i int, text *uimsg.Text, english string) {
	l.setState(dir, func(s *LaunchState) {
		if s.Id != id {
			return
		}
		l.failLocked(s, i, text, english)
	})
}

func (l *Launches) run(ctx context.Context, dir string, opts launchOptions, from int) {
	l.lock.Lock()
	state := copyLaunchState(l.loadLocked(dir))
	l.lock.Unlock()
	if state == nil {
		return
	}
	recipe := l.recipes.get(dir)
	if recipe == nil {
		l.fail(dir, state.Id, -1, uimsg.Make("mission.launch.noRecipe"), "the project has no confirmed launch recipe")
		return
	}
	if from == 0 && opts.stopPorts {
		if err := l.stopHolders(ctx, recipe); err != nil {
			l.fail(dir, state.Id, 0, uimsg.Make("mission.launch.portHolderStuck", "ports", err.Error()), "a process keeps listening on port "+err.Error())
			return
		}
	}
	for i := from; i < len(state.Steps); i++ {
		if ctx.Err() != nil {
			return
		}
		step := state.Steps[i]
		var ok bool
		switch step.Kind {
		case LaunchStepCheckout:
			ok = l.runCheckout(ctx, state, i, opts)
		case LaunchStepPrepare:
			ok = l.runPrepare(ctx, state, i)
		case LaunchStepServer:
			ok = l.runServer(ctx, state, i)
		}
		if !ok {
			return
		}
		l.lock.Lock()
		state = copyLaunchState(l.loadLocked(dir))
		l.lock.Unlock()
		if state == nil {
			return
		}
	}
	if ctx.Err() != nil {
		return
	}
	l.setState(dir, func(s *LaunchState) {
		if s.Id != state.Id || s.State != LaunchStateStarting {
			return
		}
		s.State = LaunchStateRunning
		s.ReadyAt = l.now().UnixMilli()
	})
	l.lock.Lock()
	l.watchLocked(dir)
	l.lock.Unlock()
}

// stopHolders stops the processes other than the launch's own on the recipe's ports and waits for the ports.
func (l *Launches) stopHolders(ctx context.Context, recipe *LaunchRecipe) error {
	holdersCtx, cancel := context.WithTimeout(ctx, launchHoldersTimeout)
	holders := l.foreignHolders(holdersCtx, recipe, map[int]bool{})
	cancel()
	for _, holder := range holders {
		if holder.Pid > 0 {
			stopProcess(holder.Pid)
		}
	}
	deadline := time.Now().Add(launchStopGrace)
	for time.Now().Before(deadline) {
		busy := false
		for _, holder := range holders {
			busy = busy || (holder.Pid > 0 && processAlive(holder.Pid)) || (holder.Pid == 0 && portAccepts(holder.Port))
		}
		if !busy {
			return nil
		}
		time.Sleep(launchPollInterval)
	}
	for _, holder := range holders {
		killProcess(holder.Pid)
	}
	time.Sleep(launchPollInterval)
	stuck := []LaunchPortHolder{}
	for _, holder := range holders {
		if portAccepts(holder.Port) {
			stuck = append(stuck, holder)
		}
	}
	if len(stuck) > 0 {
		return errors.New(holderPorts(stuck))
	}
	return nil
}

func (l *Launches) logLine(w io.Writer, format string, args ...any) {
	fmt.Fprintf(w, "▶ "+format+"\n", args...)
}

func (l *Launches) logGit(ctx context.Context, w io.Writer, dir string, args ...string) (string, error) {
	l.logLine(w, "git %s", strings.Join(args, " "))
	gitCtx, cancel := context.WithTimeout(ctx, launchGitTimeout)
	defer cancel()
	out, err := l.gitOut(gitCtx, dir, args...)
	if out != "" {
		fmt.Fprintln(w, out)
	}
	if err != nil {
		fmt.Fprintln(w, err.Error())
	}
	return out, err
}

// resolveCommit is the commit the target's head is at: a PR's head fetched from origin (its branch, else GitHub's
// pull/<N>/head), an Upcoming branch's local tip (else origin's).
func (l *Launches) resolveCommit(ctx context.Context, w io.Writer, dir string, target LaunchTarget) (string, error) {
	local := func() string {
		sha, err := l.logGit(ctx, w, dir, "rev-parse", "--verify", "-q", "refs/heads/"+target.Branch+"^{commit}")
		if err != nil {
			return ""
		}
		return sha
	}
	fetch := func(ref string) string {
		if _, err := l.logGit(ctx, w, dir, "fetch", "--no-tags", "origin", ref); err != nil {
			return ""
		}
		sha, err := l.logGit(ctx, w, dir, "rev-parse", "--verify", "-q", "FETCH_HEAD^{commit}")
		if err != nil {
			return ""
		}
		return sha
	}
	if target.Kind == LaunchTargetBranch {
		if sha := local(); sha != "" {
			return sha, nil
		}
		if sha := fetch("refs/heads/" + target.Branch); sha != "" {
			return sha, nil
		}
		return "", fmt.Errorf("the branch %s is neither here nor on origin", target.Branch)
	}
	if sha := fetch("refs/heads/" + target.Branch); sha != "" {
		return sha, nil
	}
	if sha := fetch(fmt.Sprintf("refs/pull/%d/head", target.Number)); sha != "" {
		return sha, nil
	}
	if sha := local(); sha != "" {
		return sha, nil
	}
	return "", fmt.Errorf("the head of PR #%d could not be fetched", target.Number)
}

func (l *Launches) runCheckout(ctx context.Context, state *LaunchState, i int, opts launchOptions) bool {
	dir := state.Dir
	l.stepState(dir, state.Id, i, func(step *LaunchStep) {
		step.State = LaunchStepRunning
		step.StartedAt = l.now().UnixMilli()
	})
	logFile, err := l.openLog(dir, launchCheckoutId)
	if err != nil {
		l.fail(dir, state.Id, i, uimsg.Make("mission.launch.gitFailed", "detail", err.Error()), err.Error())
		return false
	}
	defer logFile.Close()
	failGit := func(err error) bool {
		l.fail(dir, state.Id, i, uimsg.Make("mission.launch.gitFailed", "detail", err.Error()), err.Error())
		return false
	}
	if state.Worktree {
		l.logLine(logFile, "serving the worktree %s as it is", state.ServeDir)
		commit, _ := l.logGit(ctx, logFile, state.ServeDir, "rev-parse", "HEAD")
		return l.checkoutDone(state, i, commit, "", "")
	}
	serve := state.ServeDir
	dirty, err := l.dirtyFiles(ctx, serve)
	if err != nil {
		return failGit(err)
	}
	previous := state.Previous
	if branch, err := l.gitOut(ctx, serve, "symbolic-ref", "--short", "-q", "HEAD"); err == nil && branch != "" {
		previous = branch
	}
	stash := ""
	if len(dirty) > 0 {
		if !opts.stash {
			l.fail(dir, state.Id, i, uimsg.Make("mission.launch.dirty", "count", strconv.Itoa(len(dirty))),
				fmt.Sprintf("%d files have uncommitted changes in %s", len(dirty), serve))
			return false
		}
		stash = fmt.Sprintf("moltenterm launch %s, before %s", l.now().Format("2006-01-02 15:04"), launchTargetLabel(state.Target))
		if _, err := l.logGit(ctx, logFile, serve, "stash", "push", "-m", stash); err != nil {
			return failGit(err)
		}
	}
	if state.Target.Kind == LaunchTargetTrunk {
		if _, err := l.logGit(ctx, logFile, serve, "checkout", state.Target.Branch); err != nil {
			return failGit(err)
		}
		if _, err := l.gitOut(ctx, serve, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"); err == nil {
			if _, err := l.logGit(ctx, logFile, serve, "pull", "--ff-only", "--no-tags"); err != nil {
				return failGit(err)
			}
		}
		commit, _ := l.gitOut(ctx, serve, "rev-parse", "HEAD")
		return l.checkoutDone(state, i, commit, "", stash)
	}
	sha, err := l.resolveCommit(ctx, logFile, serve, state.Target)
	if err != nil {
		l.fail(dir, state.Id, i, uimsg.Make("mission.launch.fetchFailed", "branch", state.Target.Branch, "detail", err.Error()), err.Error())
		return false
	}
	if _, err := l.logGit(ctx, logFile, serve, "checkout", "--detach", sha); err != nil {
		return failGit(err)
	}
	return l.checkoutDone(state, i, sha, previous, stash)
}

func (l *Launches) checkoutDone(state *LaunchState, i int, commit string, previous string, stash string) bool {
	l.setState(state.Dir, func(s *LaunchState) {
		if s.Id != state.Id {
			return
		}
		s.Commit = commit
		if state.Target.Kind == LaunchTargetTrunk {
			s.Previous = ""
		} else if previous != "" {
			s.Previous = previous
		}
		if stash != "" {
			s.Stash = stash
		}
		s.Steps[i].State = LaunchStepDone
		s.Steps[i].FinishedAt = l.now().UnixMilli()
	})
	return true
}

func launchTargetLabel(target LaunchTarget) string {
	if target.Kind == LaunchTargetPr {
		return fmt.Sprintf("PR #%d", target.Number)
	}
	return target.Branch
}

func (l *Launches) stepCommand(state *LaunchState, step LaunchStep, logFile *os.File) *exec.Cmd {
	cmd := exec.Command("/bin/sh", "-c", step.Run)
	cmd.Dir = filepath.Join(state.ServeDir, filepath.FromSlash(step.Cwd))
	cmd.Env = append(commandEnv(), "MOLTEN_LAUNCH_DIR="+state.ServeDir, "MOLTEN_LAUNCH_COMMIT="+state.Commit, "MOLTEN_LAUNCH_BRANCH="+state.Target.Branch)
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.Stdin = nil
	detachRun(cmd)
	return cmd
}

// lastLogLine is a failed step's reason as its log tells it.
func (l *Launches) lastLogLine(dir string, step string) string {
	data, err := os.ReadFile(l.logFile(dir, step))
	if err != nil {
		return ""
	}
	if len(data) > 8192 {
		data = data[len(data)-8192:]
	}
	last, lastOwn := "", ""
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		last = line
		if !launchRunnerTrailer(line) {
			lastOwn = line
		}
	}
	// The package manager's own report of the failure says less than the script's last words.
	if lastOwn != "" {
		last = lastOwn
	}
	if len(last) > 300 {
		last = last[:300] + "…"
	}
	return last
}

var launchRunnerTrailers = []string{"npm error", "npm ERR!", "error Command failed", "info Visit https://yarnpkg.com", " ELIFECYCLE ", "ERR_PNPM_", "error: script \"", "▶ "}

func launchRunnerTrailer(line string) bool {
	for _, trailer := range launchRunnerTrailers {
		if strings.HasPrefix(line, trailer) || (strings.HasPrefix(trailer, " ") && strings.Contains(line, trailer)) {
			return true
		}
	}
	return false
}

func (l *Launches) runPrepare(ctx context.Context, state *LaunchState, i int) bool {
	step := state.Steps[i]
	logFile, err := l.openLog(state.Dir, step.Id)
	if err != nil {
		l.fail(state.Dir, state.Id, i, uimsg.Make("mission.launch.startFailed", "detail", err.Error()), err.Error())
		return false
	}
	defer logFile.Close()
	l.logLine(logFile, "%s", step.Run)
	cmd := l.stepCommand(state, step, logFile)
	if err := cmd.Start(); err != nil {
		l.fail(state.Dir, state.Id, i, uimsg.Make("mission.launch.startFailed", "detail", err.Error()), err.Error())
		return false
	}
	l.stepState(state.Dir, state.Id, i, func(s *LaunchStep) {
		s.State = LaunchStepRunning
		s.Pid = cmd.Process.Pid
		s.StartedAt = l.now().UnixMilli()
	})
	waited := make(chan error, 1)
	go func() { waited <- cmd.Wait() }()
	select {
	case <-ctx.Done():
		stopRunGroup(cmd.Process.Pid)
		select {
		case <-waited:
		case <-time.After(launchStopGrace):
			killRunGroup(cmd.Process.Pid)
			<-waited
		}
		return false
	case err = <-waited:
	}
	if err != nil {
		code := -1
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			code = exitErr.ExitCode()
		}
		last := l.lastLogLine(state.Dir, step.Id)
		l.fail(state.Dir, state.Id, i, uimsg.Make("mission.launch.stepFailed", "code", strconv.Itoa(code), "line", last),
			fmt.Sprintf("exit %d: %s", code, last))
		return false
	}
	l.stepState(state.Dir, state.Id, i, func(s *LaunchStep) {
		s.State = LaunchStepDone
		s.FinishedAt = l.now().UnixMilli()
	})
	return true
}

func (l *Launches) runServer(ctx context.Context, state *LaunchState, i int) bool {
	step := state.Steps[i]
	logFile, err := l.openLog(state.Dir, step.Id)
	if err != nil {
		l.fail(state.Dir, state.Id, i, uimsg.Make("mission.launch.startFailed", "detail", err.Error()), err.Error())
		return false
	}
	defer logFile.Close()
	l.logLine(logFile, "%s", step.Run)
	cmd := l.stepCommand(state, step, logFile)
	if err := cmd.Start(); err != nil {
		l.fail(state.Dir, state.Id, i, uimsg.Make("mission.launch.startFailed", "detail", err.Error()), err.Error())
		return false
	}
	pid := cmd.Process.Pid
	exited := make(chan struct{})
	l.lock.Lock()
	l.exited[pid] = exited
	l.lock.Unlock()
	go func() {
		err := cmd.Wait()
		exitCode := 0
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			exitCode = exitErr.ExitCode()
		}
		// Recorded before the end is announced: whoever waits for it then reads the state it left.
		l.serverExited(state.Dir, state.Id, i, pid, exitCode)
		close(exited)
	}()
	l.stepState(state.Dir, state.Id, i, func(s *LaunchStep) {
		s.State = LaunchStepRunning
		s.Pid = pid
		s.StartedAt = l.now().UnixMilli()
	})
	deadline := time.Now().Add(l.readyTimeout)
	for step.Port > 0 && !portAccepts(step.Port) {
		select {
		case <-ctx.Done():
			return false
		case <-exited:
			return false
		case <-time.After(launchPollInterval):
		}
		if time.Now().After(deadline) {
			// Stopped, so that Retry does not start it a second time.
			l.stopGroup(pid)
			l.fail(state.Dir, state.Id, i, uimsg.Make("mission.launch.notReady", "port", strconv.Itoa(step.Port), "seconds", strconv.Itoa(int(l.readyTimeout.Seconds()))),
				fmt.Sprintf("port %d did not answer within %s", step.Port, l.readyTimeout))
			return false
		}
	}
	select {
	case <-exited:
		return false
	default:
	}
	l.stepState(state.Dir, state.Id, i, func(s *LaunchStep) {
		if s.State == LaunchStepRunning {
			s.State = LaunchStepDone
		}
	})
	return true
}

// serverExited fails the launch a server belonged to, unless it was stopped on purpose.
func (l *Launches) serverExited(dir string, id string, i int, pid int, code int) {
	stopping := l.isStopping(pid)
	l.lock.Lock()
	delete(l.exited, pid)
	delete(l.stopping, pid)
	l.lock.Unlock()
	if stopping {
		return
	}
	l.setState(dir, func(s *LaunchState) {
		if s.Id != id || i >= len(s.Steps) || s.Steps[i].Pid != pid || s.Steps[i].State == LaunchStepStopped {
			return
		}
		last := l.lastLogLine(dir, s.Steps[i].Id)
		l.failLocked(s, i, uimsg.Make("mission.launch.serverExited", "code", strconv.Itoa(code), "line", last), fmt.Sprintf("the server stopped (exit %d): %s", code, last))
	})
}

// watchLocked follows a running version's servers this wavesrv did not start (after a restart).
func (l *Launches) watchLocked(dir string) {
	if l.watching[dir] {
		return
	}
	l.watching[dir] = true
	go func() {
		defer func() {
			panichandler.PanicHandler("molten:mission:launch-watch", recover())
		}()
		defer func() {
			l.lock.Lock()
			delete(l.watching, dir)
			l.lock.Unlock()
		}()
		for {
			time.Sleep(launchWatchInterval)
			l.lock.Lock()
			state := copyLaunchState(l.states[dir])
			l.lock.Unlock()
			if state == nil || state.State != LaunchStateRunning {
				return
			}
			for i, step := range state.Steps {
				if step.Kind != LaunchStepServer || step.Pid <= 0 || step.State != LaunchStepDone {
					continue
				}
				if l.exitedChan(step.Pid) != nil || l.isStopping(step.Pid) || processAlive(step.Pid) {
					continue
				}
				l.setState(dir, func(s *LaunchState) {
					if s.Id != state.Id || s.Steps[i].Pid != step.Pid || s.Steps[i].State != LaunchStepDone {
						return
					}
					l.failLocked(s, i, uimsg.Make("mission.launch.serverExited", "code", "?", "line", l.lastLogLine(dir, step.Id)),
						"the server stopped")
				})
			}
		}
	}()
}
