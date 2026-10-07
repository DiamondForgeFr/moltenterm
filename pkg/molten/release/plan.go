// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package release

import (
	"context"
	"slices"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/versions"
)

const maxPlanCommits = 500

type PlanReport struct {
	versions.PlanResult
	Milestone      *Milestone `json:"milestone,omitempty"`
	MilestoneError string     `json:"milestoneerror,omitempty"`
}

// Plan says what the next release of each asked channel would be, as the Release menu computes it (FR-REL-001), and
// the milestone it ships with its open issues.
func (e *Env) Plan(ctx context.Context, channels []string, override string) ([]PlanReport, error) {
	p, err := e.LoadProject(ctx)
	if err != nil {
		return nil, err
	}
	if err := e.fetch(ctx, p.Root); err != nil {
		e.printf("Warning: %v; the numbers are computed from the local tags.\n", err)
	}
	tags := e.releaseTags(ctx, p.Root, p)
	base := "origin/" + p.Trunk
	if e.revParse(ctx, p.Root, base) == "" {
		base = "HEAD"
	}
	rangeArg := base
	if last := p.Rules.LastPublic(tags); last != "" {
		rangeArg = last + ".." + base
	}
	commits := []versions.CommitInput{}
	args := []string{"log", "--no-merges", "-n", strconv.Itoa(maxPlanCommits), "--format=%s%x1f%b%x1e", rangeArg}
	if remotes, _ := e.gitLines(ctx, p.Root, "remote"); slices.Contains(remotes, "upstream") {
		args = append(args, "--not", "--remotes=upstream")
	}
	out, err := e.git(ctx, p.Root, args...)
	if err != nil {
		return nil, err
	}
	for _, record := range strings.Split(out, "\x1e") {
		subject, body, _ := strings.Cut(strings.TrimSpace(record), "\x1f")
		if subject == "" {
			continue
		}
		commits = append(commits, versions.CommitInput{Subject: subject, Body: body})
	}
	github := e.OnGithub(ctx, p.Root)
	reports := []PlanReport{}
	for _, channel := range channels {
		r := PlanReport{PlanResult: p.Rules.Plan(tags, commits, channel, override)}
		if r.Base != "" && github {
			m, err := e.MilestoneOf(ctx, p.Root, r.Base)
			if err != nil {
				r.MilestoneError = err.Error()
			}
			r.Milestone = m
		}
		reports = append(reports, r)
	}
	return reports, nil
}
