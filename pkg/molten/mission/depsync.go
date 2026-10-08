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
	depSyncGitTimeout      = 2 * time.Minute
	depSyncTimeout         = 30 * time.Minute
	depSyncCancelPoll      = 500 * time.Millisecond
	depAckFileVersion      = 1
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
func (g *Groups) withLastSyncs(dependentDir string, states []DependencyState) []DependencyState {
	if g.runs == nil || len(states) == 0 {
		return states
	}
	runs := g.runs.List(dependentDir)
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

func (g *Groups) claimSync(dir string) bool {
	g.lock.Lock()
	defer g.lock.Unlock()
	if g.syncing == nil {
		g.syncing = map[string]bool{}
	}
	if g.syncing[dir] {
		return false
	}
	g.syncing[dir] = true
	return true
}

func (g *Groups) releaseSync(dir string) {
	g.lock.Lock()
	defer g.lock.Unlock()
	delete(g.syncing, dir)
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

// fullRef turns the ref an evaluation read back into the ref it came from: origin's branch, else the local one.
func fullRef(ref string) string {
	if strings.HasPrefix(ref, "origin/") {
		return "refs/remotes/" + ref
	}
	return "refs/heads/" + ref
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
	commands := PipelineCommands(report.Pipeline)
	hash := CommandsHash(commands)
	if !g.runs.trust.IsTrusted(dir, hash) {
		return RunResult{Untrusted: &UntrustedInfo{Hash: hash, Commands: commands}}, nil
	}
	state := evaluateAt(index)
	switch state.State {
	case DepStateInvalid, DepStateSourceNotFound, DepStateBranchNotFound, DepStateError:
		return RunResult{}, fmt.Errorf("cannot sync from %s: %s", strings.TrimSpace(declared[index].Project), state.Problem)
	}
	if !g.claimSync(dir) {
		return RunResult{}, errors.New("a sync of this project is already running")
	}
	started := false
	defer func() {
		if !started {
			g.releaseSync(dir)
		}
	}()
	s := depSync{dir: dir, dep: declared[index], sourceDir: state.SourceDir, sourceName: state.SourceName, acks: acks, treesDir: treesDir, dependency: state}
	if err := g.readTip(&s, state.Ref); err != nil {
		return RunResult{}, err
	}
	now := g.now()
	rec := RunRecord{
		Id:        newRunId(now),
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
	if err := g.runs.writeRecord(rec); err != nil {
		return RunResult{}, err
	}
	g.runs.setPreparing(rec.Id, true)
	started = true
	g.runs.prune(dir)
	if g.runs.publish != nil {
		g.runs.publish(rec)
	}
	go g.runSync(s, rec)
	go g.Refreshed()
	return RunResult{Run: &rec}, nil
}

// readTip reads the watched branch's tip and the newest commit touching paths there, the one an acknowledgement names.
func (g *Groups) readTip(s *depSync, ref string) error {
	ctx, cancel := context.WithTimeout(context.Background(), depEvaluateTimeout)
	defer cancel()
	src := &gitReader{ctx: WithRunEnv(ctx, "GIT_NO_LAZY_FETCH=1"), run: g.run, dir: s.sourceDir}
	tip, err := src.out("rev-parse", "--verify", fullRef(ref)+"^{commit}")
	if err != nil || !depShaRegex.MatchString(strings.TrimSpace(tip)) {
		return fmt.Errorf("reading %s of %s: %v", ref, s.sourceName, err)
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
	defer func() {
		panichandler.PanicHandler("molten:mission:depsync", recover())
	}()
	defer g.releaseSync(s.dir)
	defer g.runs.setPreparing(rec.Id, false)
	file, err := os.OpenFile(g.runs.logFile(rec.Dir, rec.Id), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		g.endSync(rec, RunStateFailure, nil, "", nil)
		return
	}
	defer file.Close()
	log := syncLog{file: file}
	log.say("sync of %s from %s, %s @ %s", filepath.Base(s.dir), s.sourceName, s.dependency.Ref, shortSha(s.tip))
	tree, err := g.addSourceTree(s, rec.Id, log)
	if err != nil {
		log.say("%v", err)
		g.endSync(rec, RunStateFailure, nil, "", nil)
		return
	}
	defer g.removeSourceTree(s, tree, log)
	if g.runs.checkCancelAsked(rec.Id) {
		log.say("cancelled")
		rec.Cancelled = true
		g.endSync(rec, RunStateCancelled, nil, "", nil)
		return
	}
	log.say("$ %s", s.dep.Sync)
	code, cancelled, err := g.runSyncCommand(s, &rec, tree, file)
	if err != nil {
		log.say("%v", err)
	}
	g.removeSourceTree(s, tree, log)
	switch {
	case cancelled:
		rec.Cancelled = true
		log.say("cancelled")
		g.endSync(rec, RunStateCancelled, &code, "", nil)
		return
	case code != 0:
		log.say("the sync failed (exit %d): the dependency stays stale", code)
		g.endSync(rec, RunStateFailure, &code, "", nil)
		return
	}
	outcome, changed, err := g.syncOutcome(s)
	if err != nil {
		log.say("the output could not be read: %v", err)
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
	g.endSync(rec, RunStateSuccess, &code, outcome, changed)
}

// addSourceTree checks the watched branch's tip out in a worktree of the source's own, under MoltenTerm's data
// folder; the source's hooks do not run (core.hooksPath points at an empty folder). Leftovers of a sync that
// MoltenTerm could not finish are removed first.
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
	out, err := g.run(ctx, s.sourceDir, "git", "-c", "core.hooksPath="+noHooks, "worktree", "add", "--detach", "--quiet", tree, s.tip)
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

// runSyncCommand runs the declared command in the dependent's root, in a session of its own so a cancel stops all it
// started, and waits for it; it reports the exit code and whether it was cancelled (or ran out of time).
func (g *Groups) runSyncCommand(s depSync, rec *RunRecord, tree string, out *os.File) (int, bool, error) {
	cmd := exec.Command("/bin/sh", "-c", s.dep.Sync)
	cmd.Dir = s.dir
	cmd.Env = syncEnv(s, tree, rec.Id)
	cmd.Stdout = out
	cmd.Stderr = out
	cmd.Stdin = nil
	detachRun(cmd)
	if err := cmd.Start(); err != nil {
		return 1, false, fmt.Errorf("starting the sync: %w", err)
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
	stopped := false
	for {
		select {
		case err := <-done:
			if err == nil {
				return 0, stopped, nil
			}
			var exitErr *exec.ExitError
			if errors.As(err, &exitErr) {
				code := exitErr.ExitCode()
				if code < 0 {
					code = 1
				}
				return code, stopped, nil
			}
			return 1, stopped, err
		case <-ticker.C:
			if !stopped && g.runs.checkCancelAsked(rec.Id) {
				stopped = true
				stopRunGroup(rec.Pid)
			}
		case <-deadline:
			if !stopped {
				stopped = true
				fmt.Fprintf(out, "the sync ran for more than %s: stopped\n", depSyncTimeout)
				stopRunGroup(rec.Pid)
			}
		}
	}
}

// syncOutcome reads what a successful sync left: output files changed against HEAD, or a HEAD whose output differs
// from the trunk's, is a change to review and commit; otherwise the sync changed nothing.
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
	if err != nil || len(trunkRefs) == 0 {
		return DepSyncOutcomeNoChange, nil, nil
	}
	var changed []string
	for _, entry := range trunkRefs {
		ref, _, _ := strings.Cut(entry, "\t")
		args := append([]string{"-c", "core.quotePath=false", "diff", "--name-only", ref, "HEAD", "--"}, specs...)
		out, err := dependent.out(args...)
		if err != nil {
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
		return DepSyncOutcomeNoChange, nil, nil
	}
	if len(changed) > maxDepUncommitted {
		changed = changed[:maxDepUncommitted]
	}
	return DepSyncOutcomeChanged, changed, nil
}

// endSync writes a sync's final record; the run event refreshes the dependent's snapshot, and the groups follow.
func (g *Groups) endSync(rec RunRecord, state string, exit *int, outcome string, changed []string) {
	// The next sync may start as soon as this one reads as ended.
	defer g.releaseSync(rec.Dir)
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
	go g.Refreshed()
}
