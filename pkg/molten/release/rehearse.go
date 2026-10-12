// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package release

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	// A dispatched run takes a few seconds to be listed.
	rehearsalFindLimit = 3 * time.Minute
	rehearsalFindPoll  = 5 * time.Second
	// Lines while waiting: one every few polls, not one every 30 seconds for an hour.
	rehearsalReportEvery = 10
)

type RehearseOptions struct {
	// The GitHub workflow that builds the release files without publishing them on workflow_dispatch.
	Workflow string
	// The branch to build; the trunk when empty.
	Ref string
	// Inputs of the workflow, as key=value.
	Fields []string
	// Where to download the artifacts: <Download>/<short commit>/. Nothing is downloaded when empty.
	Download string
}

type RehearsalRun struct {
	Id         int64  `json:"databaseId"`
	Status     string `json:"status"`
	Conclusion string `json:"conclusion"`
	Url        string `json:"url"`
	CreatedAt  string `json:"createdAt"`
	HeadSha    string `json:"headSha"`
}

type RehearsalArtifact struct {
	Name      string `json:"name"`
	Size      int64  `json:"size_in_bytes"`
	Expired   bool   `json:"expired"`
	ExpiresAt string `json:"expires_at"`
}

// Rehearse builds a release's files from a branch without a tag (Notulia's release-candidate.yml, #508): it starts the
// project's release workflow by workflow_dispatch, waits for it, and says where its artifacts are. Nothing is tagged
// or published: the workflow keeps the files as the run's artifacts. Run again on the same commit, it follows the
// rehearsal already running, or reuses the green one whose artifacts are still there, instead of building again.
func (e *Env) Rehearse(ctx context.Context, opts RehearseOptions) error {
	if strings.TrimSpace(opts.Workflow) == "" {
		return fmt.Errorf("name the workflow that rehearses the release: --workflow <file>")
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
		return fmt.Errorf("origin is not on GitHub: a rehearsal runs the release workflow on GitHub Actions")
	}
	ref := opts.Ref
	if ref == "" {
		ref = p.Trunk
	}
	sha, err := e.remoteBranchTip(ctx, root, ref)
	if err != nil {
		return err
	}
	short := sha[:min(7, len(sha))]
	e.printf("Rehearsal of %s on %s %s (no tag, no release).\n", opts.Workflow, ref, short)

	run, err := e.reusableRehearsal(ctx, root, opts, ref, sha)
	if err != nil {
		return err
	}
	if run == nil {
		since := e.now()
		args := []string{"workflow", "run", opts.Workflow, "--ref", ref}
		for _, field := range opts.Fields {
			args = append(args, "-f", field)
		}
		if _, err := e.gh(ctx, root, args...); err != nil {
			return fmt.Errorf("could not start %s on %s: %w", opts.Workflow, ref, err)
		}
		run, err = e.findRehearsal(ctx, root, opts.Workflow, ref, sha, since)
		if err != nil {
			return err
		}
		e.printf("Started: %s\n", run.Url)
	}
	if run.Status != "completed" {
		e.printf("▶ phase: build\n")
		run, err = e.waitRehearsal(ctx, root, run)
		if err != nil {
			return err
		}
	}
	if run.Conclusion != "success" {
		return fmt.Errorf("the rehearsal ended %s: %s", run.Conclusion, run.Url)
	}
	artifacts, err := e.rehearsalArtifacts(ctx, root, run.Id)
	if err != nil {
		return err
	}
	e.printf("\nThe rehearsal is green. Its files, kept as artifacts of %s:\n", run.Url)
	for _, a := range artifacts {
		e.printf("  %s (%s, until %s)\n", a.Name, formatSize(a.Size), shortDate(a.ExpiresAt))
	}
	if opts.Download == "" {
		e.printf("Download them from the run's page (Artifacts), or: gh run download %d\n", run.Id)
		return nil
	}
	dir := filepath.Join(expandHome(opts.Download), short)
	e.printf("▶ phase: download\n")
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("could not empty %s: %w", dir, err)
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	if _, err := e.gh(ctx, root, "run", "download", fmt.Sprint(run.Id), "--dir", dir); err != nil {
		return fmt.Errorf("could not download the artifacts of %s: %w", run.Url, err)
	}
	e.printf("Downloaded into %s\n", dir)
	return nil
}

func (e *Env) rehearsalRuns(ctx context.Context, root string, workflow string, ref string, sha string) ([]RehearsalRun, error) {
	out, err := e.gh(ctx, root, "run", "list", "--workflow", workflow, "--branch", ref, "--event", "workflow_dispatch",
		"--commit", sha, "--limit", "20", "--json", "databaseId,status,conclusion,url,createdAt,headSha")
	if err != nil {
		return nil, fmt.Errorf("could not read the runs of %s: %w", workflow, err)
	}
	var runs []RehearsalRun
	if err := json.Unmarshal(out, &runs); err != nil {
		return nil, fmt.Errorf("gh run list: unreadable answer")
	}
	sort.SliceStable(runs, func(i, j int) bool { return runs[i].CreatedAt > runs[j].CreatedAt })
	return runs, nil
}

// reusableRehearsal is a rehearsal of this very commit that a new one would only repeat: one still running, or a green
// one whose artifacts have not expired. Inputs are not listed by GitHub, so a run asked with --field never reuses one.
func (e *Env) reusableRehearsal(ctx context.Context, root string, opts RehearseOptions, ref string, sha string) (*RehearsalRun, error) {
	if len(opts.Fields) > 0 {
		return nil, nil
	}
	runs, err := e.rehearsalRuns(ctx, root, opts.Workflow, ref, sha)
	if err != nil {
		return nil, err
	}
	for i := range runs {
		run := &runs[i]
		if run.Status != "completed" {
			e.printf("A rehearsal of this commit is already running: %s\n", run.Url)
			return run, nil
		}
		if run.Conclusion != "success" {
			continue
		}
		artifacts, err := e.rehearsalArtifacts(ctx, root, run.Id)
		if err == nil && len(artifacts) > 0 {
			e.printf("This commit was already rehearsed: %s\n", run.Url)
			return run, nil
		}
	}
	return nil, nil
}

// findRehearsal finds the run the dispatch started: the newest one of the commit created since (a minute of clock
// difference allowed).
func (e *Env) findRehearsal(ctx context.Context, root string, workflow string, ref string, sha string, since time.Time) (*RehearsalRun, error) {
	begin := e.now()
	for {
		runs, err := e.rehearsalRuns(ctx, root, workflow, ref, sha)
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

func (e *Env) waitRehearsal(ctx context.Context, root string, run *RehearsalRun) (*RehearsalRun, error) {
	poll, limit := e.CiPoll, e.CiLimit
	if poll <= 0 {
		poll = ciPollInterval
	}
	if limit <= 0 {
		limit = ciWaitLimit
	}
	begin := e.now()
	for i := 0; ; i++ {
		out, err := e.gh(ctx, root, "run", "view", fmt.Sprint(run.Id), "--json", "databaseId,status,conclusion,url,createdAt,headSha")
		if err != nil {
			return nil, fmt.Errorf("could not read %s: %w", run.Url, err)
		}
		var now RehearsalRun
		if err := json.Unmarshal(out, &now); err != nil {
			return nil, fmt.Errorf("gh run view: unreadable answer")
		}
		if now.Status == "completed" {
			return &now, nil
		}
		elapsed := e.now().Sub(begin)
		if elapsed > limit {
			return nil, fmt.Errorf("the rehearsal is still running after %s: run the step again to follow it, %s", limit, run.Url)
		}
		if i%rehearsalReportEvery == 0 {
			e.printf("  building (%s, %d min)…\n", now.Status, int(elapsed.Minutes()))
		}
		e.sleep(poll)
	}
}

func (e *Env) rehearsalArtifacts(ctx context.Context, root string, id int64) ([]RehearsalArtifact, error) {
	out, err := e.gh(ctx, root, "api", fmt.Sprintf("repos/{owner}/{repo}/actions/runs/%d/artifacts?per_page=100", id))
	if err != nil {
		return nil, fmt.Errorf("could not list the artifacts of run %d: %w", id, err)
	}
	var answer struct {
		Artifacts []RehearsalArtifact `json:"artifacts"`
	}
	if err := json.Unmarshal(out, &answer); err != nil {
		return nil, fmt.Errorf("gh api: unreadable list of artifacts")
	}
	rtn := []RehearsalArtifact{}
	for _, a := range answer.Artifacts {
		if !a.Expired {
			rtn = append(rtn, a)
		}
	}
	sort.Slice(rtn, func(i, j int) bool { return rtn[i].Name < rtn[j].Name })
	return rtn, nil
}

func expandHome(path string) string {
	if path != "~" && !strings.HasPrefix(path, "~/") {
		return path
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return path
	}
	return filepath.Join(home, strings.TrimPrefix(path, "~"))
}

func formatSize(bytes int64) string {
	const mb = 1 << 20
	if bytes >= mb {
		return fmt.Sprintf("%d MB", (bytes+mb/2)/mb)
	}
	return fmt.Sprintf("%d KB", (bytes+1023)/1024)
}

func shortDate(stamp string) string {
	t, err := time.Parse(time.RFC3339, stamp)
	if err != nil {
		return stamp
	}
	return t.Format("2006-01-02")
}
