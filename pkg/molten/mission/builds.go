// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// Local builds (FR-MC-012, FR-MC-013, DS-MC-011): a build is made from the trunk as it is on the remote, in a worktree
// of the project's own, never in the user's checkout. wavesrv fetches, moves the worktree, verifies the commit with the
// local CI when the build asks for it, runs its prepare command, then starts the build command detached as any run.

const (
	buildPrepareTimeout = 15 * time.Minute
	buildCiPoll         = time.Second
	ManifestFileName    = "manifest.json"
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
	now := r.now()
	rec := RunRecord{
		Id:        newRunId(now),
		Dir:       dir,
		Kind:      RunKindBuild,
		StepId:    build.Id,
		Title:     build.Title,
		Command:   expandCommand(build.Run, r.buildVars(dir, version)),
		Cwd:       build.Cwd,
		Artifact:  artifactPath(dir, build.Artifact),
		StartedAt: now.UnixMilli(),
		State:     RunStateRunning,
		Phases:    []string{},
		BuildKind: build.Kind,
		Preparing: true,
	}
	if rec.Title == "" {
		rec.Title = build.Id
	}
	if err := os.MkdirAll(filepath.Join(r.projectDir(dir), rec.Id), 0700); err != nil {
		return rec, err
	}
	if err := r.writeRecord(rec); err != nil {
		return rec, err
	}
	r.setPreparing(rec.Id, true)
	r.prune(dir)
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
	b.rec.Cancelled = b.rec.Cancelled || b.cancelled()
	b.r.update(b.rec)
	b.r.settle(b.rec)
	b.r.writeRecord(*b.rec)
	if b.r.publish != nil {
		b.r.publish(*b.rec)
	}
}

func (b *buildLog) cancelled() bool {
	return b.r.checkCancelAsked(b.rec.Id)
}

// finish ends a build that stopped before its command: the exit line is how every reader knows the outcome.
func (b *buildLog) finish(code int) {
	b.rec.Cancelled = b.cancelled()
	fmt.Fprintf(b.file, "exit=%d\n", code)
	b.rec.Preparing = false
	b.refresh()
}

func (r *Runs) prepareAndLaunch(rec RunRecord, build molten.PipelineBuild) {
	defer func() {
		panichandler.PanicHandler("molten:mission:build", recover())
	}()
	defer r.setPreparing(rec.Id, false)
	file, err := os.OpenFile(r.logFile(rec.Dir, rec.Id), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return
	}
	defer file.Close()
	b := &buildLog{r: r, rec: &rec, file: file}
	ctx, cancel := context.WithTimeout(context.Background(), buildPrepareTimeout)
	defer cancel()
	tree, err := r.prepareBuildTree(ctx, b)
	if err != nil {
		b.say("%v", err)
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
		prepare := expandCommand(build.Prepare.Run, r.buildVars(rec.Dir, ""))
		b.say("$ %s", prepare)
		code, err := runBuildCommand(filepath.Join(tree, build.Prepare.Cwd), prepare, build.Prepare.Env, rec, file)
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

func (r *Runs) prepareBuildTree(ctx context.Context, b *buildLog) (string, error) {
	dir := b.rec.Dir
	trunk, _ := resolveTrunk(ctx, r.git, dir)
	if trunk == "" {
		return "", errors.New("the project has no trunk branch to build from")
	}
	b.say("$ git fetch origin %s", trunk)
	if out, err := r.git(ctx, dir, "git", "fetch", "--quiet", "origin", trunk); err != nil {
		b.say("%s%v: building the last fetched %s", out, err, trunk)
	}
	_, ref := resolveTrunk(ctx, r.git, dir)
	shaOut, err := r.git(ctx, dir, "git", "rev-parse", "--verify", ref+"^{commit}")
	if err != nil {
		return "", fmt.Errorf("%s could not be read: %w", ref, err)
	}
	b.rec.Commit = strings.TrimSpace(string(shaOut))
	b.say("building %s @ %s", ref, shortSha(b.rec.Commit))
	tree := r.buildTreeDir(dir)
	step := func(where string, args ...string) error {
		out, err := r.git(ctx, where, "git", args...)
		if len(out) > 0 {
			b.file.Write(out)
		}
		return err
	}
	if _, err := os.Stat(filepath.Join(tree, ".git")); err != nil {
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
		res, err := r.ci.Start(CiRunRequest{Dir: b.rec.Dir, Branch: b.rec.Commit})
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
	for {
		select {
		case <-ctx.Done():
			r.ci.Cancel(b.rec.Dir, run.Id)
			return false
		case <-time.After(buildCiPoll):
		}
		if b.cancelled() {
			r.ci.Cancel(b.rec.Dir, run.Id)
		}
		current, err := r.ci.readRecord(b.rec.Dir, run.Id)
		if err != nil || current.Status == CiStateRunning {
			continue
		}
		for _, job := range current.Jobs {
			b.say("  %-14s %s", job.Name, job.Status)
		}
		if current.Error != "" {
			b.say("%s", current.Error)
		}
		if current.Status != CiStateSuccess {
			b.say("the local CI is not green on %s: the build stops", shortSha(b.rec.Commit))
			return false
		}
		return true
	}
}

func buildEnv(extra map[string]string, rec RunRecord) []string {
	env := commandEnv()
	for k, v := range extra {
		env = append(env, k+"="+v)
	}
	return append(env, "MOLTEN_RUN_ID="+rec.Id, "MOLTEN_BUILD_COMMIT="+rec.Commit)
}

func runBuildCommand(cwd string, run string, env map[string]string, rec RunRecord, out *os.File) (int, error) {
	cmd := exec.Command("/bin/sh", "-c", run)
	cmd.Dir = cwd
	cmd.Env = buildEnv(env, rec)
	cmd.Stdout = out
	cmd.Stderr = out
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
	cmd := exec.Command("/bin/sh", "-c", `( `+b.rec.Command+` ); echo "exit=$?"`)
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
	b.rec.Cancelled = b.rec.Cancelled || b.cancelled()
	r.writeRecord(*b.rec)
	if b.rec.Cancelled {
		stopRunGroup(b.rec.Pid)
	}
	go cmd.Wait()
	r.watch(*b.rec)
	if r.publish != nil {
		r.publish(*b.rec)
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
	if path == "" {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil || len(data) > 1<<20 {
		return nil
	}
	var m BuildManifest
	if json.Unmarshal(data, &m) != nil || m.Commit == "" {
		return nil
	}
	return &m
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
