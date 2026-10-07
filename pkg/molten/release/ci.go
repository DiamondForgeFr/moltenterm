// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package release

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

const (
	CiGreen   = "green"
	CiRunning = "running"
	CiRed     = "red"
	CiMissing = "missing"
)

type CiRun struct {
	Status     string `json:"status"`
	Conclusion string `json:"conclusion"`
	Url        string `json:"url"`
}

var redConclusions = map[string]bool{"failure": true, "timed_out": true, "startup_failure": true, "action_required": true}

// CiVerdict reads the runs of one workflow on one commit as Notulia's promotion does: a success among them is green (a
// failed run re-run green counts), else a run still going is running, else a failure is red; no run, or only
// cancelled or skipped ones, is missing.
func CiVerdict(runs []CiRun) string {
	for _, r := range runs {
		if r.Status == "completed" && r.Conclusion == "success" {
			return CiGreen
		}
	}
	for _, r := range runs {
		if r.Status != "completed" {
			return CiRunning
		}
	}
	for _, r := range runs {
		if redConclusions[r.Conclusion] {
			return CiRed
		}
	}
	return CiMissing
}

func firstRed(runs []CiRun) string {
	for _, r := range runs {
		if redConclusions[r.Conclusion] {
			return r.Url
		}
	}
	return ""
}

func (e *Env) ciRuns(ctx context.Context, root string, workflow string, sha string) ([]CiRun, error) {
	out, err := e.gh(ctx, root, "run", "list", "--workflow", workflow, "--commit", sha, "--limit", "50", "--json", "status,conclusion,url")
	if err != nil {
		return nil, err
	}
	var runs []CiRun
	if err := json.Unmarshal(out, &runs); err != nil {
		return nil, fmt.Errorf("gh run list: unreadable answer")
	}
	return runs, nil
}

// requireCi waits until every named workflow is green on the commit. A missing run is started on the branch, once,
// provided the branch still points at the commit (a dispatch runs the branch's tip, which must be what is promoted).
// There is no flag to skip it: nothing reaches the release branch unverified.
func (e *Env) requireCi(ctx context.Context, root string, branch string, sha string, workflows []string, dryRun bool) error {
	if len(workflows) == 0 {
		return fmt.Errorf("name the workflows that must be green on %s before it is promoted: --workflow <file>", branch)
	}
	poll, limit := e.CiPoll, e.CiLimit
	if poll <= 0 {
		poll = ciPollInterval
	}
	if limit <= 0 {
		limit = ciWaitLimit
	}
	short := sha[:min(7, len(sha))]
	e.printf("GitHub CI on %s %s:\n", branch, short)
	started := map[string]bool{}
	begin := e.now()
	for {
		pending := []string{}
		missing := []string{}
		for _, wf := range workflows {
			runs, err := e.ciRuns(ctx, root, wf, sha)
			if err != nil {
				return fmt.Errorf("could not read the runs of %s: %w", wf, err)
			}
			switch CiVerdict(runs) {
			case CiRed:
				url := firstRed(runs)
				return fmt.Errorf("%s failed on %s %s %s: fix %s first, or re-run it (gh run rerun --failed) when the code was not the cause", wf, branch, short, url, branch)
			case CiGreen:
				continue
			case CiMissing:
				missing = append(missing, wf)
			}
			pending = append(pending, wf)
		}
		if len(pending) == 0 {
			for _, wf := range workflows {
				e.printf("  %s: green\n", wf)
			}
			return nil
		}
		if dryRun && len(missing) > 0 {
			e.printf("  no run of %s on this commit: a real promotion would start it and wait.\n", strings.Join(missing, ", "))
			return nil
		}
		for _, wf := range missing {
			if started[wf] {
				continue
			}
			tip, err := e.remoteBranchTip(ctx, root, branch)
			if err != nil {
				return err
			}
			if tip != sha {
				return fmt.Errorf("%s moved to %s during the promotion: nothing was pushed, run it again", branch, tip[:min(7, len(tip))])
			}
			if _, err := e.gh(ctx, root, "workflow", "run", wf, "--ref", branch); err != nil {
				return fmt.Errorf("could not start %s on %s: %w", wf, branch, err)
			}
			started[wf] = true
			e.printf("  %s: no run on this commit, started it.\n", wf)
		}
		if e.now().Sub(begin) > limit {
			return fmt.Errorf("GitHub CI is still not done on %s after %s: nothing was pushed, run it again later", short, limit)
		}
		e.printf("  waiting for %s…\n", strings.Join(pending, ", "))
		e.sleep(poll)
	}
}

func (e *Env) remoteBranchTip(ctx context.Context, root string, branch string) (string, error) {
	out, err := e.git(ctx, root, "ls-remote", "origin", "refs/heads/"+branch)
	if err != nil {
		return "", err
	}
	fields := strings.Fields(out)
	if len(fields) == 0 {
		return "", fmt.Errorf("origin has no branch %s", branch)
	}
	return fields[0], nil
}
