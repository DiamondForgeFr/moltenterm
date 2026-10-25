// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"os"
	"path/filepath"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// A manual release step (FR-MC-037) is done by the developer, by hand: confirming it records a run that ended well,
// with its instructions as its log, so the release panel reads it like any step. Nothing is started.

const ManualStepDoneLine = "Done by hand, confirmed in MoltenTerm."

func (r *Runs) recordManualStep(dir, project string, step molten.PipelineStep, session ReleaseSession) (RunRecord, error) {
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
