// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// Sync of a stale dependency (FR-MC-030, DS-MC-020): the dependent's declared `sync` runs in its own root, through the
// trust rule like every declared command, with MOLTEN_DEP_SOURCE_DIR pointing at a clean worktree of the source at the
// watched branch's tip, so the user's checkout of the source (on another branch, or dirty) is never what is read.
// MoltenTerm commits nothing: the flag clears once the output reaches the dependent's trunk (DS-MC-019), or at once
// when the sync changed nothing, recorded in MoltenTerm's data folder rather than as an empty commit. Nothing is
// written in either project but what the user's own command writes (NFR-MC-006); the worktree's administrative entry
// in the source's .git lives only while the sync runs, as for the CI and the builds.

// must match frontend/moltenterm-shell/mission/mission-client.ts and cmd/wsh/cmd/wshcmd-molten-projectsync.go
const (
	DepSyncCommand         = "moltenmissiondepsync"
	DepSyncOutcomeChanged  = "changed"
	DepSyncOutcomeNoChange = "nochange"
	depSyncTreePrefix      = "deps-"
	// A worktree add checks out the whole source: a large repository takes a while.
	depSyncGitTimeout = 10 * time.Minute
	depSyncCancelPoll = 500 * time.Millisecond
	depAckFileVersion = 1
)

// Tests shorten them.
var (
	depSyncTimeout = 30 * time.Minute
	// A command that ignores SIGTERM is killed this long after it.
	depSyncKillGrace = 10 * time.Second
)

type DepSyncRequest struct {
	// The dependent's root.
	Dir string `json:"dir"`
	// The source, as declared or as its pipeline names it; optional when one declaration alone can be meant.
	Project string `json:"project,omitempty"`
	// The declaration's index in dependson; optional.
	Index *int `json:"index,omitempty"`
}

// DependencySyncRun is the last sync of a declaration, as the flag shows it.
type DependencySyncRun struct {
	RunId      string   `json:"runid"`
	State      string   `json:"state"`
	Exit       *int     `json:"exit,omitempty"`
	Outcome    string   `json:"outcome,omitempty"`
	Changed    []string `json:"changed,omitempty"`
	Commit     string   `json:"commit,omitempty"`
	StartedAt  int64    `json:"startedat"`
	FinishedAt int64    `json:"finishedat,omitempty"`
}

// DepSyncStepId names a declaration's sync in the run history and the trust prompt.
func DepSyncStepId(index int) string {
	return fmt.Sprintf("dependson[%d]", index)
}

// DepSyncTreesDir is where the sources' worktrees for syncs go: <data>/molten/worktrees.
func DepSyncTreesDir(dataDir string) string {
	return filepath.Join(dataDir, "molten", "worktrees")
}

// DepAcksDir holds the no-change acknowledgements: <data>/molten/deps.
func DepAcksDir(dataDir string) string {
	return filepath.Join(dataDir, "molten", "deps")
}

// UseSync makes Sync available: acknowledgements under acksDir, worktrees under treesDir.
func (g *Groups) UseSync(acks *DepAcks, treesDir string) {
	g.lock.Lock()
	defer g.lock.Unlock()
	g.acks = acks
	g.treesDir = treesDir
}

// A no-change acknowledgement (DS-MC-019): the declaration is in sync while Commit is still the source's newest commit
// touching its paths.
type DependencyAck struct {
	Source    string `json:"source"`
	SourceDir string `json:"sourcedir"`
	Commit    string `json:"commit"`
	At        int64  `json:"at"`
}

type depAckFile struct {
	Version int                      `json:"version"`
	Dir     string                   `json:"dir"`
	Acks    map[string]DependencyAck `json:"acks"`
}

type DepAcks struct {
	lock sync.Mutex
	dir  string
}

func MakeDepAcks(dir string) *DepAcks {
	return &DepAcks{dir: dir}
}

func (a *DepAcks) file(dependentDir string) string {
	return filepath.Join(a.dir, projectKey(dependentDir)+".json")
}

func (a *DepAcks) readLocked(dependentDir string) depAckFile {
	acks := depAckFile{Version: depAckFileVersion, Dir: dependentDir, Acks: map[string]DependencyAck{}}
	var stored depAckFile
	if readJson(a.file(dependentDir), &stored) && stored.Dir == dependentDir && stored.Acks != nil {
		acks.Acks = stored.Acks
	}
	return acks
}

func (a *DepAcks) Get(dependentDir string, key string) (DependencyAck, bool) {
	a.lock.Lock()
	defer a.lock.Unlock()
	ack, ok := a.readLocked(dependentDir).Acks[key]
	return ack, ok
}

func (a *DepAcks) Record(dependentDir string, key string, ack DependencyAck) error {
	a.lock.Lock()
	defer a.lock.Unlock()
	acks := a.readLocked(dependentDir)
	acks.Acks[key] = ack
	if err := os.MkdirAll(a.dir, 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(acks, "", "  ")
	if err != nil {
		return err
	}
	tmp := a.file(dependentDir) + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, a.file(dependentDir))
}

// depAckKey keys an acknowledgement by what the declaration reads and writes: changing it makes the old one moot.
func depAckKey(dep molten.PipelineDependency) string {
	data, _ := json.Marshal([]any{strings.ToLower(strings.TrimSpace(dep.Project)), dep.Paths, strings.TrimSpace(dep.Branch), dep.Output})
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:12])
}

// withAcknowledgement clears a flagged dependency that a sync of the source's current commit left unchanged.
func (g *Groups) withAcknowledgement(dependentDir string, dep molten.PipelineDependency, state DependencyState) DependencyState {
	if g.acks == nil || !state.Flagged() || state.Source == nil {
		return state
	}
	ack, ok := g.acks.Get(dependentDir, depAckKey(dep))
	if !ok || ack.Commit != state.Source.Sha || ack.SourceDir != state.SourceDir {
		return state
	}
	state.State, state.Acknowledged = DepStateInSync, ack.At
	state.Commits, state.MoreCommits, state.Changed, state.Uncommitted = nil, false, nil, nil
	return state
}

// withLastSyncs attaches to each declaration its last sync from the dependent's run history.
func (g *Groups) withLastSyncs(dependentDir string, states []DependencyState, runs []RunRecord) []DependencyState {
	if g.runs == nil || len(states) == 0 {
		return states
	}
	if runs == nil {
		runs = g.runs.List(dependentDir)
	}
	rtn := make([]DependencyState, len(states))
	for i, state := range states {
		for _, rec := range runs {
			if rec.Kind != RunKindSync || rec.StepId != DepSyncStepId(state.Index) {
				continue
			}
			state.LastSync = &DependencySyncRun{RunId: rec.Id, State: rec.State, Exit: rec.Exit, Outcome: rec.Outcome, Changed: rec.Changed,
				Commit: rec.Commit, StartedAt: rec.StartedAt, FinishedAt: rec.FinishedAt}
			break
		}
		rtn[i] = state
	}
	return rtn
}

// pickSyncDeclaration finds the declaration a request means; flagged tells which ones are stale, read only when the
// request names none of several.
func pickSyncDeclaration(declared []molten.PipelineDependency, req DepSyncRequest, flagged func(index int) bool) (int, error) {
	project := strings.TrimSpace(req.Project)
	if req.Index != nil {
		i := *req.Index
		if i < 0 || i >= len(declared) {
			return -1, fmt.Errorf("the project declares no dependency %s", DepSyncStepId(i))
		}
		if project != "" && !molten.SameProjectName(declared[i].Project, project) {
			return -1, fmt.Errorf("%s is a dependency on %s, not on %s", DepSyncStepId(i), strings.TrimSpace(declared[i].Project), project)
		}
		if declared[i].Sync == "" {
			return -1, fmt.Errorf("no sync command is declared for the dependency on %s: add \"sync\" to it in %s", strings.TrimSpace(declared[i].Project), molten.ProjectPipelineFile)
		}
		return i, nil
	}
	var named, withSync []int
	for i, dep := range declared {
		if project != "" && !molten.SameProjectName(dep.Project, project) {
			continue
		}
		named = append(named, i)
		if dep.Sync != "" {
			withSync = append(withSync, i)
		}
	}
	switch {
	case len(named) == 0 && project != "":
		return -1, fmt.Errorf("the project declares no dependency on %s", project)
	case len(named) == 0:
		return -1, errors.New("the project declares no dependency (\"dependson\")")
	case len(withSync) == 0 && project != "":
		return -1, fmt.Errorf("no sync command is declared for the dependency on %s: add \"sync\" to it in %s", project, molten.ProjectPipelineFile)
	case len(withSync) == 0:
		return -1, fmt.Errorf("no dependency declares a sync command: add \"sync\" to one in %s", molten.ProjectPipelineFile)
	case len(withSync) == 1:
		return withSync[0], nil
	}
	var stale []int
	for _, i := range withSync {
		if flagged(i) {
			stale = append(stale, i)
		}
	}
	if len(stale) == 1 {
		return stale[0], nil
	}
	var names []string
	for _, i := range withSync {
		names = append(names, fmt.Sprintf("%s (%s)", strings.TrimSpace(declared[i].Project), DepSyncStepId(i)))
	}
	return -1, fmt.Errorf("several dependencies declare a sync, name one: %s", strings.Join(names, ", "))
}

// claimSync holds the dependent for one sync, named by its run id: only that sync releases it, however many times.
func (g *Groups) claimSync(dir string, runId string) bool {
	g.lock.Lock()
	defer g.lock.Unlock()
	if g.syncing == nil {
		g.syncing = map[string]string{}
	}
	if g.syncing[dir] != "" {
		return false
	}
	g.syncing[dir] = runId
	return true
}

func (g *Groups) releaseSync(dir string, runId string) {
	g.lock.Lock()
	defer g.lock.Unlock()
	if g.syncing[dir] == runId {
		delete(g.syncing, dir)
	}
}

func (g *Groups) syncSetup() (*DepAcks, string) {
	g.lock.Lock()
	defer g.lock.Unlock()
	return g.acks, g.treesDir
}

func (g *Groups) useTree(tree string, inUse bool) {
	g.lock.Lock()
	defer g.lock.Unlock()
	if g.syncTrees == nil {
		g.syncTrees = map[string]bool{}
	}
	if inUse {
		g.syncTrees[tree] = true
	} else {
		delete(g.syncTrees, tree)
	}
}

func (g *Groups) treeInUse(tree string) bool {
	g.lock.Lock()
	defer g.lock.Unlock()
	return g.syncTrees[tree]
}

// depSync is what a sync needs once it is allowed to start.
type depSync struct {
	dir        string
	dep        molten.PipelineDependency
	sourceDir  string
	sourceName string
	// The watched branch's tip, checked out in the worktree, and the newest commit touching paths at that tip.
	tip        string
	ackCommit  string
	acks       *DepAcks
	treesDir   string
	dependency DependencyState
}

// Sync starts the sync of one of the dependent's declarations (FR-MC-030). The command is read again from the file
// on disk, never taken from the request; untrusted, nothing runs and the commands come back for the user to review.
func (g *Groups) Sync(req DepSyncRequest) (RunResult, error) {
	acks, treesDir := g.syncSetup()
	if g.runs == nil || acks == nil || treesDir == "" {
		return RunResult{}, errors.New("syncing a dependency is not available")
	}
	if err := checkDir(req.Dir); err != nil {
		return RunResult{}, err
	}
	dir := filepath.Clean(req.Dir)
	report := molten.ValidatePipeline(dir)
	if !report.Valid {
		if !report.Present {
			return RunResult{}, errors.New("the project has no pipeline (.molten/project.json)")
		}
		return RunResult{}, fmt.Errorf("the pipeline has problems: %s", strings.Join(report.Errors, "; "))
	}
	group, member, err := g.memberOf(dir)
	if err != nil {
		return RunResult{}, err
	}
	name := report.Pipeline.Name
	if name == "" {
		name = member.Name
	}
	// Trust comes first: an untrusted request reads no repository.
	commands := PipelineCommands(report.Pipeline)
	hash := CommandsHash(commands)
	if !g.runs.trust.IsTrusted(dir, hash) {
		return RunResult{Untrusted: &UntrustedInfo{Hash: hash, Commands: commands}}, nil
	}
	declared := report.Pipeline.DependsOn
	evaluated := map[int]DependencyState{}
	evaluateAt := func(i int) DependencyState {
		if state, ok := evaluated[i]; ok {
			return state
		}
		ctx, cancel := context.WithTimeout(context.Background(), depEvaluateTimeout)
		defer cancel()
		state := EvaluateDependency(ctx, g.run, group, dir, name, i, declared[i], g.now(), nil)
		evaluated[i] = g.withAcknowledgement(dir, declared[i], state)
		return evaluated[i]
	}
	index, err := pickSyncDeclaration(declared, req, func(i int) bool { return evaluateAt(i).Flagged() })
	if err != nil {
		return RunResult{}, err
	}
	state := evaluateAt(index)
	switch state.State {
	case DepStateInvalid, DepStateSourceNotFound, DepStateBranchNotFound, DepStateError:
		return RunResult{}, fmt.Errorf("cannot sync from %s: %s", strings.TrimSpace(declared[index].Project), state.Problem)
	}
	now := g.now()
	runId := newRunId(now)
	if !g.claimSync(dir, runId) {
		return RunResult{}, errors.New("a sync of this project is already running")
	}
	started := false
	defer func() {
		if !started {
			g.releaseSync(dir, runId)
		}
	}()
	s := depSync{dir: dir, dep: declared[index], sourceDir: state.SourceDir, sourceName: state.SourceName, acks: acks, treesDir: treesDir, dependency: state}
	if err := g.readTip(&s, state.sourceRef); err != nil {
		return RunResult{}, err
	}
	rec := RunRecord{
		Id:        runId,
		Dir:       dir,
		Kind:      RunKindSync,
		StepId:    DepSyncStepId(index),
		Title:     "Sync from " + state.SourceName,
		Command:   s.dep.Sync,
		StartedAt: now.UnixMilli(),
		State:     RunStateRunning,
		Phases:    []string{},
		Commit:    s.tip,
		Source:    state.SourceName,
		Branch:    state.Branch,
		// wavesrv follows a sync itself until it ended and its outcome is known: no reader settles it from the log.
		Preparing: true,
	}
	if err := os.MkdirAll(filepath.Join(g.runs.projectDir(dir), rec.Id), 0700); err != nil {
		return RunResult{}, err
	}
	// Marked before the record exists: a List in between would take it for a sync whose wavesrv stopped.
	g.runs.setPreparing(rec.Id, true)
	if err := g.runs.writeRecord(rec); err != nil {
		g.runs.setPreparing(rec.Id, false)
		return RunResult{}, err
	}
	started = true
	if g.runs.publish != nil {
		g.runs.publish(rec)
	}
	go g.runSync(s, rec)
	// The flag shows the sync running; its end refreshes the groups through the collector (the run event).
	go g.Refreshed()
	return RunResult{Run: &rec}, nil
}

// readTip reads the watched branch's tip and the newest commit touching paths there, the one an acknowledgement names.
func (g *Groups) readTip(s *depSync, ref string) error {
	if !strings.HasPrefix(ref, "refs/") {
		return fmt.Errorf("the watched branch of %s could not be read", s.sourceName)
	}
	ctx, cancel := context.WithTimeout(context.Background(), depEvaluateTimeout)
	defer cancel()
	src := &gitReader{ctx: WithRunEnv(ctx, "GIT_NO_LAZY_FETCH=1"), run: g.run, dir: s.sourceDir}
	tip, err := src.out("rev-parse", "--verify", ref+"^{commit}")
	if err != nil || !depShaRegex.MatchString(strings.TrimSpace(tip)) {
		return fmt.Errorf("reading %s of %s: %v", shortRef(ref), s.sourceName, err)
	}
	s.tip = strings.TrimSpace(tip)
	newest, err := src.newestTouching(s.tip, depPathspecs(s.dep.Paths), true)
	if err != nil {
		return fmt.Errorf("reading %s's history: %w", s.sourceName, err)
	}
	if newest != nil {
		s.ackCommit = newest.Sha
	}
	return nil
}

// syncLog writes a sync's own lines in its log, between the command's.
type syncLog struct {
	file *os.File
}

func (l syncLog) say(format string, args ...any) {
	fmt.Fprintf(l.file, format+"\n", args...)
}

func (g *Groups) runSync(s depSync, rec RunRecord) {
	ended := false
	defer func() {
		panichandler.PanicHandler("molten:mission:depsync", recover())
		// A sync that stopped without its end written (a panic) still releases the dependent and reads as ended.
		if !ended {
			g.endSync(rec, RunStateFailure, nil, "", nil)
		}
	}()
	end := func(state string, exit *int, outcome string, changed []string) {
		ended = true
		g.endSync(rec, state, exit, outcome, changed)
	}
	file, err := os.OpenFile(g.runs.logFile(rec.Dir, rec.Id), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		end(RunStateFailure, nil, "", nil)
		return
	}
	defer file.Close()
	log := syncLog{file: file}
	log.say("sync of %s from %s, %s @ %s", filepath.Base(s.dir), s.sourceName, s.dependency.Ref, shortSha(s.tip))
	tree, err := g.addSourceTree(s, rec.Id, log)
	if err != nil {
		log.say("%v", err)
		end(RunStateFailure, nil, "", nil)
		return
	}
	defer g.removeSourceTree(s, tree, log)
	if g.runs.checkCancelAsked(rec.Id) {
		g.removeSourceTree(s, tree, log)
		log.say("cancelled")
		rec.Cancelled = true
		end(RunStateCancelled, nil, "", nil)
		return
	}
	before := g.outputStatus(s)
	if len(before) > 0 {
		log.say("note: %s already had uncommitted changes before the sync", strings.Join(before, ", "))
	}
	log.say("$ %s", s.dep.Sync)
	result := g.runSyncCommand(s, &rec, tree, file)
	if result.err != nil {
		log.say("%v", result.err)
	}
	g.removeSourceTree(s, tree, log)
	code := result.code
	switch {
	case result.timedOut:
		log.say("the sync ran for more than %s and was stopped: the dependency stays stale", depSyncTimeout)
		end(RunStateFailure, &code, "", nil)
		return
	case result.cancelled:
		rec.Cancelled = true
		log.say("cancelled")
		end(RunStateCancelled, &code, "", nil)
		return
	case code != 0:
		log.say("the sync failed (exit %d): the dependency stays stale", code)
		end(RunStateFailure, &code, "", nil)
		return
	}
	outcome, changed, err := g.syncOutcome(s)
	if err != nil {
		log.say("what the sync changed could not be read (%v): nothing is recorded, the flag follows git", err)
	}
	switch outcome {
	case DepSyncOutcomeNoChange:
		if err := s.acks.Record(s.dir, depAckKey(s.dep), DependencyAck{Source: s.sourceName, SourceDir: s.sourceDir, Commit: s.ackCommit, At: g.now().UnixMilli()}); err != nil {
			log.say("the sync could not be recorded: %v", err)
		}
		log.say("in sync, no change: nothing to commit")
	case DepSyncOutcomeChanged:
		log.say("synced, not committed: %s", strings.Join(changed, ", "))
		log.say("review and commit them on %s to clear the flag", s.dependency.Trunk)
	}
	end(RunStateSuccess, &code, outcome, changed)
}

// addSourceTree checks the watched branch's tip out in a worktree of the source's own, under MoltenTerm's data
// folder; the source's hooks and fsmonitor do not run (core.hooksPath points at an empty folder). A partial clone may
// still fetch the files it lacks: the sync needs them. Leftovers of a sync that MoltenTerm could not finish are
// removed first.
func (g *Groups) addSourceTree(s depSync, runId string, log syncLog) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), depSyncGitTimeout)
	defer cancel()
	parent := filepath.Join(s.treesDir, projectKey(s.sourceDir))
	g.removeLeftoverTrees(ctx, s, parent, log)
	noHooks := filepath.Join(s.treesDir, "nohooks")
	if err := os.MkdirAll(noHooks, 0700); err != nil {
		return "", err
	}
	if err := os.MkdirAll(parent, 0700); err != nil {
		return "", err
	}
	tree := filepath.Join(parent, depSyncTreePrefix+runId)
	g.useTree(tree, true)
	log.say("$ git worktree add --detach %s %s", tree, shortSha(s.tip))
	out, err := g.run(ctx, s.sourceDir, "git", "-c", "core.hooksPath="+noHooks, "-c", "core.fsmonitor=false", "worktree", "add", "--detach", "--quiet", tree, s.tip)
	if len(out) > 0 {
		log.file.Write(out)
	}
	if err != nil {
		g.useTree(tree, false)
		os.RemoveAll(tree)
		return "", fmt.Errorf("the worktree of %s could not be created: %w", s.sourceName, err)
	}
	return tree, nil
}

// removeSourceTree removes the sync's worktree and its entry in the source's .git; called again after it is gone, it
// does nothing.
func (g *Groups) removeSourceTree(s depSync, tree string, log syncLog) {
	if !g.treeInUse(tree) {
		return
	}
	defer g.useTree(tree, false)
	ctx, cancel := context.WithTimeout(context.Background(), depSyncGitTimeout)
	defer cancel()
	if _, err := g.run(ctx, s.sourceDir, "git", "worktree", "remove", "--force", tree); err == nil {
		return
	}
	os.RemoveAll(tree)
	if _, err := g.run(ctx, s.sourceDir, "git", "worktree", "prune"); err != nil {
		log.say("the worktree %s could not be removed: %v", tree, err)
	}
}

func (g *Groups) removeLeftoverTrees(ctx context.Context, s depSync, parent string, log syncLog) {
	entries, err := os.ReadDir(parent)
	if err != nil {
		return
	}
	removed := false
	for _, entry := range entries {
		tree := filepath.Join(parent, entry.Name())
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), depSyncTreePrefix) || g.treeInUse(tree) {
			continue
		}
		if _, err := g.run(ctx, s.sourceDir, "git", "worktree", "remove", "--force", tree); err != nil {
			os.RemoveAll(tree)
		}
		removed = true
	}
	if removed {
		log.say("removed the worktrees left by an interrupted sync")
		g.run(ctx, s.sourceDir, "git", "worktree", "prune")
	}
}

func syncEnv(s depSync, tree string, runId string) []string {
	return append(commandEnv(), "MOLTEN_DEP_SOURCE_DIR="+tree, "MOLTEN_DEP_SOURCE_COMMIT="+s.tip, "MOLTEN_DEP_PROJECT="+s.sourceName,
		"MOLTEN_RUN_ID="+runId)
}

type syncCommandResult struct {
	code      int
	cancelled bool
	timedOut  bool
	err       error
}

// runSyncCommand runs the declared command in the dependent's root, in a session of its own so a cancel stops all it
// started, and waits for it. A cancel or the time limit sends SIGTERM to the group, then SIGKILL after a grace delay:
// a command that ignores SIGTERM must not hold the dependent forever.
func (g *Groups) runSyncCommand(s depSync, rec *RunRecord, tree string, out *os.File) syncCommandResult {
	cmd := exec.Command("/bin/sh", "-c", s.dep.Sync)
	cmd.Dir = s.dir
	cmd.Env = syncEnv(s, tree, rec.Id)
	cmd.Stdout = out
	cmd.Stderr = out
	cmd.Stdin = nil
	detachRun(cmd)
	if err := cmd.Start(); err != nil {
		return syncCommandResult{code: 1, err: fmt.Errorf("starting the sync: %w", err)}
	}
	rec.Pid = cmd.Process.Pid
	g.runs.writeRecord(*rec)
	if g.runs.publish != nil {
		g.runs.publish(*rec)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	ticker := time.NewTicker(depSyncCancelPoll)
	defer ticker.Stop()
	deadline := time.After(depSyncTimeout)
	var kill <-chan time.Time
	result := syncCommandResult{}
	stop := func() {
		stopRunGroup(rec.Pid)
		kill = time.After(depSyncKillGrace)
	}
	for {
		select {
		case err := <-done:
			if err == nil {
				return result
			}
			result.code = 1
			var exitErr *exec.ExitError
			if !errors.As(err, &exitErr) {
				result.err = err
				return result
			}
			if code := exitErr.ExitCode(); code > 0 {
				result.code = code
			}
			return result
		case <-ticker.C:
			if !result.cancelled && !result.timedOut && g.runs.checkCancelAsked(rec.Id) {
				result.cancelled = true
				stop()
			}
		case <-deadline:
			if !result.cancelled && !result.timedOut {
				result.timedOut = true
				stop()
			}
		case <-kill:
			killRunGroup(rec.Pid)
			kill = nil
		}
	}
}

// outputStatus lists the output files changed or untracked in the dependent.
func (g *Groups) outputStatus(s depSync) []string {
	ctx, cancel := context.WithTimeout(context.Background(), depEvaluateTimeout)
	defer cancel()
	dependent := &gitReader{ctx: WithRunEnv(ctx, "GIT_NO_LAZY_FETCH=1"), run: g.run, dir: s.dir}
	files, _ := dependent.uncommitted(depPathspecs(s.dep.Output))
	return files
}

// syncOutcome reads what a successful sync left: output files changed against HEAD, or a HEAD whose output differs
// from the trunk's, is a change to review and commit; the same output as the trunk's is no change. When git cannot
// say, the outcome is unknown: no acknowledgement is recorded.
func (g *Groups) syncOutcome(s depSync) (string, []string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), depEvaluateTimeout)
	defer cancel()
	dependent := &gitReader{ctx: WithRunEnv(ctx, "GIT_NO_LAZY_FETCH=1"), run: g.run, dir: s.dir}
	specs := depPathspecs(s.dep.Output)
	uncommitted, err := dependent.uncommitted(specs)
	if err != nil {
		return "", nil, err
	}
	if len(uncommitted) > 0 {
		return DepSyncOutcomeChanged, uncommitted, nil
	}
	_, trunkRefs, err := dependent.dependentTrunk()
	if err != nil {
		return "", nil, err
	}
	var changed []string
	var lastErr error
	for _, entry := range trunkRefs {
		ref, _, _ := strings.Cut(entry, "\t")
		args := append([]string{"-c", "core.quotePath=false", "diff", "--name-only", ref, "HEAD", "--"}, specs...)
		out, err := dependent.out(args...)
		if err != nil {
			lastErr = err
			continue
		}
		if strings.TrimSpace(out) == "" {
			return DepSyncOutcomeNoChange, nil, nil
		}
		if changed == nil {
			changed = strings.Split(strings.TrimSpace(out), "\n")
		}
	}
	if changed == nil {
		if lastErr == nil {
			lastErr = errors.New("the trunk could not be compared")
		}
		return "", nil, lastErr
	}
	if len(changed) > maxDepUncommitted {
		changed = changed[:maxDepUncommitted]
	}
	return DepSyncOutcomeChanged, changed, nil
}

// endSync writes a sync's final record; the run event refreshes the dependent's snapshot through the collector, and
// the groups follow it.
func (g *Groups) endSync(rec RunRecord, state string, exit *int, outcome string, changed []string) {
	// The next sync may start as soon as this one reads as ended.
	defer g.releaseSync(rec.Dir, rec.Id)
	defer g.runs.setPreparing(rec.Id, false)
	rec.Preparing = false
	rec.State = state
	rec.Exit = exit
	rec.Outcome = outcome
	rec.Changed = changed
	rec.FinishedAt = g.now().UnixMilli()
	if data, err := os.Stat(g.runs.logFile(rec.Dir, rec.Id)); err == nil {
		rec.LogSize = data.Size()
	}
	g.runs.writeRecord(rec)
	if g.runs.publish != nil {
		g.runs.publish(rec)
	}
	g.runs.prune(rec.Dir)
	if g.collector == nil {
		go g.Refreshed()
	}
}
