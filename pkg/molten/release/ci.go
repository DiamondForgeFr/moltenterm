// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package release

import (
	"context"
	"fmt"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/remoteci"
)

var redConclusions = map[string]bool{"failure": true, "timed_out": true, "startup_failure": true, "action_required": true}

// ciRepo is origin's GitHub repository, as the checks of a run's repository compare it with (#2277).
func (e *Env) ciRepo(ctx context.Context, root string) string {
	if e.Repo != "" {
		return e.Repo
	}
	url, _ := e.git(ctx, root, "remote", "get-url", "origin")
	return GithubRepo(url)
}

// ciAnswer asks GitHub whether the named workflow is green on the commit, with the guardrails of a build's verify
// (FR-MC-012, #2277): the commit's own run in the project's repository, of a push, a dispatch or a schedule on the
// branch, and each check the branch requires a successful job of it. A pull request's run on the same commit is not the
// branch's CI.
func (e *Env) ciAnswer(ctx context.Context, root string, branch string, sha string, workflow string) remoteci.Answer {
	gh := func(ctx context.Context, args ...string) ([]byte, error) {
		return e.gh(ctx, root, args...)
	}
	return remoteci.Check(ctx, gh, remoteci.Query{Repo: e.ciRepo(ctx, root), Sha: sha, Branches: []string{branch}, Workflow: workflow})
}

// A reason that says the workflow has no usable run on the commit yet: a new run is what is missing.
func missingRun(code string) bool {
	return code == remoteci.ReasonNoRun || code == remoteci.ReasonPartialOnly || code == remoteci.ReasonCancelled
}

// A reason that says GitHub could not be asked, as opposed to what it answered.
func couldNotAsk(code string) bool {
	switch code {
	case remoteci.ReasonNoRepo, remoteci.ReasonNoGh, remoteci.ReasonLoggedOut, remoteci.ReasonRateLimited, remoteci.ReasonUnreachable, remoteci.ReasonBadSha:
		return true
	}
	return false
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
			answer := e.ciAnswer(ctx, root, branch, sha, wf)
			why, _ := answer.Reason.Describe()
			switch {
			case answer.Status == remoteci.StatusVerified:
				continue
			case answer.Status == remoteci.StatusPending:
			case couldNotAsk(answer.Reason.Code):
				return fmt.Errorf("could not read the runs of %s: %s", wf, why)
			case answer.Reason.Code == remoteci.ReasonFailed:
				return fmt.Errorf("%s failed on %s %s %s: fix %s first, or re-run it (gh run rerun --failed) when the code was not the cause", wf, branch, short, answer.Url, branch)
			case missingRun(answer.Reason.Code):
				missing = append(missing, wf)
			default:
				return fmt.Errorf("%s is not green on %s %s: %s (%s)", wf, branch, short, why, answer.Url)
			}
			pending = append(pending, wf)
		}
		if len(pending) == 0 {
			for _, wf := range workflows {
				e.printf("  %s: green\n", wf)
			}
			return nil
		}
		if dryRun {
			e.printf("  not green yet: %s; a real promotion would start what is missing and wait.\n", strings.Join(pending, ", "))
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
