// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/release"
)

// A manual release step (FR-MC-037) is done by the developer, by hand: confirming it records a run that ended well,
// with its instructions as its log, so the release panel reads it like any step. Nothing is started.

const ManualStepDoneLine = "Done by hand, confirmed in MoltenTerm."

// ManualStepForcedLine is logged when the step was confirmed although its check failed (#1095).
const ManualStepForcedLine = "Confirmed although its check failed: "

// What a manual step's check did not find (#1095): nothing is recorded until the developer confirms it anyway.
type ManualCheckFailure struct {
	// Relative to Dir, with the release's words in it.
	Path     string `json:"path"`
	Contains string `json:"contains"`
	// The file is not there at all.
	Missing bool `json:"missing,omitempty"`
	// Where it was read: the release worktree, else the project.
	Dir string `json:"dir"`
}

func (f *ManualCheckFailure) String() string {
	if f.Missing {
		return fmt.Sprintf("%s is not in %s", f.Path, f.Dir)
	}
	return fmt.Sprintf("%s does not contain %q", filepath.Join(f.Dir, f.Path), f.Contains)
}

// manualCheckDir is where a manual step's proof is read: the release worktree the chain prepares the cut in, when there is
// one, else the project.
func (r *Runs) manualCheckDir(project string) string {
	ctx, cancel := context.WithTimeout(context.Background(), releaseGitTimeout)
	defer cancel()
	env := release.Env{Dir: project, Run: release.Runner(r.git)}
	wt, err := env.ReleaseWorktree(ctx, project)
	if err == nil {
		if _, err := os.Stat(filepath.Join(wt, ".git")); err == nil {
			return wt
		}
	}
	return project
}

// checkManualStep reads what proves a manual step done; nil when it holds, or when the step declares no check.
func (r *Runs) checkManualStep(project string, step molten.PipelineStep, session ReleaseSession) *ManualCheckFailure {
	if step.Check == nil {
		return nil
	}
	dir := r.manualCheckDir(project)
	failure := &ManualCheckFailure{
		Path:     filepath.ToSlash(filepath.Clean(filepath.FromSlash(expandReleaseText(step.Check.Path, session)))),
		Contains: expandReleaseText(step.Check.Contains, session),
		Dir:      dir,
	}
	path := filepath.Join(dir, filepath.FromSlash(failure.Path))
	if !pathWithin(dir, path) {
		failure.Missing = true
		return failure
	}
	data, err := os.ReadFile(path)
	if err != nil {
		failure.Missing = true
		return failure
	}
	if strings.Contains(string(data), failure.Contains) {
		return nil
	}
	return failure
}

// forced: the check that failed when the developer confirmed the step anyway, nil otherwise.
func (r *Runs) recordManualStep(dir, project string, step molten.PipelineStep, session ReleaseSession, forced *ManualCheckFailure) (RunRecord, error) {
	now := r.now()
	zero := 0
	title := expandReleaseText(step.Title, session)
	if title == "" {
		title = step.Id
	}
	rec := RunRecord{
		project:    project,
		Id:         newRunId(now),
		Dir:        dir,
		Kind:       RunKindRelease,
		StepId:     step.Id,
		Title:      title,
		StartedAt:  now.UnixMilli(),
		FinishedAt: now.UnixMilli(),
		State:      RunStateSuccess,
		Exit:       &zero,
		Phases:     []string{},
		Tag:        session.Tag,
	}
	if err := r.identifyProject(project); err != nil {
		return rec, err
	}
	runDir := filepath.Join(r.projectDir(project), rec.Id)
	if err := os.MkdirAll(runDir, 0700); err != nil {
		return rec, err
	}
	log := expandReleaseText(step.Manual, session) + "\n" + ManualStepDoneLine + "\n"
	if forced != nil {
		log += ManualStepForcedLine + forced.String() + ".\n"
	}
	if err := os.WriteFile(filepath.Join(runDir, LogFileName), []byte(log), 0600); err != nil {
		return rec, err
	}
	rec.LogSize = int64(len(log))
	if err := r.writeRecord(rec); err != nil {
		return rec, err
	}
	r.prune(project)
	if r.publish != nil {
		r.publish(rec)
	}
	return rec, nil
}
