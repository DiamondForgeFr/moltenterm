// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// Local builds (FR-MC-012, FR-MC-013, DS-MC-011): a build is made from the trunk as it is on the remote, in a worktree
// of the project's own, never in the user's checkout. wavesrv fetches, moves the worktree, verifies the commit with the
// local CI when the build asks for it, runs its prepare command, then starts the build command detached as any run.
//
// Only the steps that can hang without a word are bounded, each on its own: a git step and the prepare command
// (buildStepTimeout). The local CI has no total bound, since a loaded machine can take far longer than usual (#2273): the
// build waits for it while its jobs make progress, and stops it after buildVerifyStall without any.

const (
	buildStepTimeout      = 15 * time.Minute
	buildVerifyStall      = 10 * time.Minute
	buildPrepareWaitDelay = 30 * time.Second
	buildCiPoll           = time.Second
	ManifestFileName      = "manifest.json"
	maxBuildManifestBytes = 1 << 20
)

func findBuild(p *molten.Pipeline, id string) molten.PipelineBuild {
	for _, build := range p.Builds {
		if build.Id == id {
			return build
		}
	}
	return molten.PipelineBuild{Id: id}
}

func (r *Runs) buildTreeDir(dir string) string {
	return filepath.Join(filepath.Dir(r.baseDir), "build", projectKey(dir), "tree")
}

func (r *Runs) setPreparing(runId string, preparing bool) {
	r.lock.Lock()
	defer r.lock.Unlock()
	if preparing {
		r.preparing[runId] = true
	} else {
		delete(r.preparing, runId)
		delete(r.cancelAsked, runId)
	}
}

// askCancelWhilePreparing records a cancel for a build still being prepared, and says whether it was one.
func (r *Runs) askCancelWhilePreparing(runId string) bool {
	r.lock.Lock()
	defer r.lock.Unlock()
	if !r.preparing[runId] {
		return false
	}
	r.cancelAsked[runId] = true
	return true
}

// endPreparing ends a build's preparation once its record names the build's process, and says whether a cancel was
// asked meanwhile. A cancel asked later finds that process in the record (#651).
func (r *Runs) endPreparing(runId string) bool {
	r.lock.Lock()
	defer r.lock.Unlock()
	asked := r.cancelAsked[runId]
	delete(r.preparing, runId)
	delete(r.cancelAsked, runId)
	return asked
}

func (r *Runs) checkCancelAsked(runId string) bool {
	r.lock.Lock()
	defer r.lock.Unlock()
	return r.cancelAsked[runId]
}

func (r *Runs) checkPreparing(runId string) bool {
	r.lock.Lock()
	defer r.lock.Unlock()
	return r.preparing[runId]
}

// resolveTrunk names the trunk and the ref a build starts from: the remote's when there is one.
func resolveTrunk(ctx context.Context, run Runner, dir string) (string, string) {
	g := &gitReader{ctx: ctx, run: run, dir: dir}
	trunk := ConfiguredBranches(dir).Trunk
	if g.refOf(trunk) == "" {
		trunk = g.firstExisting("develop", "main", "master")
	}
	return trunk, g.refOf(trunk)
}

func (r *Runs) startBuild(dir string, build molten.PipelineBuild, version string) (RunRecord, error) {
	project := canonicalRunDir(dir)
	r.projectDirsAt(dir, project)
	return r.startBuildAt(dir, project, build, version)
}

func (r *Runs) startBuildAt(dir, project string, build molten.PipelineBuild, version string) (RunRecord, error) {
	now := r.now()
	command, err := expandCommand(build.Run, r.buildVars(project, version))
	if err != nil {
		return RunRecord{}, err
	}
	rec := RunRecord{
		project:   project,
		Id:        newRunId(now),
		Dir:       dir,
		Kind:      RunKindBuild,
		StepId:    build.Id,
		Title:     build.Title,
		Command:   command,
		Cwd:       build.Cwd,
		Artifact:  artifactPath(project, build.Artifact),
		StartedAt: now.UnixMilli(),
		State:     RunStateRunning,
		Phases:    []string{},
		BuildKind: build.Kind,
		Preparing: true,
	}
	if rec.Title == "" {
		rec.Title = build.Id
	}
	if err := os.MkdirAll(filepath.Join(r.projectDir(project), rec.Id), 0700); err != nil {
		return rec, err
	}
	// Marked before the record exists: a List in between would take it for a build whose wavesrv stopped.
	r.setPreparing(rec.Id, true)
	if err := r.writeRecord(rec); err != nil {
		r.setPreparing(rec.Id, false)
		return rec, err
	}
	r.prune(project)
	if r.publish != nil {
		r.publish(rec)
	}
	go r.prepareAndLaunch(rec, build)
	return rec, nil
}

type buildLog struct {
	r    *Runs
	rec  *RunRecord
	file *os.File
}

func (b *buildLog) say(format string, args ...any) {
	fmt.Fprintf(b.file, format+"\n", args...)
	b.refresh()
}

func (b *buildLog) refresh() {
	b.persist()
	if b.r.publish != nil {
		b.r.publish(*b.rec)
	}
}

func (b *buildLog) persist() {
	lock := b.r.recordLock(b.rec.Dir, b.rec.Id)
	lock.Lock()
	defer lock.Unlock()
	b.rec.Cancelled = b.rec.Cancelled || b.cancelled()
	b.r.update(b.rec)
	b.r.settle(b.rec)
	b.r.writeRecord(*b.rec)
}

func (b *buildLog) cancelled() bool {
	return b.r.checkCancelAsked(b.rec.Id)
}

// stop says why the build stops, in its log and on its record: the run card and the notification read it from there.
func (b *buildLog) stop(text *uimsg.Text, format string, args ...any) {
	b.rec.Stopped = fmt.Sprintf(format, args...)
	b.rec.StoppedText = text
	b.say("%s", b.rec.Stopped)
}

func (b *buildLog) stopCancelled() {
	b.stop(uimsg.Make("mission.build.cancelled"), "Cancelled by you.")
}

// finish ends a build that stopped before its command, using the preparation's known result.
func (b *buildLog) finish(code int) {
	if b.rec.Stopped == "" && b.cancelled() {
		b.stopCancelled()
	}
	b.finishRecord(code)
	if b.r.publish != nil {
		b.r.publish(*b.rec)
	}
}

func (b *buildLog) finishRecord(code int) {
	lock := b.r.recordLock(b.rec.Dir, b.rec.Id)
	lock.Lock()
	defer lock.Unlock()
	b.rec.Cancelled = b.cancelled()
	b.r.update(b.rec)
	b.rec.Preparing = false
	b.r.complete(b.rec, code)
	b.r.settle(b.rec)
	b.r.writeRecord(*b.rec)
}

func (r *Runs) prepareAndLaunch(rec RunRecord, build molten.PipelineBuild) {
	defer func() {
		panichandler.PanicHandler("molten:mission:build", recover())
	}()
	defer r.setPreparing(rec.Id, false)
	file, err := os.OpenFile(r.logFile(rec.storageProject(), rec.Id), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return
	}
	defer file.Close()
	b := &buildLog{r: r, rec: &rec, file: file}
	ctx := context.Background()
	tree, err := r.prepareBuildTree(ctx, b)
	if err != nil {
		b.say("%v", err)
		if errors.Is(err, errBuildStepTimeout) {
			minutes := r.stepBoundMinutes()
			b.stop(uimsg.Make("mission.build.worktreeTimeout", "minutes", minutes),
				"Stopped: preparing the build's worktree took longer than %s minutes.", minutes)
		}
		b.finish(1)
		return
	}
	if build.Verify == molten.PipelineBuildVerifyCi {
		b.say("▶ phase: %s", molten.PipelineVerifyPhase)
		if !r.verifyBuild(ctx, b) {
			b.finish(1)
			return
		}
	}
	if b.cancelled() {
		b.finish(130)
		return
	}
	if build.Prepare != nil {
		prepare, err := expandCommand(build.Prepare.Run, r.buildVars(rec.storageProject(), ""))
		if err != nil {
			b.say("%v", err)
			b.finish(1)
			return
		}
		b.say("$ %s", prepare)
		stepCtx, cancel := context.WithTimeout(ctx, r.stepBound())
		code, err := runBuildCommand(stepCtx, filepath.Join(tree, build.Prepare.Cwd), prepare, build.Prepare.Env, rec, file)
		timedOut := stepCtx.Err() == context.DeadlineExceeded
		cancel()
		if timedOut {
			minutes := r.stepBoundMinutes()
			b.stop(uimsg.Make("mission.build.prepareTimeout", "minutes", minutes),
				"Stopped: the build's prepare command took longer than %s minutes.", minutes)
			b.finish(1)
			return
		}
		if err != nil || code != 0 {
			if err != nil {
				b.say("%v", err)
			}
			b.finish(max(code, 1))
			return
		}
	}
	if b.cancelled() {
		b.finish(130)
		return
	}
	r.launchBuild(b, tree, build)
}

var errBuildStepTimeout = errors.New("the step took too long")

// stepBound is how long a build's git step or prepare command may take; zero stepTimeout is buildStepTimeout.
func (r *Runs) stepBound() time.Duration {
	if r.stepTimeout > 0 {
		return r.stepTimeout
	}
	return buildStepTimeout
}

func (r *Runs) stepBoundMinutes() string {
	return strconv.Itoa(max(1, int(r.stepBound().Round(time.Minute).Minutes())))
}

// buildGit runs one git step of a build under its own bound; a step cut by it reads errBuildStepTimeout.
func (r *Runs) buildGit(ctx context.Context, dir string, args ...string) ([]byte, error) {
	stepCtx, cancel := context.WithTimeout(ctx, r.stepBound())
	defer cancel()
	out, err := r.git(stepCtx, dir, "git", args...)
	if err != nil && stepCtx.Err() == context.DeadlineExceeded {
		return out, fmt.Errorf("%w: git %s took longer than %s minutes", errBuildStepTimeout, args[0], r.stepBoundMinutes())
	}
	return out, err
}

func (r *Runs) buildTrunk(ctx context.Context, dir string) (string, string) {
	stepCtx, cancel := context.WithTimeout(ctx, r.stepBound())
	defer cancel()
	return resolveTrunk(stepCtx, r.git, dir)
}

func (r *Runs) prepareBuildTree(ctx context.Context, b *buildLog) (string, error) {
	dir := b.rec.storageProject()
	trunk, _ := r.buildTrunk(ctx, dir)
	if trunk == "" {
		return "", errors.New("the project has no trunk branch to build from")
	}
	b.say("$ git fetch origin %s", trunk)
	if out, err := r.buildGit(ctx, dir, "fetch", "--quiet", "origin", trunk); err != nil {
		b.say("%s%v: building the last fetched %s", out, err, trunk)
	}
	_, ref := r.buildTrunk(ctx, dir)
	shaOut, err := r.buildGit(ctx, dir, "rev-parse", "--verify", ref+"^{commit}")
	if err != nil {
		return "", fmt.Errorf("%s could not be read: %w", ref, err)
	}
	b.rec.Commit = strings.TrimSpace(string(shaOut))
	b.say("building %s @ %s", ref, shortSha(b.rec.Commit))
	tree := r.buildTreeDir(dir)
	step := func(where string, args ...string) error {
		out, err := r.buildGit(ctx, where, args...)
		if len(out) > 0 {
			b.file.Write(out)
		}
		return err
	}
	// A .git file whose .git/worktrees/<name> was pruned still stats fine, but every checkout in it fails.
	_, statErr := os.Stat(filepath.Join(tree, ".git"))
	if statErr == nil {
		_, statErr = r.buildGit(ctx, tree, "rev-parse", "--git-dir")
	}
	if statErr != nil {
		os.RemoveAll(tree)
		step(dir, "worktree", "prune")
		os.MkdirAll(filepath.Dir(tree), 0700)
		if err := step(dir, "worktree", "add", "--detach", "--force", tree, b.rec.Commit); err != nil {
			return "", fmt.Errorf("the build worktree could not be created: %w", err)
		}
		return tree, nil
	}
	if err := step(tree, "checkout", "--detach", "--force", b.rec.Commit); err != nil {
		return "", fmt.Errorf("the build worktree could not move to %s: %w", shortSha(b.rec.Commit), err)
	}
	if err := step(tree, "clean", "-fdq"); err != nil {
		return "", fmt.Errorf("the build worktree could not be cleaned: %w", err)
	}
	return tree, nil
}

// verifyBuild runs the local CI on the build's commit (only the jobs not green yet) and says whether it is green.
func (r *Runs) verifyBuild(ctx context.Context, b *buildLog) bool {
	if r.ci == nil {
		b.say("the local CI is not available")
		return false
	}
	var run *CiRunRecord
	for run == nil {
		if b.cancelled() {
			return false
		}
		res, err := r.ci.startAt(CiRunRequest{Dir: b.rec.Dir, Branch: b.rec.Commit}, b.rec.storageProject())
		switch {
		case err != nil && strings.Contains(err.Error(), "already green"):
			b.say("local CI already green on %s", shortSha(b.rec.Commit))
			return true
		case err != nil && strings.Contains(err.Error(), "in progress"):
			b.say("waiting for the local CI run in progress…")
			select {
			case <-ctx.Done():
				return false
			case <-time.After(5 * time.Second):
			}
			continue
		case err != nil:
			b.say("the local CI could not start: %v", err)
			return false
		case res.Run == nil:
			b.say("the project's commands are not trusted")
			return false
		}
		run = res.Run
	}
	b.say("local CI %s on %s: %d job(s)", run.Id, shortSha(b.rec.Commit), len(run.Jobs))
	watch := verifyWatch{last: r.now()}
	var stalled []string
	for {
		select {
		case <-ctx.Done():
			r.ci.Cancel(b.rec.Dir, run.Id)
			return false
		case <-time.After(r.ciPollInterval()):
		}
		if b.cancelled() {
			r.ci.Cancel(b.rec.Dir, run.Id)
		}
		// The clock is read before the progress: what it says is never later than the progress it is compared with.
		now := r.now()
		current, err := r.ci.readRecord(b.rec.Dir, run.Id)
		if err != nil {
			continue
		}
		if current.Status == CiStateRunning {
			if stalled == nil && watch.observe(now, r.ci.progressOf(b.rec.Dir, current)) >= buildVerifyStall {
				stalled = stalledJobs(current)
				r.ci.Cancel(b.rec.Dir, run.Id)
			}
			continue
		}
		for _, job := range current.Jobs {
			b.say("  %-14s %s", job.Name, job.Status)
		}
		if current.Error != "" {
			b.say("%s", current.Error)
		}
		if stalled != nil {
			jobs := strings.Join(stalled, ", ")
			minutes := strconv.Itoa(int(buildVerifyStall.Minutes()))
			b.stop(uimsg.Make("mission.build.stalled", "minutes", minutes, "jobs", jobs),
				"Stopped: the local CI made no progress for %s minutes (%s). Relaunch the build: the jobs already green are reused.", minutes, jobs)
			return false
		}
		if current.Status == CiStateSuccess {
			return true
		}
		b.say("the local CI is not green on %s: the build stops", shortSha(b.rec.Commit))
		if current.Status == CiStateCancelled && !b.cancelled() {
			b.stop(uimsg.Make("mission.build.ciCancelled"), "Stopped: its local CI run was cancelled.")
		}
		return false
	}
}

// verifyWatch tells how long a local CI run has gone without progress: it measures from the last change it saw.
type verifyWatch struct {
	last time.Time
	seen string
}

func (w *verifyWatch) observe(now time.Time, progress string) time.Duration {
	if progress != w.seen {
		w.seen = progress
		w.last = now
		return 0
	}
	return now.Sub(w.last)
}

// progressOf is what changes while a local CI run makes progress: each job's state and the size of each log it writes
// (a job's, and ci.prepare's while the run prepares). It never moves on its own: the run's heartbeat is not progress.
func (c *Ci) progressOf(dir string, run CiRunRecord) string {
	var sb strings.Builder
	logs := []string{ciPrepareLog}
	for _, job := range run.Jobs {
		fmt.Fprintf(&sb, "%s=%s;", job.Name, job.Status)
		logs = append(logs, job.Name)
	}
	for _, name := range logs {
		if info, err := os.Stat(filepath.Join(c.runDir(dir, run.Id), name+".log")); err == nil {
			fmt.Fprintf(&sb, "%s.log=%d;", name, info.Size())
		}
	}
	return sb.String()
}

// stalledJobs names the jobs a stalled run was running, or its preparation when none had started.
func stalledJobs(run CiRunRecord) []string {
	jobs := []string{}
	for _, job := range run.Jobs {
		if job.Status == CiStateRunning {
			jobs = append(jobs, job.Name)
		}
	}
	if len(jobs) == 0 {
		jobs = append(jobs, "ci.prepare")
	}
	return jobs
}

func buildEnv(extra map[string]string, rec RunRecord) []string {
	env := commandEnv()
	for k, v := range extra {
		env = append(env, k+"="+v)
	}
	return append(env, "MOLTEN_RUN_ID="+rec.Id, "MOLTEN_BUILD_COMMIT="+rec.Commit)
}

// runBuildCommand runs a build's prepare command in its own process group: once ctx ends, the whole group is stopped.
func runBuildCommand(ctx context.Context, cwd string, run string, env map[string]string, rec RunRecord, out *os.File) (int, error) {
	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", run)
	cmd.Dir = cwd
	cmd.Env = buildEnv(env, rec)
	cmd.Stdout = out
	cmd.Stderr = out
	detachRun(cmd)
	cmd.Cancel = func() error {
		return stopRunGroup(cmd.Process.Pid)
	}
	cmd.WaitDelay = buildPrepareWaitDelay
	err := cmd.Run()
	if err == nil {
		return 0, nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode(), nil
	}
	return 1, err
}

func (r *Runs) launchBuild(b *buildLog, tree string, build molten.PipelineBuild) {
	cmd := r.supervisedCommand(*b.rec)
	cmd.Dir = filepath.Join(tree, build.Cwd)
	cmd.Env = buildEnv(build.Env, *b.rec)
	cmd.Stdout = b.file
	cmd.Stderr = b.file
	cmd.Stdin = nil
	detachRun(cmd)
	if err := cmd.Start(); err != nil {
		b.say("starting %s: %v", b.rec.Title, err)
		b.finish(1)
		return
	}
	b.rec.Pid = cmd.Process.Pid
	b.rec.Preparing = false
	go cmd.Wait()
	r.handoffBuild(b.rec)
	r.watch(*b.rec)
	if r.publish != nil {
		r.publish(*b.rec)
	}
}

func (r *Runs) handoffBuild(rec *RunRecord) {
	lock := r.recordLock(rec.Dir, rec.Id)
	lock.Lock()
	defer lock.Unlock()
	r.writeRecord(*rec)
	if r.endPreparing(rec.Id) || rec.Cancelled {
		rec.Cancelled = true
		r.writeRecord(*rec)
		stopRunGroup(rec.Pid)
	}
}

// What the Build local menu shows (FR-MC-012).

type BuildManifest struct {
	ProductName string `json:"productName"`
	Version     string `json:"version"`
	BuildId     int64  `json:"buildId"`
	BuiltAt     string `json:"builtAt"`
	Commit      string `json:"commit"`
	App         string `json:"app,omitempty"`
	Notes       []any  `json:"notes,omitempty"`
}

type BuildFacts struct {
	Id          string         `json:"id"`
	Title       string         `json:"title,omitempty"`
	Description string         `json:"description,omitempty"`
	Kind        string         `json:"kind,omitempty"`
	Verify      string         `json:"verify,omitempty"`
	Artifact    string         `json:"artifact,omitempty"`
	Manifest    string         `json:"manifest,omitempty"`
	Last        *BuildManifest `json:"last,omitempty"`
}

type BuildsFacts struct {
	Trunk      string         `json:"trunk,omitempty"`
	TrunkSha   string         `json:"trunksha,omitempty"`
	Ci         *CiCodeVerdict `json:"ci,omitempty"`
	FetchError string         `json:"fetcherror,omitempty"`
	Builds     []BuildFacts   `json:"builds"`
}

func buildManifestPath(dir string, build molten.PipelineBuild) string {
	if build.Manifest != "" {
		return artifactPath(dir, build.Manifest)
	}
	if build.Artifact == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(artifactPath(dir, build.Artifact)), ManifestFileName)
}

func readBuildManifest(path string) *BuildManifest {
	return readBuildManifestWithOpener(path, openBuildManifest)
}

func readBuildManifestWithOpener(path string, open func(string) (*os.File, error)) *BuildManifest {
	if path == "" {
		return nil
	}
	before, err := os.Stat(path)
	if err != nil || !before.Mode().IsRegular() || before.Size() > maxBuildManifestBytes {
		return nil
	}
	f, err := open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	after, err := f.Stat()
	if err != nil || !after.Mode().IsRegular() || !os.SameFile(before, after) || after.Size() > maxBuildManifestBytes {
		return nil
	}
	data := readBuildManifestBytes(f)
	if data == nil {
		return nil
	}
	var m BuildManifest
	if json.Unmarshal(data, &m) != nil || m.Commit == "" {
		return nil
	}
	return &m
}

func readBuildManifestBytes(r io.Reader) []byte {
	data, err := io.ReadAll(io.LimitReader(r, maxBuildManifestBytes+1))
	if err != nil || len(data) > maxBuildManifestBytes {
		return nil
	}
	return data
}

// BuildsFacts reads the declared builds, their last delivered build and the CI's say on the trunk; fresh fetches the
// trunk first.
func (r *Runs) BuildsFacts(dir string, fresh bool) (BuildsFacts, error) {
	if err := checkDir(dir); err != nil {
		return BuildsFacts{}, err
	}
	dir = filepath.Clean(dir)
	report := molten.ValidatePipeline(dir)
	if !report.Valid {
		return BuildsFacts{Builds: []BuildFacts{}}, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), ciCommandTimeout)
	defer cancel()
	facts := BuildsFacts{Builds: []BuildFacts{}}
	trunk, ref := resolveTrunk(ctx, r.git, dir)
	facts.Trunk = trunk
	if fresh && trunk != "" {
		if _, err := r.git(ctx, dir, "git", "fetch", "--quiet", "origin", trunk); err != nil {
			facts.FetchError = err.Error()
		}
		_, ref = resolveTrunk(ctx, r.git, dir)
	}
	if ref != "" {
		if out, err := r.git(ctx, dir, "git", "rev-parse", "--verify", ref+"^{commit}"); err == nil {
			facts.TrunkSha = strings.TrimSpace(string(out))
		}
	}
	for _, build := range report.Pipeline.Builds {
		manifest := buildManifestPath(dir, build)
		facts.Builds = append(facts.Builds, BuildFacts{
			Id:          build.Id,
			Title:       build.Title,
			Description: build.Description,
			Kind:        build.Kind,
			Verify:      build.Verify,
			Artifact:    artifactPath(dir, build.Artifact),
			Manifest:    manifest,
			Last:        readBuildManifest(manifest),
		})
		if build.Verify == molten.PipelineBuildVerifyCi && facts.Ci == nil && r.ci != nil && facts.TrunkSha != "" {
			if verdict, err := r.ci.Status(dir, facts.TrunkSha); err == nil {
				facts.Ci = &verdict
			}
		}
	}
	return facts, nil
}

// buildVars: a build is made from the trunk, so {branch} is the trunk.
func (r *Runs) buildVars(dir string, version string) CommandVars {
	ctx, cancel := context.WithTimeout(context.Background(), releaseGitTimeout)
	defer cancel()
	trunk, _ := resolveTrunk(ctx, r.git, dir)
	return withBranch(versionVars(dir, version), trunk)
}
