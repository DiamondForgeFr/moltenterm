// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package release

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
)

// `molten release dispatch` (FR-MC-037): a release step that starts a GitHub workflow by workflow_dispatch (a docs
// deploy at the tag, a production deploy) and follows its run to the end, saying while an environment waits for its
// approval. The step fails when the run does.

const (
	// The lines the release panel reads (pkg/molten/mission release_approval.go).
	ApprovalMarker = "▶ approval: "
	ApprovedMarker = "▶ approved: "

	ghRunWaiting = "waiting"
)

type DispatchOptions struct {
	Workflow string
	// A branch or a tag; the trunk when empty.
	Ref string
	// Inputs of the workflow, as key=value.
	Fields []string
}

type dispatchRun struct {
	Id         int64  `json:"databaseId"`
	Status     string `json:"status"`
	Conclusion string `json:"conclusion"`
	Url        string `json:"url"`
	CreatedAt  string `json:"createdAt"`
}

type pendingDeployment struct {
	Environment struct {
		Name string `json:"name"`
	} `json:"environment"`
}

// Dispatch starts the workflow on the ref and follows the run it started.
func (e *Env) Dispatch(ctx context.Context, opts DispatchOptions) error {
	if strings.TrimSpace(opts.Workflow) == "" {
		return fmt.Errorf("name the workflow to start: molten release dispatch <workflow file>")
	}
	for _, field := range opts.Fields {
		if k, _, ok := strings.Cut(field, "="); !ok || k == "" {
			return fmt.Errorf("--field %q is not key=value", field)
		}
	}
	p, err := e.LoadProject(ctx)
	if err != nil {
		return err
	}
	root := p.Root
	if !e.OnGithub(ctx, root) {
		return fmt.Errorf("origin is not on GitHub: %s runs on GitHub Actions", opts.Workflow)
	}
	ref := opts.Ref
	if ref == "" {
		ref = p.Trunk
	}
	since := e.now()
	args := []string{"workflow", "run", opts.Workflow, "--ref", ref}
	for _, field := range opts.Fields {
		args = append(args, "-f", field)
	}
	if _, err := e.gh(ctx, root, args...); err != nil {
		return fmt.Errorf("could not start %s on %s: %w", opts.Workflow, ref, err)
	}
	run, err := e.findDispatched(ctx, root, opts.Workflow, ref, since)
	if err != nil {
		return err
	}
	e.printf("Started %s on %s: %s\n", opts.Workflow, ref, run.Url)
	run, err = e.followDispatched(ctx, root, run)
	if err != nil {
		return err
	}
	if run.Conclusion != "success" {
		return fmt.Errorf("%s ended %s: %s", opts.Workflow, run.Conclusion, run.Url)
	}
	e.printf("%s is green: %s\n", opts.Workflow, run.Url)
	return nil
}

func (e *Env) dispatchedRuns(ctx context.Context, root string, workflow string, ref string) ([]dispatchRun, error) {
	out, err := e.gh(ctx, root, "run", "list", "--workflow", workflow, "--event", "workflow_dispatch", "--branch", ref,
		"--limit", "20", "--json", "databaseId,status,conclusion,url,createdAt")
	if err != nil {
		return nil, fmt.Errorf("could not read the runs of %s: %w", workflow, err)
	}
	var runs []dispatchRun
	if err := json.Unmarshal(out, &runs); err != nil {
		return nil, fmt.Errorf("gh run list: unreadable answer")
	}
	sort.SliceStable(runs, func(i, j int) bool { return runs[i].CreatedAt > runs[j].CreatedAt })
	return runs, nil
}

// findDispatched finds the run the dispatch started: the newest one on the ref created since (a minute of clock
// difference allowed).
func (e *Env) findDispatched(ctx context.Context, root string, workflow string, ref string, since time.Time) (*dispatchRun, error) {
	begin := e.now()
	for {
		runs, err := e.dispatchedRuns(ctx, root, workflow, ref)
		if err != nil {
			return nil, err
		}
		for i := range runs {
			created, err := time.Parse(time.RFC3339, runs[i].CreatedAt)
			if err == nil && !created.Before(since.Add(-time.Minute)) {
				return &runs[i], nil
			}
		}
		if e.now().Sub(begin) > rehearsalFindLimit {
			return nil, fmt.Errorf("%s was started on %s but its run does not show: look in the repository's Actions tab", workflow, ref)
		}
		e.sleep(rehearsalFindPoll)
	}
}

func (e *Env) pendingEnvironments(ctx context.Context, root string, id int64) []string {
	out, err := e.gh(ctx, root, "api", fmt.Sprintf("repos/{owner}/{repo}/actions/runs/%d/pending_deployments", id))
	if err != nil {
		return nil
	}
	var pending []pendingDeployment
	if json.Unmarshal(out, &pending) != nil {
		return nil
	}
	var rtn []string
	for _, p := range pending {
		if p.Environment.Name != "" {
			rtn = append(rtn, p.Environment.Name)
		}
	}
	return rtn
}

// followDispatched waits for the run's end, saying once when an environment starts waiting for its approval and once
// when it goes on.
func (e *Env) followDispatched(ctx context.Context, root string, run *dispatchRun) (*dispatchRun, error) {
	poll, limit := e.CiPoll, e.CiLimit
	if poll <= 0 {
		poll = ciPollInterval
	}
	if limit <= 0 {
		limit = ciWaitLimit
	}
	begin := e.now()
	waiting := map[string]bool{}
	for i := 0; ; i++ {
		out, err := e.gh(ctx, root, "run", "view", fmt.Sprint(run.Id), "--json", "databaseId,status,conclusion,url,createdAt")
		if err != nil {
			return nil, fmt.Errorf("could not read %s: %w", run.Url, err)
		}
		var now dispatchRun
		if err := json.Unmarshal(out, &now); err != nil {
			return nil, fmt.Errorf("gh run view: unreadable answer")
		}
		pending := map[string]bool{}
		if now.Status == ghRunWaiting {
			for _, env := range e.pendingEnvironments(ctx, root, now.Id) {
				pending[env] = true
				if !waiting[env] {
					e.printf("%s%s %s\n", ApprovalMarker, env, now.Url)
					e.printf("%s waits for a reviewer to approve its deployment to %s.\n", now.Url, env)
				}
			}
		}
		for env := range waiting {
			if !pending[env] {
				e.printf("%s%s\n", ApprovedMarker, env)
			}
		}
		waiting = pending
		if now.Status == "completed" {
			return &now, nil
		}
		elapsed := e.now().Sub(begin)
		if elapsed > limit {
			return nil, fmt.Errorf("the run is still going after %s: run the step again to start another, or follow %s", limit, run.Url)
		}
		if i%rehearsalReportEvery == 0 {
			e.printf("  %s (%d min)…\n", now.Status, int(elapsed.Minutes()))
		}
		e.sleep(poll)
	}
}
