// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// The local CI (FR-MC-011, DS-MC-010): wavesrv runs the pipeline's ci.jobs on a commit, lanes side by side and the
// jobs of a lane in order, in a worktree of the project's own, and keeps each job's verdict per git tree. A run reruns
// only the jobs not green yet on that code, so a rebase that keeps the code keeps its verdicts.

const (
	CiStateRunning     = "running"
	CiStateSuccess     = "success"
	CiStateFailure     = "failure"
	CiStateCancelled   = "cancelled"
	CiStateInterrupted = "interrupted"
	CiStateQueued      = "queued"

	CiVerdictMissing = "missing"

	ciRunFileName      = "run.json"
	ciPrepareLog       = "prepare"
	maxCiRunsPerProj   = 20
	maxCiBranches      = 40
	ciCommandTimeout   = 2 * time.Minute
	ciStatusesTimeout  = 30 * time.Second
	ciPublishScopeNote = "on the developer's machine"
)

type CiJobRecord struct {
	Name       string `json:"name"`
	Title      string `json:"title,omitempty"`
	Lane       string `json:"lane,omitempty"`
	Status     string `json:"status"`
	StartedAt  int64  `json:"startedat,omitempty"`
	FinishedAt int64  `json:"finishedat,omitempty"`
	Exit       *int   `json:"exit,omitempty"`
}

type CiRunRecord struct {
	Id         string        `json:"id"`
	Dir        string        `json:"dir"`
	Sha        string        `json:"sha"`
	Tree       string        `json:"tree"`
	Branch     string        `json:"branch,omitempty"`
	StartedAt  int64         `json:"startedat"`
	FinishedAt int64         `json:"finishedat,omitempty"`
	Status     string        `json:"status"`
	Force      bool          `json:"force,omitempty"`
	Only       []string      `json:"only,omitempty"`
	Jobs       []CiJobRecord `json:"jobs"`
	// Why the run stopped before its jobs (the worktree or ci.prepare failed).
	Error string `json:"error,omitempty"`
}

type CiVerdict struct {
	Status     string `json:"status"`
	RunId      string `json:"runid,omitempty"`
	FinishedAt int64  `json:"finishedat,omitempty"`
}

type ciTreeVerdicts struct {
	Sha  string               `json:"sha"`
	Jobs map[string]CiVerdict `json:"jobs"`
}

type CiBranch struct {
	Name    string `json:"name"`
	Sha     string `json:"sha"`
	Date    int64  `json:"date"`
	Verdict string `json:"verdict"`
}

type CiCodeVerdict struct {
	Sha     string               `json:"sha"`
	Tree    string               `json:"tree"`
	Status  string               `json:"status"`
	Failed  []string             `json:"failed,omitempty"`
	Missing []string             `json:"missing,omitempty"`
	Jobs    map[string]CiVerdict `json:"jobs"`
}

type CiState struct {
	Runs     []CiRunRecord `json:"runs"`
	Running  string        `json:"running,omitempty"`
	Branches []CiBranch    `json:"branches"`
	Current  string        `json:"current,omitempty"`
}

type CiRunRequest struct {
	Dir    string   `json:"dir"`
	Branch string   `json:"branch,omitempty"`
	Force  bool     `json:"force,omitempty"`
	Only   []string `json:"only,omitempty"`
}

type CiRunResult struct {
	Run       *CiRunRecord   `json:"run,omitempty"`
	Untrusted *UntrustedInfo `json:"untrusted,omitempty"`
}

type ciActive struct {
	runId     string
	cancelled bool
	pids      map[string]int
}

type Ci struct {
	lock    sync.Mutex
	baseDir string
	trust   *TrustStore
	run     Runner
	publish func(CiRunRecord)
	now     func() time.Time
	active  map[string]*ciActive
}

func MakeCi(baseDir string, trust *TrustStore, run Runner, publish func(CiRunRecord)) *Ci {
	return &Ci{baseDir: baseDir, trust: trust, run: run, publish: publish, now: time.Now, active: map[string]*ciActive{}}
}

func CiDir(dataDir string) string {
	return filepath.Join(dataDir, "molten", "ci")
}

func (c *Ci) projectDir(dir string) string {
	return filepath.Join(c.baseDir, projectKey(dir))
}

func (c *Ci) worktreeDir(dir string) string {
	return filepath.Join(c.projectDir(dir), "tree")
}

func (c *Ci) runDir(dir string, runId string) string {
	return filepath.Join(c.projectDir(dir), "runs", runId)
}

func (c *Ci) treeFile(dir string, tree string) string {
	return filepath.Join(c.projectDir(dir), "trees", tree+".json")
}

func (c *Ci) git(ctx context.Context, dir string, args ...string) (string, error) {
	out, err := c.run(ctx, dir, "git", args...)
	return strings.TrimSpace(string(out)), err
}

// The jobs a run starts with: the ones asked for, all of them, or those not green yet on that tree, in pipeline order.
func selectCiJobs(jobs []molten.PipelineJob, verdicts map[string]CiVerdict, force bool, only []string) []molten.PipelineJob {
	var rtn []molten.PipelineJob
	wanted := map[string]bool{}
	for _, name := range only {
		wanted[name] = true
	}
	for _, job := range jobs {
		switch {
		case len(only) > 0:
			if !wanted[job.Name] {
				continue
			}
		case !force:
			if verdicts[job.Name].Status == CiStateSuccess {
				continue
			}
		}
		rtn = append(rtn, job)
	}
	return rtn
}

// Lanes in the order their first job is declared; a job without a lane is a lane of its own.
func ciLanes(jobs []molten.PipelineJob) [][]molten.PipelineJob {
	var order []string
	byLane := map[string][]molten.PipelineJob{}
	for _, job := range jobs {
		lane := job.Lane
		if lane == "" {
			lane = "\x00" + job.Name
		}
		if _, ok := byLane[lane]; !ok {
			order = append(order, lane)
		}
		byLane[lane] = append(byLane[lane], job)
	}
	rtn := make([][]molten.PipelineJob, 0, len(order))
	for _, lane := range order {
		rtn = append(rtn, byLane[lane])
	}
	return rtn
}

// The CI's say on some code: failure if a job failed, missing if a job has no verdict yet, else success.
func codeVerdict(jobs []molten.PipelineJob, verdicts map[string]CiVerdict) (string, []string, []string) {
	var failed, missing []string
	for _, job := range jobs {
		switch verdicts[job.Name].Status {
		case CiStateSuccess:
		case CiStateFailure:
			failed = append(failed, job.Name)
		default:
			missing = append(missing, job.Name)
		}
	}
	switch {
	case len(failed) > 0:
		return CiStateFailure, failed, missing
	case len(missing) > 0:
		return CiVerdictMissing, failed, missing
	}
	return CiStateSuccess, failed, missing
}

func (c *Ci) readVerdicts(dir string, tree string) map[string]CiVerdict {
	var tv ciTreeVerdicts
	data, err := os.ReadFile(c.treeFile(dir, tree))
	if err != nil || json.Unmarshal(data, &tv) != nil || tv.Jobs == nil {
		return map[string]CiVerdict{}
	}
	return tv.Jobs
}

func (c *Ci) writeVerdict(dir string, sha string, tree string, job string, verdict CiVerdict) {
	c.lock.Lock()
	defer c.lock.Unlock()
	verdicts := c.readVerdicts(dir, tree)
	verdicts[job] = verdict
	data, _ := json.MarshalIndent(ciTreeVerdicts{Sha: sha, Jobs: verdicts}, "", "  ")
	file := c.treeFile(dir, tree)
	os.MkdirAll(filepath.Dir(file), 0700)
	writeFileAtomic(file, data)
}

func writeFileAtomic(file string, data []byte) error {
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, file)
}

func (c *Ci) writeRecord(rec CiRunRecord) error {
	data, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		return err
	}
	runDir := c.runDir(rec.Dir, rec.Id)
	if err := os.MkdirAll(runDir, 0700); err != nil {
		return err
	}
	return writeFileAtomic(filepath.Join(runDir, ciRunFileName), data)
}

func (c *Ci) readRecord(dir string, runId string) (CiRunRecord, error) {
	var rec CiRunRecord
	data, err := os.ReadFile(filepath.Join(c.runDir(dir, runId), ciRunFileName))
	if err != nil {
		return rec, err
	}
	err = json.Unmarshal(data, &rec)
	return rec, err
}

func (c *Ci) activeRun(dir string) *ciActive {
	c.lock.Lock()
	defer c.lock.Unlock()
	return c.active[projectKey(dir)]
}

// Runs, newest first; one left running by a MoltenTerm that stopped reads as interrupted.
func (c *Ci) runs(dir string) []CiRunRecord {
	entries, err := os.ReadDir(filepath.Join(c.projectDir(dir), "runs"))
	if err != nil {
		return []CiRunRecord{}
	}
	active := c.activeRun(dir)
	runs := []CiRunRecord{}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		rec, err := c.readRecord(dir, entry.Name())
		if err != nil {
			continue
		}
		if rec.Status == CiStateRunning && (active == nil || active.runId != rec.Id) {
			rec.Status = CiStateInterrupted
			for i := range rec.Jobs {
				if rec.Jobs[i].Status == CiStateRunning || rec.Jobs[i].Status == CiStateQueued {
					rec.Jobs[i].Status = CiStateInterrupted
				}
			}
			c.writeRecord(rec)
		}
		runs = append(runs, rec)
	}
	sort.Slice(runs, func(i, j int) bool { return runs[i].StartedAt > runs[j].StartedAt })
	return runs
}

func (c *Ci) prune(dir string) {
	for i, rec := range c.runs(dir) {
		if i < maxCiRunsPerProj || rec.Status == CiStateRunning {
			continue
		}
		os.RemoveAll(c.runDir(dir, rec.Id))
	}
}

func readCiPipeline(dir string) (*molten.Pipeline, error) {
	report := molten.ValidatePipeline(dir)
	if !report.Valid {
		if !report.Present {
			return nil, errors.New("the project has no pipeline (.molten/project.json)")
		}
		return nil, fmt.Errorf("the pipeline has problems: %s", strings.Join(report.Errors, "; "))
	}
	if report.Pipeline.Ci == nil || len(report.Pipeline.Ci.Jobs) == 0 {
		return nil, errors.New("the pipeline declares no CI job (ci.jobs)")
	}
	return report.Pipeline, nil
}

func (c *Ci) resolveRev(ctx context.Context, dir string, rev string) (string, string, error) {
	if rev == "" {
		rev = "HEAD"
	}
	if strings.HasPrefix(rev, "-") {
		return "", "", fmt.Errorf("invalid revision %q", rev)
	}
	sha, err := c.git(ctx, dir, "rev-parse", "--verify", "--quiet", rev+"^{commit}")
	if err != nil || sha == "" {
		return "", "", fmt.Errorf("%s is not a commit of this project", rev)
	}
	tree, err := c.git(ctx, dir, "rev-parse", sha+"^{tree}")
	if err != nil {
		return "", "", err
	}
	return sha, tree, nil
}

// Status is the CI's say on a revision's code.
func (c *Ci) Status(dir string, rev string) (CiCodeVerdict, error) {
	if err := checkDir(dir); err != nil {
		return CiCodeVerdict{}, err
	}
	dir = filepath.Clean(dir)
	pipeline, err := readCiPipeline(dir)
	if err != nil {
		return CiCodeVerdict{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), ciCommandTimeout)
	defer cancel()
	sha, tree, err := c.resolveRev(ctx, dir, rev)
	if err != nil {
		return CiCodeVerdict{}, err
	}
	verdicts := c.readVerdicts(dir, tree)
	status, failed, missing := codeVerdict(pipeline.Ci.Jobs, verdicts)
	if active := c.activeRun(dir); active != nil {
		if rec, err := c.readRecord(dir, active.runId); err == nil && rec.Tree == tree && status != CiStateFailure {
			status = CiStateRunning
		}
	}
	return CiCodeVerdict{Sha: sha, Tree: tree, Status: status, Failed: failed, Missing: missing, Jobs: verdicts}, nil
}

// State lists the runs and the local branches with the CI's say on their code.
func (c *Ci) State(dir string) (CiState, error) {
	if err := checkDir(dir); err != nil {
		return CiState{}, err
	}
	dir = filepath.Clean(dir)
	state := CiState{Runs: c.runs(dir), Branches: []CiBranch{}}
	if active := c.activeRun(dir); active != nil {
		state.Running = active.runId
	}
	ctx, cancel := context.WithTimeout(context.Background(), ciCommandTimeout)
	defer cancel()
	state.Current, _ = c.git(ctx, dir, "symbolic-ref", "--quiet", "--short", "HEAD")
	pipeline, _ := readCiPipeline(dir)
	out, err := c.git(ctx, dir, "for-each-ref", "--sort=-committerdate", "--count="+strconv.Itoa(maxCiBranches),
		"--format=%(refname:short)%09%(objectname)%09%(tree)%09%(committerdate:unix)", "refs/heads")
	if err != nil {
		return state, nil
	}
	var runningTree string
	if state.Running != "" {
		if rec, err := c.readRecord(dir, state.Running); err == nil {
			runningTree = rec.Tree
		}
	}
	for _, line := range strings.Split(out, "\n") {
		parts := strings.Split(line, "\t")
		if len(parts) != 4 {
			continue
		}
		date, _ := strconv.ParseInt(parts[3], 10, 64)
		branch := CiBranch{Name: parts[0], Sha: parts[1], Date: date * 1000, Verdict: CiVerdictMissing}
		if pipeline != nil {
			branch.Verdict, _, _ = codeVerdict(pipeline.Ci.Jobs, c.readVerdicts(dir, parts[2]))
		}
		if parts[2] == runningTree && branch.Verdict != CiStateFailure {
			branch.Verdict = CiStateRunning
		}
		state.Branches = append(state.Branches, branch)
	}
	return state, nil
}

// Start begins a local CI run, after the trust rule; untrusted commands are returned for the user to review.
func (c *Ci) Start(req CiRunRequest) (CiRunResult, error) {
	if err := checkDir(req.Dir); err != nil {
		return CiRunResult{}, err
	}
	dir := filepath.Clean(req.Dir)
	pipeline, err := readCiPipeline(dir)
	if err != nil {
		return CiRunResult{}, err
	}
	commands := PipelineCommands(pipeline)
	hash := CommandsHash(commands)
	if !c.trust.IsTrusted(dir, hash) {
		return CiRunResult{Untrusted: &UntrustedInfo{Hash: hash, Commands: commands}}, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), ciCommandTimeout)
	defer cancel()
	sha, tree, err := c.resolveRev(ctx, dir, req.Branch)
	if err != nil {
		return CiRunResult{}, err
	}
	jobs := selectCiJobs(pipeline.Ci.Jobs, c.readVerdicts(dir, tree), req.Force, req.Only)
	if len(jobs) == 0 {
		if len(req.Only) > 0 {
			return CiRunResult{}, fmt.Errorf("the pipeline declares none of the jobs %s", strings.Join(req.Only, ", "))
		}
		return CiRunResult{}, errors.New("the local CI is already green on this code: choose Run all again to run it anyway")
	}
	now := c.now()
	rec := CiRunRecord{
		Id:        newRunId(now),
		Dir:       dir,
		Sha:       sha,
		Tree:      tree,
		Branch:    req.Branch,
		StartedAt: now.UnixMilli(),
		Status:    CiStateRunning,
		Force:     req.Force,
		Only:      req.Only,
	}
	for _, job := range jobs {
		rec.Jobs = append(rec.Jobs, CiJobRecord{Name: job.Name, Title: job.Title, Lane: job.Lane, Status: CiStateQueued})
	}
	if err := c.claim(dir, rec.Id); err != nil {
		return CiRunResult{}, err
	}
	if err := c.writeRecord(rec); err != nil {
		c.release(dir, rec.Id)
		return CiRunResult{}, err
	}
	c.prune(dir)
	c.emit(rec)
	go c.execute(rec, pipeline, jobs)
	return CiRunResult{Run: &rec}, nil
}

func (c *Ci) claim(dir string, runId string) error {
	c.lock.Lock()
	defer c.lock.Unlock()
	key := projectKey(dir)
	if running := c.active[key]; running != nil {
		return fmt.Errorf("a local CI run is in progress (%s)", running.runId)
	}
	c.active[key] = &ciActive{runId: runId, pids: map[string]int{}}
	return nil
}

func (c *Ci) release(dir string, runId string) {
	c.lock.Lock()
	defer c.lock.Unlock()
	key := projectKey(dir)
	if running := c.active[key]; running != nil && running.runId == runId {
		delete(c.active, key)
	}
}

func (c *Ci) setPid(dir string, job string, pid int) bool {
	c.lock.Lock()
	defer c.lock.Unlock()
	running := c.active[projectKey(dir)]
	if running == nil || running.cancelled {
		return false
	}
	running.pids[job] = pid
	return true
}

func (c *Ci) checkCancelled(dir string) bool {
	c.lock.Lock()
	defer c.lock.Unlock()
	running := c.active[projectKey(dir)]
	return running != nil && running.cancelled
}

// Cancel stops the project's running local CI.
func (c *Ci) Cancel(dir string, runId string) error {
	if err := checkCiRunId(runId); err != nil {
		return err
	}
	dir = filepath.Clean(dir)
	var pids []int
	err := func() error {
		c.lock.Lock()
		defer c.lock.Unlock()
		running := c.active[projectKey(dir)]
		if running == nil || running.runId != runId {
			return errors.New("this local CI run is not running")
		}
		running.cancelled = true
		for _, pid := range running.pids {
			pids = append(pids, pid)
		}
		return nil
	}()
	if err != nil {
		return err
	}
	for _, pid := range pids {
		stopRunGroup(pid)
	}
	return nil
}

func (c *Ci) emit(rec CiRunRecord) {
	if c.publish != nil {
		c.publish(rec)
	}
}

// One record shared by the lanes, written whole after every change.
type ciRunProgress struct {
	lock sync.Mutex
	rec  CiRunRecord
	ci   *Ci
}

func (p *ciRunProgress) update(change func(rec *CiRunRecord)) CiRunRecord {
	p.lock.Lock()
	defer p.lock.Unlock()
	change(&p.rec)
	p.ci.writeRecord(p.rec)
	p.ci.emit(p.rec)
	return p.rec
}

func (p *ciRunProgress) setJob(name string, change func(job *CiJobRecord)) CiRunRecord {
	return p.update(func(rec *CiRunRecord) {
		for i := range rec.Jobs {
			if rec.Jobs[i].Name == name {
				change(&rec.Jobs[i])
			}
		}
	})
}

func (c *Ci) execute(rec CiRunRecord, pipeline *molten.Pipeline, jobs []molten.PipelineJob) {
	defer func() {
		panichandler.PanicHandler("molten:mission:ci", recover())
	}()
	defer c.release(rec.Dir, rec.Id)
	progress := &ciRunProgress{rec: rec, ci: c}
	tree, err := c.prepare(rec, pipeline)
	if err != nil {
		progress.update(func(r *CiRunRecord) {
			r.Status = CiStateFailure
			if c.checkCancelled(rec.Dir) {
				r.Status = CiStateCancelled
			}
			r.Error = err.Error()
			r.FinishedAt = c.now().UnixMilli()
			for i := range r.Jobs {
				r.Jobs[i].Status = CiStateCancelled
			}
		})
		return
	}
	statuses := pipeline.Ci.Statuses == molten.PipelineCiStatusesGithub
	var wg sync.WaitGroup
	for _, lane := range ciLanes(jobs) {
		wg.Add(1)
		go func(lane []molten.PipelineJob) {
			defer func() {
				panichandler.PanicHandler("molten:mission:ci:lane", recover())
			}()
			defer wg.Done()
			stopped := false
			for _, job := range lane {
				if stopped || c.checkCancelled(rec.Dir) {
					progress.setJob(job.Name, func(j *CiJobRecord) { j.Status = CiStateCancelled })
					continue
				}
				status := c.runJob(progress, rec, tree, job, statuses)
				stopped = status != CiStateSuccess
			}
		}(lane)
	}
	wg.Wait()
	progress.update(func(r *CiRunRecord) {
		r.FinishedAt = c.now().UnixMilli()
		r.Status = CiStateSuccess
		for _, job := range r.Jobs {
			if job.Status == CiStateFailure {
				r.Status = CiStateFailure
			}
		}
		if r.Status == CiStateSuccess && c.checkCancelled(rec.Dir) {
			r.Status = CiStateCancelled
		}
	})
}

// prepare moves the CI's worktree to the run's commit (created once; ignored files are kept so builds stay
// incremental), then runs ci.prepare.
func (c *Ci) prepare(rec CiRunRecord, pipeline *molten.Pipeline) (string, error) {
	logFile, err := os.OpenFile(filepath.Join(c.runDir(rec.Dir, rec.Id), ciPrepareLog+".log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return "", err
	}
	defer logFile.Close()
	ctx, cancel := context.WithTimeout(context.Background(), ciCommandTimeout)
	defer cancel()
	tree := c.worktreeDir(rec.Dir)
	step := func(dir string, args ...string) error {
		fmt.Fprintf(logFile, "$ git %s\n", strings.Join(args, " "))
		out, err := c.run(ctx, dir, "git", args...)
		logFile.Write(out)
		if err != nil {
			fmt.Fprintf(logFile, "%v\n", err)
		}
		return err
	}
	if _, err := os.Stat(filepath.Join(tree, ".git")); err != nil {
		os.RemoveAll(tree)
		step(rec.Dir, "worktree", "prune")
		if err := os.MkdirAll(filepath.Dir(tree), 0700); err != nil {
			return "", err
		}
		if err := step(rec.Dir, "worktree", "add", "--detach", "--force", tree, rec.Sha); err != nil {
			return "", fmt.Errorf("the CI worktree could not be created: %w", err)
		}
	} else {
		if err := step(tree, "checkout", "--detach", "--force", rec.Sha); err != nil {
			return "", fmt.Errorf("the CI worktree could not move to %s: %w", shortSha(rec.Sha), err)
		}
		if err := step(tree, "clean", "-fdq"); err != nil {
			return "", fmt.Errorf("the CI worktree could not be cleaned: %w", err)
		}
	}
	if pipeline.Ci.Prepare == nil {
		return tree, nil
	}
	prepare := *pipeline.Ci.Prepare
	prepare.Run = expandCommand(prepare.Run, CommandVars{Branch: c.branchOf(rec)})
	fmt.Fprintf(logFile, "$ %s\n", prepare.Run)
	exit, err := c.runCommand(rec.Dir, ciPrepareLog, filepath.Join(tree, prepare.Cwd), prepare.Run, prepare.Env, logFile)
	if err != nil {
		return "", err
	}
	if exit != 0 {
		return "", fmt.Errorf("ci.prepare failed (exit %d): the end of prepare.log says why", exit)
	}
	return tree, nil
}

func checkCiRunId(runId string) error {
	if runId == "" || strings.ContainsAny(runId, `/\`) || strings.Contains(runId, "..") {
		return fmt.Errorf("invalid run id %q", runId)
	}
	return nil
}

func shortSha(sha string) string {
	if len(sha) > 7 {
		return sha[:7]
	}
	return sha
}

func ciJobEnv(extra map[string]string) []string {
	var env []string
	for _, kv := range commandEnv() {
		if strings.HasPrefix(kv, "NO_COLOR=") || strings.HasPrefix(kv, "CI=") {
			continue
		}
		env = append(env, kv)
	}
	env = append(env, "FORCE_COLOR=1", "CLICOLOR_FORCE=1", "CARGO_TERM_COLOR=always")
	for k, v := range extra {
		env = append(env, k+"="+v)
	}
	return env
}

// runCommand runs one command in its own process group, so cancelling stops everything it started.
func (c *Ci) runCommand(projectDir string, name string, cwd string, run string, env map[string]string, out *os.File) (int, error) {
	cmd := exec.Command("/bin/sh", "-c", run)
	cmd.Dir = cwd
	cmd.Env = ciJobEnv(env)
	cmd.Stdout = out
	cmd.Stderr = out
	cmd.Stdin = nil
	detachRun(cmd)
	if err := cmd.Start(); err != nil {
		return -1, fmt.Errorf("starting %s: %w", name, err)
	}
	if !c.setPid(projectDir, name, cmd.Process.Pid) {
		stopRunGroup(cmd.Process.Pid)
	}
	err := cmd.Wait()
	if err == nil {
		return 0, nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode(), nil
	}
	return -1, err
}

// runJob reads the run's fixed fields from rec, never from the shared progress record the lanes write.
func (c *Ci) runJob(progress *ciRunProgress, rec CiRunRecord, tree string, job molten.PipelineJob, statuses bool) string {
	started := c.now()
	progress.setJob(job.Name, func(j *CiJobRecord) {
		j.Status = CiStateRunning
		j.StartedAt = started.UnixMilli()
	})
	if statuses {
		go c.publishStatus(rec.Dir, rec.Sha, job.Name, "pending", "running "+ciPublishScopeNote+"…")
	}
	status := CiStateFailure
	var exitCode *int
	logFile, err := os.OpenFile(filepath.Join(c.runDir(rec.Dir, rec.Id), job.Name+".log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err == nil {
		command := expandCommand(job.Run, CommandVars{Branch: c.branchOf(rec)})
		fmt.Fprintf(logFile, "$ %s\n", command)
		exit, runErr := c.runCommand(rec.Dir, job.Name, filepath.Join(tree, job.Cwd), command, job.Env, logFile)
		if runErr != nil {
			fmt.Fprintf(logFile, "%v\n", runErr)
		}
		logFile.Close()
		exitCode = &exit
		if runErr == nil && exit == 0 {
			status = CiStateSuccess
		}
	}
	if c.checkCancelled(rec.Dir) && status != CiStateSuccess {
		status = CiStateCancelled
	}
	finished := c.now()
	progress.setJob(job.Name, func(j *CiJobRecord) {
		j.Status = status
		j.FinishedAt = finished.UnixMilli()
		j.Exit = exitCode
	})
	if status != CiStateCancelled {
		c.writeVerdict(rec.Dir, rec.Sha, rec.Tree, job.Name, CiVerdict{Status: status, RunId: rec.Id, FinishedAt: finished.UnixMilli()})
	}
	if statuses && status != CiStateCancelled {
		took := finished.Sub(started).Round(time.Second)
		state, description := "success", fmt.Sprintf("%s %s", took, ciPublishScopeNote)
		if status == CiStateFailure {
			state, description = "failure", fmt.Sprintf("failed after %s %s", took, ciPublishScopeNote)
		}
		go c.publishStatus(rec.Dir, rec.Sha, job.Name, state, description)
	}
	return status
}

// publishStatus sets the commit status local-<job> through the user's gh; a commit not on GitHub yet is skipped.
func (c *Ci) publishStatus(dir string, sha string, job string, state string, description string) {
	defer func() {
		panichandler.PanicHandler("molten:mission:ci:status", recover())
	}()
	ctx, cancel := context.WithTimeout(context.Background(), ciStatusesTimeout)
	defer cancel()
	_, err := c.run(ctx, dir, "gh", "api", "-X", "POST", "repos/{owner}/{repo}/statuses/"+sha,
		"-f", "state="+state, "-f", "context=local-"+job, "-f", "description="+description)
	if err != nil {
		log.Printf("molten: local CI status local-%s for %s not published: %v\n", job, shortSha(sha), err)
	}
}

// ReadLog returns a job's log (or the preparation's, job "prepare") from a byte offset.
func (c *Ci) ReadLog(dir string, runId string, job string, from int64) (LogChunk, error) {
	if err := checkCiRunId(runId); err != nil {
		return LogChunk{}, err
	}
	if job == "" || strings.ContainsAny(job, `/\`) || strings.Contains(job, "..") {
		return LogChunk{}, fmt.Errorf("invalid job %q", job)
	}
	file, err := os.Open(filepath.Join(c.runDir(filepath.Clean(dir), runId), job+".log"))
	if err != nil {
		if os.IsNotExist(err) {
			return LogChunk{Text: "", Size: 0}, nil
		}
		return LogChunk{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return LogChunk{}, err
	}
	size := info.Size()
	if from < 0 || from > size {
		from = 0
	}
	if size-from > maxLogRead {
		size = from + maxLogRead
	}
	buf := make([]byte, size-from)
	n, _ := file.ReadAt(buf, from)
	return LogChunk{Text: string(buf[:n]), Size: from + int64(n)}, nil
}

var commitIdRegex = regexp.MustCompile(`^[0-9a-f]{7,64}$`)

// branchOf is the branch a CI run tests, for {branch}: the one asked for, or else the project's checked-out branch
// (a build verifies a bare commit).
func (c *Ci) branchOf(rec CiRunRecord) string {
	if rec.Branch != "" && rec.Branch != "HEAD" && !commitIdRegex.MatchString(rec.Branch) {
		return rec.Branch
	}
	return currentBranch(c.run, rec.Dir)
}
