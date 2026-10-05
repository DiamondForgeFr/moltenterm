// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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

// Runs of a project's declared commands (DS-MC-005): MoltenTerm starts them in the project folder, in a session of
// their own (a build goes on if MoltenTerm restarts), keeps each run's log and state under
// <data>/molten/runs/<project>/<run>/, and follows the log for the phases a step announces (`▶ phase: <name>`, as in
// Notulia) and for its exit code.

const (
	RunKindBuild = "build"
	// A project-specific adapter step (FR-MC-007), shown in its panel section.
	RunKindStep = "step"

	RunStateRunning   = "running"
	RunStateSuccess   = "success"
	RunStateFailure   = "failure"
	RunStateCancelled = "cancelled"
	// The run's process is gone without an exit code (the machine slept or restarted, the log was cut).
	RunStateLost = "lost"

	RunFileName = "run.json"
	LogFileName = "output.log"

	maxRunsPerProject = 20
	maxLogRead        = 256 << 10
	runPollInterval   = 700 * time.Millisecond
)

var phaseRegex = regexp.MustCompile(`(?m)^\s*▶ phase:\s*(.+?)\s*$`)
var exitRegex = regexp.MustCompile(`(?m)^exit=(-?\d+)\s*$`)

type RunRecord struct {
	Id         string   `json:"id"`
	Dir        string   `json:"dir"`
	Kind       string   `json:"kind"`
	StepId     string   `json:"stepid"`
	Title      string   `json:"title,omitempty"`
	Command    string   `json:"command"`
	Cwd        string   `json:"cwd,omitempty"`
	Artifact   string   `json:"artifact,omitempty"`
	Pid        int      `json:"pid,omitempty"`
	StartedAt  int64    `json:"startedat"`
	FinishedAt int64    `json:"finishedat,omitempty"`
	State      string   `json:"state"`
	Exit       *int     `json:"exit,omitempty"`
	Phases     []string `json:"phases"`
	Cancelled  bool     `json:"cancelled,omitempty"`
	// A build's commit, built in a worktree of its own, and its kind (gold, rc).
	Commit    string `json:"commit,omitempty"`
	BuildKind string `json:"buildkind,omitempty"`
	// The release a release step belongs to.
	Tag string `json:"tag,omitempty"`
	// Still fetching, verifying or preparing in wavesrv: there is no process to follow yet.
	Preparing bool `json:"preparing,omitempty"`
	// Its end was told in the notification center (FR-MC-014).
	Told bool `json:"told,omitempty"`
	// Closed by the user once it no longer runs: its card leaves the Project tab until the next run.
	Closed  bool  `json:"closed,omitempty"`
	LogSize int64 `json:"logsize"`
}

type RunRequest struct {
	Dir     string `json:"dir"`
	Kind    string `json:"kind"`
	Id      string `json:"id"`
	Version string `json:"version,omitempty"`
}

type RunResult struct {
	Run       *RunRecord     `json:"run,omitempty"`
	Untrusted *UntrustedInfo `json:"untrusted,omitempty"`
}

type LogChunk struct {
	Text string `json:"text"`
	Size int64  `json:"size"`
}

type Runs struct {
	lock      sync.Mutex
	baseDir   string
	trust     *TrustStore
	publish   func(RunRecord)
	now       func() time.Time
	watching  map[string]bool
	preparing map[string]bool
	// Cancels asked while a build is being prepared; the preparation alone writes its record meanwhile.
	cancelAsked map[string]bool
	git         Runner
	ci          *Ci
	notify      func(RunRecord, molten.NotificationInput)
	told        map[string]bool
}

func MakeRuns(baseDir string, trust *TrustStore, publish func(RunRecord)) *Runs {
	return &Runs{baseDir: baseDir, trust: trust, publish: publish, now: time.Now, watching: map[string]bool{},
		preparing: map[string]bool{}, cancelAsked: map[string]bool{}, git: ExecRunner, told: map[string]bool{}}
}

// UseCi lets builds verify their commit with the local CI first.
func (r *Runs) UseCi(ci *Ci) {
	r.ci = ci
}

func RunsDir(dataDir string) string {
	return filepath.Join(dataDir, "molten", "runs")
}

func (r *Runs) projectDir(dir string) string {
	return filepath.Join(r.baseDir, projectKey(dir))
}

func projectKey(dir string) string {
	return cacheKey(dir)
}

func newRunId(now time.Time) string {
	suffix := make([]byte, 3)
	rand.Read(suffix)
	return now.Format("20060102-150405") + "-" + hex.EncodeToString(suffix)
}

func expandHome(path string) string {
	if path == "~" || strings.HasPrefix(path, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, strings.TrimPrefix(path, "~"))
		}
	}
	return path
}

// An artifact is declared with ~ or relative to the project folder.
func artifactPath(dir string, artifact string) string {
	if artifact == "" {
		return ""
	}
	path := expandHome(artifact)
	if !filepath.IsAbs(path) {
		path = filepath.Join(dir, path)
	}
	return filepath.Clean(path)
}

// CommandVars are the variables a declared command may use (pipeline-format.md): {version}, {tag} and {branch}. An
// empty value leaves its variable as written.
type CommandVars struct {
	Version string
	Tag     string
	Branch  string
}

func expandCommand(run string, vars CommandVars) string {
	var pairs []string
	for _, kv := range [][2]string{{"{version}", vars.Version}, {"{tag}", vars.Tag}, {"{branch}", vars.Branch}} {
		if kv[1] != "" {
			pairs = append(pairs, kv[0], kv[1])
		}
	}
	if len(pairs) == 0 {
		return run
	}
	return strings.NewReplacer(pairs...).Replace(run)
}

// versionVars names a version's tag with the project's tag prefix.
func versionVars(dir string, version string) CommandVars {
	if version == "" {
		return CommandVars{}
	}
	prefix, _ := ConfiguredVersions(dir)
	return CommandVars{Version: version, Tag: prefix + version}
}

// currentBranch is the branch checked out in the project folder; empty when detached.
func currentBranch(run Runner, dir string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := run(ctx, dir, "git", "symbolic-ref", "--short", "-q", "HEAD")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func (r *Runs) writeRecord(rec RunRecord) error {
	dir := filepath.Join(r.projectDir(rec.Dir), rec.Id)
	data, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(dir, RunFileName+".tmp")
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(dir, RunFileName))
}

func (r *Runs) readRecord(dir string, runId string) (RunRecord, error) {
	var rec RunRecord
	data, err := os.ReadFile(filepath.Join(r.projectDir(dir), runId, RunFileName))
	if err != nil {
		return rec, err
	}
	err = json.Unmarshal(data, &rec)
	return rec, err
}

func (r *Runs) logFile(dir string, runId string) string {
	return filepath.Join(r.projectDir(dir), runId, LogFileName)
}

// findCommand resolves what a request asks to run from the project's valid pipeline.
func findCommand(p *molten.Pipeline, kind string, id string) (TrustedCommand, string, error) {
	switch kind {
	case RunKindBuild:
		for _, build := range p.Builds {
			if build.Id == id {
				return TrustedCommand{Kind: kind, Id: id, Title: build.Title, Run: build.Run, Cwd: build.Cwd, Env: build.Env}, build.Artifact, nil
			}
		}
		return TrustedCommand{}, "", fmt.Errorf("the pipeline declares no build %q", id)
	case RunKindStep:
		for _, step := range p.Steps {
			if step.Id == id {
				return TrustedCommand{Kind: kind, Id: id, Title: step.Title, Run: step.Run, Cwd: step.Cwd, Env: step.Env}, "", nil
			}
		}
		return TrustedCommand{}, "", fmt.Errorf("the pipeline declares no step %q", id)
	}
	return TrustedCommand{}, "", fmt.Errorf("running %q steps from MoltenTerm is not available yet", kind)
}

// Start runs a declared command, after the trust rule; untrusted commands are returned for the user to review.
func (r *Runs) Start(req RunRequest) (RunResult, error) {
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
	commands := PipelineCommands(report.Pipeline)
	hash := CommandsHash(commands)
	if !r.trust.IsTrusted(dir, hash) {
		return RunResult{Untrusted: &UntrustedInfo{Hash: hash, Commands: commands}}, nil
	}
	command, artifact, err := findCommand(report.Pipeline, req.Kind, req.Id)
	if err != nil {
		return RunResult{}, err
	}
	if running := r.runningOf(dir, req.Kind); running != nil {
		return RunResult{}, fmt.Errorf("%s is already running", running.Title)
	}
	if req.Kind == RunKindBuild {
		rec, err := r.startBuild(dir, findBuild(report.Pipeline, req.Id), req.Version)
		if err != nil {
			return RunResult{}, err
		}
		return RunResult{Run: &rec}, nil
	}
	rec, err := r.launch(dir, command, artifact, req.Version, "")
	if err != nil {
		return RunResult{}, err
	}
	return RunResult{Run: &rec}, nil
}

func (r *Runs) runningOf(dir string, kind string) *RunRecord {
	for _, rec := range r.List(dir) {
		if rec.Kind == kind && rec.State == RunStateRunning {
			return &rec
		}
	}
	return nil
}

func (r *Runs) launch(dir string, command TrustedCommand, artifact string, version string, tag string) (RunRecord, error) {
	now := r.now()
	rec := RunRecord{
		Id:        newRunId(now),
		Dir:       dir,
		Kind:      command.Kind,
		StepId:    command.Id,
		Title:     command.Title,
		Command:   expandCommand(command.Run, withBranch(versionVars(dir, version), currentBranch(r.git, dir))),
		Cwd:       command.Cwd,
		Artifact:  artifactPath(dir, artifact),
		StartedAt: now.UnixMilli(),
		State:     RunStateRunning,
		Phases:    []string{},
		Tag:       tag,
	}
	if rec.Title == "" {
		rec.Title = command.Id
	}
	runDir := filepath.Join(r.projectDir(dir), rec.Id)
	if err := os.MkdirAll(runDir, 0700); err != nil {
		return rec, err
	}
	logFile, err := os.OpenFile(filepath.Join(runDir, LogFileName), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return rec, err
	}
	defer logFile.Close()
	// The exit line is how the run's end is known, even after a MoltenTerm restart.
	cmd := exec.Command("/bin/sh", "-c", `( `+rec.Command+` ); echo "exit=$?"`)
	cmd.Dir = filepath.Join(dir, rec.Cwd)
	cmd.Env = commandEnv()
	for k, v := range command.Env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	cmd.Env = append(cmd.Env, "MOLTEN_RUN_ID="+rec.Id)
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.Stdin = nil
	detachRun(cmd)
	if err := cmd.Start(); err != nil {
		return rec, fmt.Errorf("starting %s: %w", rec.Title, err)
	}
	rec.Pid = cmd.Process.Pid
	if err := r.writeRecord(rec); err != nil {
		return rec, err
	}
	go cmd.Wait()
	r.prune(dir)
	r.watch(rec)
	if r.publish != nil {
		r.publish(rec)
	}
	return rec, nil
}

// update reads what the run's log says since last time; it reports whether the record changed.
func (r *Runs) update(rec *RunRecord) bool {
	data, err := os.ReadFile(r.logFile(rec.Dir, rec.Id))
	if err != nil {
		return false
	}
	changed := int64(len(data)) != rec.LogSize
	rec.LogSize = int64(len(data))
	phases := []string{}
	for _, m := range phaseRegex.FindAllSubmatch(data, -1) {
		phases = append(phases, string(m[1]))
	}
	if len(phases) != len(rec.Phases) {
		rec.Phases = phases
		changed = true
	}
	if m := exitRegex.FindAllSubmatch(data, -1); len(m) > 0 {
		code, _ := strconv.Atoi(string(m[len(m)-1][1]))
		rec.Exit = &code
		rec.FinishedAt = r.now().UnixMilli()
		switch {
		case rec.Cancelled:
			rec.State = RunStateCancelled
		case code == 0:
			rec.State = RunStateSuccess
		default:
			rec.State = RunStateFailure
		}
		return true
	}
	if rec.Preparing {
		return changed
	}
	if !processAlive(rec.Pid) {
		rec.FinishedAt = r.now().UnixMilli()
		rec.State = RunStateLost
		if rec.Cancelled {
			rec.State = RunStateCancelled
		}
		return true
	}
	return changed
}

func (r *Runs) startWatching(runId string) bool {
	r.lock.Lock()
	defer r.lock.Unlock()
	if r.watching[runId] {
		return false
	}
	r.watching[runId] = true
	return true
}

func (r *Runs) stopWatching(runId string) {
	r.lock.Lock()
	defer r.lock.Unlock()
	delete(r.watching, runId)
}

func (r *Runs) watch(rec RunRecord) {
	if !r.startWatching(rec.Id) {
		return
	}
	go func() {
		defer func() {
			panichandler.PanicHandler("molten:mission:run", recover())
		}()
		defer r.stopWatching(rec.Id)
		for rec.State == RunStateRunning {
			time.Sleep(runPollInterval)
			// The record on disk is the reference: a build's preparation fills in its commit and process first.
			if current, err := r.readRecord(rec.Dir, rec.Id); err == nil {
				rec = current
			}
			if rec.Preparing {
				continue
			}
			if !r.update(&rec) {
				continue
			}
			r.settle(&rec)
			r.writeRecord(rec)
			if r.publish != nil {
				r.publish(rec)
			}
		}
	}()
}

// List returns the project's runs, newest first; runs still going after a MoltenTerm restart are followed again.
func (r *Runs) List(dir string) []RunRecord {
	dir = filepath.Clean(dir)
	entries, err := os.ReadDir(r.projectDir(dir))
	if err != nil {
		return []RunRecord{}
	}
	runs := []RunRecord{}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		rec, err := r.readRecord(dir, entry.Name())
		if err != nil {
			continue
		}
		if rec.State == RunStateRunning && rec.Preparing && r.checkPreparing(rec.Id) {
			// Its preparation alone writes the record until the build command starts.
			runs = append(runs, rec)
			continue
		}
		if rec.State == RunStateRunning && rec.Preparing {
			// wavesrv stopped while it fetched, verified or prepared the build.
			rec.Preparing = false
			rec.State = RunStateLost
			rec.FinishedAt = r.now().UnixMilli()
			r.settle(&rec)
			r.writeRecord(rec)
		}
		if rec.State == RunStateRunning {
			if r.update(&rec) {
				r.settle(&rec)
				r.writeRecord(rec)
			}
			if rec.State == RunStateRunning {
				r.watch(rec)
			}
		}
		runs = append(runs, rec)
	}
	sort.Slice(runs, func(i, j int) bool { return runs[i].StartedAt > runs[j].StartedAt })
	return runs
}

// prune keeps the last runs of a project; a run still going is never removed.
func (r *Runs) prune(dir string) {
	runs := r.List(dir)
	// The release on its way reads its steps from their runs: builds made meanwhile must not erase them (#230).
	session, _ := r.ReleaseSessionOf(dir)
	for i, rec := range runs {
		if i < maxRunsPerProject || rec.State == RunStateRunning {
			continue
		}
		if session != nil && rec.Kind == RunKindRelease && rec.Tag == session.Tag {
			continue
		}
		os.RemoveAll(filepath.Join(r.projectDir(dir), rec.Id))
	}
}

func (r *Runs) Cancel(dir string, runId string) error {
	dir = filepath.Clean(dir)
	rec, err := r.readRecord(dir, runId)
	if err != nil {
		return err
	}
	if rec.State != RunStateRunning {
		return fmt.Errorf("%s is not running", rec.Title)
	}
	if r.askCancelWhilePreparing(rec.Id) {
		return nil
	}
	rec.Cancelled = true
	if err := r.writeRecord(rec); err != nil {
		return err
	}
	if rec.Pid <= 0 {
		return nil
	}
	return stopRunGroup(rec.Pid)
}

func checkRunId(runId string) error {
	if runId == "" || strings.ContainsAny(runId, `/\`) || strings.Contains(runId, "..") {
		return fmt.Errorf("invalid run id %q", runId)
	}
	return nil
}

// Close hides a finished run's card; a run still going must be cancelled first.
func (r *Runs) Close(dir string, runId string) error {
	if err := checkRunId(runId); err != nil {
		return err
	}
	dir = filepath.Clean(dir)
	rec, err := r.readRecord(dir, runId)
	if err != nil {
		return err
	}
	if rec.State == RunStateRunning {
		return fmt.Errorf("%s is still running: cancel it first", rec.Title)
	}
	if rec.Closed {
		return nil
	}
	rec.Closed = true
	if err := r.writeRecord(rec); err != nil {
		return err
	}
	if r.publish != nil {
		r.publish(rec)
	}
	return nil
}

// ReadLog returns the log from a byte offset, at most maxLogRead bytes, and the offset to ask next.
func (r *Runs) ReadLog(dir string, runId string, from int64) (LogChunk, error) {
	if err := checkRunId(runId); err != nil {
		return LogChunk{}, err
	}
	file, err := os.Open(r.logFile(filepath.Clean(dir), runId))
	if err != nil {
		return LogChunk{}, err
	}
	defer file.Close()
	if _, err := file.Seek(from, io.SeekStart); err != nil {
		return LogChunk{}, err
	}
	var buf bytes.Buffer
	n, err := io.CopyN(&buf, bufio.NewReader(file), maxLogRead)
	if err != nil && err != io.EOF {
		return LogChunk{}, err
	}
	return LogChunk{Text: buf.String(), Size: from + n}, nil
}

func (r *Runs) GrantTrust(dir string, hash string) error {
	if err := checkDir(dir); err != nil {
		return err
	}
	return r.trust.Trust(filepath.Clean(dir), hash)
}

func withBranch(vars CommandVars, branch string) CommandVars {
	vars.Branch = branch
	return vars
}
