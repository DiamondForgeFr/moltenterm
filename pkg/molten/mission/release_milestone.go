// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/release"
)

// The Release menu shows the milestone a release ships and its open issues, as a warning (FR-REL-002): read when the
// developer picks the release, through the same rule as `molten release plan`.

const releaseMilestoneTimeout = 12 * time.Second

type ReleaseMilestoneRequest struct {
	Dir string `json:"dir"`
	// The public version the release leads to (X.Y.Z).
	Version string `json:"version"`
}

// ReleaseMilestoneOf reads the open milestone of a version and its open issues; nil when the project has none.
func ReleaseMilestoneOf(run Runner, req ReleaseMilestoneRequest) (*release.Milestone, error) {
	if err := checkDir(req.Dir); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), releaseMilestoneTimeout)
	defer cancel()
	env := &release.Env{Dir: req.Dir, Run: release.Runner(run)}
	if !env.OnGithub(ctx, req.Dir) {
		return nil, nil
	}
	return env.MilestoneOf(ctx, req.Dir, req.Version)
}
