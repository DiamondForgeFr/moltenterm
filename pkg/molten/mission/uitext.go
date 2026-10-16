// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// The pipeline refusals several Mission Control actions share, coded for the windows (#656).

func errNoPipeline() error {
	return uimsg.Errorf(uimsg.Make("mission.noPipeline"), "the project has no pipeline (.molten/project.json)")
}

func errPipelineProblems(report molten.PipelineReport) error {
	detail := strings.Join(report.Errors, "; ")
	return uimsg.Errorf(uimsg.Make("mission.pipelineProblems", "detail", detail), "the pipeline has problems: %s", detail)
}

func errAlreadyRunning(title string) error {
	return uimsg.Errorf(uimsg.Make("mission.run.alreadyRunning", "title", title), "%s is already running", title)
}

func errStillRunning(title string) error {
	return uimsg.Errorf(uimsg.Make("mission.run.stillRunning", "title", title), "%s is still running", title)
}

func errNotFollowed(tag string) error {
	return uimsg.Errorf(uimsg.Make("mission.release.notFollowed", "tag", tag), "%s is not the release followed", tag)
}

// pipelineError is the refusal of an invalid pipeline report.
func pipelineError(report molten.PipelineReport) error {
	if !report.Present {
		return errNoPipeline()
	}
	return errPipelineProblems(report)
}
