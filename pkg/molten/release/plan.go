// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package release

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/versions"
)

const maxPlanCommits = 500

// HowMilestone: the version is the one of a finished milestone the project declared (#416).
const HowMilestone = "milestone"

type PlanReport struct {
	versions.PlanResult
	Milestone      *Milestone `json:"milestone,omitempty"`
	MilestoneError string     `json:"milestoneerror,omitempty"`
	// When a finished milestone sets the version: what the commits alone would have proposed, and whether it differs.
	CommitsSuggest string `json:"commitssuggest,omitempty"`
	Mismatch       string `json:"mismatch,omitempty"`
}

// finishedMilestone is the release the project already declared and completed (#416): an open milestone naming a
// public version above the last public release, with no open issue, not tagged yet. With several, the lowest comes
// first: it is the next one.
func finishedMilestone(list []githubMilestone, rules versions.Rules, tags []string) *githubMilestone {
	var last versions.Version
	lastOk := false
	if lastPublic := rules.LastPublic(tags); lastPublic != "" {
		last, lastOk = rules.ReleaseOf(lastPublic)
	}
	var best *githubMilestone
	var bestVersion versions.Version
	for i := range list {
		m := &list[i]
		if m.OpenIssues != 0 {
			continue
		}
		v, err := versions.ParseBase(MilestoneKey(m.Title))
		if err != nil {
			continue
		}
		if lastOk && versions.Compare(v, last) <= 0 {
			continue
		}
		if _, ok := rules.ReleaseOf(rules.Tag(v.WithRc(1))); !ok {
			continue
		}
		if slices.Contains(tags, rules.Tag(v)) {
			continue
		}
		if best == nil || versions.Compare(v, bestVersion) < 0 {
			best, bestVersion = m, v
		}
	}
	return best
}

func (e *Env) openMilestones(ctx context.Context, dir string) ([]githubMilestone, error) {
	out, err := e.gh(ctx, dir, "api", "repos/{owner}/{repo}/milestones?state=open&per_page=100")
	if err != nil {
		return nil, err
	}
	var list []githubMilestone
	if err := json.Unmarshal(out, &list); err != nil {
		return nil, fmt.Errorf("gh api milestones: unreadable answer")
	}
	return list, nil
}

// Plan says what the next release of each asked channel would be, as the Release menu computes it (FR-REL-001), and
// the milestone it ships with its open issues. A finished, untagged milestone comes first (#416): its version is
// proposed, and the version the commits suggest is shown beside it, with any mismatch, never in its place.
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
	var finished *githubMilestone
	if github && override == "" {
		if list, err := e.openMilestones(ctx, p.Root); err == nil {
			finished = finishedMilestone(list, p.Rules, tags)
		}
	}
	reports := []PlanReport{}
	for _, channel := range channels {
		r := PlanReport{PlanResult: p.Rules.Plan(tags, commits, channel, override)}
		if finished != nil {
			r = planFromMilestone(p, tags, commits, channel, r, finished)
		}
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

// planFromMilestone proposes the finished milestone's version instead of the commit-derived one, and reports what the
// commits suggest: a feat since the last release suggests a minor version, a milestone may declare a patch.
func planFromMilestone(p *Project, tags []string, commits []versions.CommitInput, channel string, derived PlanReport, m *githubMilestone) PlanReport {
	version := MilestoneKey(m.Title)
	if derived.Base == version {
		return derived
	}
	r := PlanReport{PlanResult: p.Rules.Plan(tags, commits, channel, version)}
	if r.How == versions.HowRefused {
		return derived
	}
	r.How = HowMilestone
	r.CommitsSuggest = derived.Base
	switch {
	case derived.Base == "":
		r.Reason = fmt.Sprintf("Milestone %s is finished and not tagged yet (the commits alone justify no release).", m.Title)
	default:
		r.Reason = fmt.Sprintf("Milestone %s is finished and not tagged yet.", m.Title)
		r.Mismatch = fmt.Sprintf("the commits since %s suggest %s%s; milestone %s declares %s", lastOr(derived.LastPublic, "the start"), derived.Base, levelNote(derived.Level), m.Title, version)
	}
	return r
}

// " (a minor version)" for a derived bump, nothing for a choice.
func levelNote(level string) string {
	if level == "" {
		return ""
	}
	return fmt.Sprintf(" (a %s version)", level)
}

func lastOr(tag string, fallback string) string {
	if tag == "" {
		return fallback
	}
	return tag
}
