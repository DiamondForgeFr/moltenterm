// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// A release reads the pipeline of the checkout it starts from, while its branch is made from origin (#1095, #1091
// finding 1): a pipeline just written by the release setup and not committed, or a checkout behind origin's trunk,
// makes the release run one pipeline while its branch carries another. Starting says so and asks to confirm.

// The checkout's pipeline is not the one the release branch is made from.
type PipelineDrift struct {
	// .molten/project.json has changes git has not committed.
	Uncommitted bool `json:"uncommitted,omitempty"`
	// The ref whose pipeline differs from the checkout's (origin/<trunk>), when it does.
	Base string `json:"base,omitempty"`
}

// pipelineDrift is nil when the checkout's pipeline is committed and the same as origin's trunk's.
func (r *Runs) pipelineDrift(project string) *PipelineDrift {
	ctx, cancel := context.WithTimeout(context.Background(), releaseGitTimeout)
	defer cancel()
	drift := &PipelineDrift{}
	if out, err := r.git(ctx, project, "git", "status", "--porcelain", "--untracked-files=all", "--", molten.ProjectPipelineFile); err == nil && strings.TrimSpace(string(out)) != "" {
		drift.Uncommitted = true
	}
	trunk := ConfiguredBranches(project).Trunk
	if trunk != "" {
		// The release branch is made from origin as it is now, not as this checkout last fetched it.
		r.git(ctx, project, "git", "fetch", "--quiet", "origin", trunk)
	}
	_, base := resolveTrunk(ctx, r.git, project)
	if base != "" {
		if _, err := r.git(ctx, project, "git", "diff", "--quiet", base, "--", molten.ProjectPipelineFile); err != nil {
			drift.Base = base
		}
	}
	if !drift.Uncommitted && drift.Base == "" {
		return nil
	}
	return drift
}
