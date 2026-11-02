// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package release

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/versions"
)

// The pull-request flow (#1046), for a release branch that refuses direct pushes (a ruleset or a branch protection
// requiring a pull request or checks, with no bypass for the developer): the release is prepared on an RC branch made
// from the trunk (PreparePr), committed and pushed there with its pull request to the release branch (OpenPr), merged
// once the pull request's required checks are green (MergePr), and the tag is put on the merge commit (Tag). Nothing is
// ever pushed to the release branch itself.

const (
	DefaultRcBranchPattern = "rc-{version}"

	MergeMethodMerge  = "merge"
	MergeMethodSquash = "squash"
	MergeMethodRebase = "rebase"

	// GitHub's mergeStateStatus values the merge waits on or stops at.
	mergeStateClean    = "CLEAN"
	mergeStateUnstable = "UNSTABLE"
	mergeStateHasHooks = "HAS_HOOKS"
	mergeStateBehind   = "BEHIND"
	mergeStateDirty    = "DIRTY"

	maxReleaseSearch = 500
)

var rcBranchRegex = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]*$`)

// RcBranch names the RC branch of a version: the project's pattern with {version} the public version it leads to, so
// a version's candidates and its public release share it (rc-1.2.0).
func (p *Project) RcBranch(v versions.Version) (string, error) {
	pattern := p.RcPattern
	if !strings.Contains(pattern, "{version}") {
		pattern = DefaultRcBranchPattern
	}
	name := strings.ReplaceAll(pattern, "{version}", v.Base().String())
	if !rcBranchRegex.MatchString(name) || strings.Contains(name, "..") || strings.HasSuffix(name, ".lock") || strings.HasSuffix(name, "/") {
		return "", fmt.Errorf("the RC branch pattern %q gives %q, not a branch name", pattern, name)
	}
	return name, nil
}

// preparedPr checks that the release worktree holds the preparation of the tag on its RC branch.
func (e *Env) preparedPr(ctx context.Context, p *Project, tag string, v versions.Version) (string, string, error) {
	branch, err := p.RcBranch(v)
	if err != nil {
		return "", "", err
	}
	wt, err := e.ReleaseWorktree(ctx, p.Root)
	if err != nil {
		return "", "", err
	}
	if _, err := os.Stat(filepath.Join(wt, ".git")); err != nil {
		return "", "", fmt.Errorf("nothing is prepared: %s does not exist, prepare %s first (molten release prepare %s --pr)", wt, tag, tag)
	}
	if head, _ := e.git(ctx, wt, "symbolic-ref", "--quiet", "--short", "HEAD"); head != branch {
		return "", "", fmt.Errorf("the release worktree is not on %s: prepare %s again (molten release prepare %s --pr)", branch, tag, tag)
	}
	return branch, wt, nil
}

// lacksOnTrunk lists the commits of ref (merges aside) that the trunk side holds no equivalent of: what a merge with
// -s ours would drop.
func (e *Env) lacksOnTrunk(ctx context.Context, dir string, trunkSide string, ref string) ([]string, error) {
	return e.gitLines(ctx, dir, "log", "--no-merges", "--right-only", "--cherry-pick", "--format=%h %s", trunkSide+"..."+ref)
}

// Reconcile merges the release branch into the prepared RC branch with -s ours when they diverged: the release branch
// carries commits the trunk only holds as equivalents (cherry-picked fixes, a release rebased onto it), so their merge
// conflicts although nothing would be lost. It keeps the trunk's tree and makes the release branch an ancestor, so the
// pull request merges. It does nothing when the release branch is already in the RC branch's history (the usual case
// once a release came back by a merge commit), so the step stays in the pipeline for good. Refused when one of the
// release branch's commits has no equivalent on the trunk: -s ours would drop it.
func (e *Env) Reconcile(ctx context.Context, tag string) error {
	p, err := e.LoadProject(ctx)
	if err != nil {
		return err
	}
	v, _, err := p.releaseOf(tag)
	if err != nil {
		return err
	}
	unlock, err := e.lock(ctx, p.Root)
	if err != nil {
		return err
	}
	defer unlock()
	branch, wt, err := e.preparedPr(ctx, p, tag, v)
	if err != nil {
		return err
	}
	if err := e.fetch(ctx, p.Root); err != nil {
		return err
	}
	releaseRef := "origin/" + p.Release
	if e.revParse(ctx, p.Root, releaseRef) == "" {
		return p.releaseBranchMissing()
	}
	if e.isAncestor(ctx, wt, releaseRef, "HEAD") {
		e.printf("%s already holds %s: nothing to reconcile.\n", branch, p.Release)
		return nil
	}
	lacking, err := e.lacksOnTrunk(ctx, wt, "HEAD", releaseRef)
	if err != nil {
		return err
	}
	if len(lacking) > 0 {
		listed := lacking
		if len(listed) > maxListedCommits {
			listed = listed[:maxListedCommits]
		}
		return fmt.Errorf("%s holds %d commit(s) %s has no equivalent of (%s): a merge with -s ours would drop them; carry them to %s first, nothing was merged", p.Release, len(lacking), p.Trunk, strings.Join(listed, "; "), p.Trunk)
	}
	ticket, err := e.releaseTicket(ctx, p, v.Base().String())
	if err != nil {
		return err
	}
	// -s ours changes no file, so the prepared bump stays in the working tree for the release commit after it; git
	// merges only over an index that matches HEAD, and the release commit stages its files again.
	if _, err := e.git(ctx, wt, "reset", "--quiet"); err != nil {
		return err
	}
	msg := p.Convention.header(ticket, "sync release candidate with "+p.Release) + "\n\n" +
		fmt.Sprintf("Merge %s into %s with -s ours: every commit of %s already has\nits equivalent on %s; the histories are joined, the tree stays %s's.", p.Release, branch, p.Release, p.Trunk, p.Trunk)
	if _, err := e.git(ctx, wt, "merge", "--quiet", "-s", "ours", "--no-edit", "-m", msg, releaseRef); err != nil {
		e.git(ctx, wt, "merge", "--abort")
		return fmt.Errorf("could not merge %s into %s: %w", p.Release, branch, err)
	}
	ahead, _ := e.git(ctx, wt, "rev-list", "--count", "HEAD.."+releaseRef)
	e.printf("%s merged into %s with -s ours (%s commit(s) of %s left behind: %s already holds them all). Nothing is pushed yet.\n", p.Release, branch, ahead, p.Release, p.Trunk)
	return nil
}

type releasePr struct {
	Number      int    `json:"number"`
	Url         string `json:"url"`
	Title       string `json:"title"`
	State       string `json:"state"`
	HeadRefOid  string `json:"headRefOid"`
	MergeCommit *struct {
		Oid string `json:"oid"`
	} `json:"mergeCommit"`
}

// findPr finds the pull request from head to base, in a state, whose title names the tag.
func (e *Env) findPr(ctx context.Context, p *Project, head string, base string, tag string, state string) (*releasePr, error) {
	out, err := e.gh(ctx, p.Root, "pr", "list", "--head", head, "--base", base, "--state", state, "--limit", "30", "--json", "number,url,title,state,headRefOid,mergeCommit")
	if err != nil {
		return nil, err
	}
	var prs []releasePr
	if err := json.Unmarshal(out, &prs); err != nil {
		return nil, fmt.Errorf("gh pr list: unreadable answer")
	}
	for i := range prs {
		if TitleNamesTag(prs[i].Title, tag) {
			return &prs[i], nil
		}
	}
	return nil, nil
}

// commitPrepared commits the prepared release on the RC branch, unless that commit is already its head (a step run
// again after a refused push).
func (e *Env) commitPrepared(ctx context.Context, p *Project, wt string, tag string, v versions.Version, channel string) (bool, error) {
	head, _ := e.git(ctx, wt, "log", "-1", "--format=%s%x1f%b", "HEAD")
	subject, body, _ := strings.Cut(head, "\x1f")
	changed, err := e.changedPaths(ctx, wt)
	if err != nil {
		return false, err
	}
	if IsReleaseCommit(subject, body, tag) && len(changed) == 0 {
		return false, nil
	}
	e.formatRelease(ctx, p, wt, tag)
	allowed, err := e.checkPrepared(ctx, p, wt, tag, v)
	if err != nil {
		return false, err
	}
	ticket, err := e.releaseTicket(ctx, p, v.Base().String())
	if err != nil {
		return false, err
	}
	if err := e.commitRelease(ctx, p, wt, allowed, tag, channel, ticket); err != nil {
		return false, err
	}
	return true, nil
}

// OpenPr commits the prepared release on its RC branch, pushes the branch and opens its pull request to the release
// branch (or updates the one already open). GitHub's strict required checks want the branch up to date with the
// release branch: the preparation merged it in when it could, else the reconciliation did; otherwise it is refused.
func (e *Env) OpenPr(ctx context.Context, tag string) error {
	p, err := e.LoadProject(ctx)
	if err != nil {
		return err
	}
	v, channel, err := p.releaseOf(tag)
	if err != nil {
		return err
	}
	unlock, err := e.lock(ctx, p.Root)
	if err != nil {
		return err
	}
	defer unlock()
	branch, wt, err := e.preparedPr(ctx, p, tag, v)
	if err != nil {
		return err
	}
	if err := e.fetch(ctx, p.Root); err != nil {
		return err
	}
	if where := e.tagTaken(ctx, p.Root, tag); where != "" {
		return fmt.Errorf("%s already exists %s: nothing was committed", tag, where)
	}
	releaseRef := "origin/" + p.Release
	if e.revParse(ctx, p.Root, releaseRef) == "" {
		return p.releaseBranchMissing()
	}
	committed, err := e.commitPrepared(ctx, p, wt, tag, v, channel)
	if err != nil {
		return err
	}
	if !e.isAncestor(ctx, wt, releaseRef, "HEAD") {
		if committed {
			// The prepared tree comes back as it was, so a reconciliation can be made before the release commit.
			e.git(ctx, wt, "reset", "--quiet", "HEAD~1")
		}
		return fmt.Errorf("%s does not hold %s, which its pull request must be up to date with: %s; nothing was pushed", branch, p.Release, upToDateHint(p, tag))
	}
	if _, err := e.git(ctx, wt, "push", "--quiet", "--force-with-lease=refs/heads/"+branch, "origin", "HEAD:refs/heads/"+branch); err != nil {
		return fmt.Errorf("could not push %s (the release commit stays on it; open-pr again): %w", branch, err)
	}
	head := e.revParse(ctx, wt, "HEAD")
	e.printf("%s pushed (%s) with the release commit of %s.\n", branch, head[:min(7, len(head))], tag)
	if !e.OnGithub(ctx, p.Root) {
		e.printf("origin is not on GitHub: merge %s into %s there with a merge commit, then tag it (molten release tag %s).\n", branch, p.Release, tag)
		return nil
	}
	open, err := e.findPr(ctx, p, branch, p.Release, tag, "open")
	if err != nil {
		return err
	}
	if open != nil {
		e.printf("The pull request is already open, updated: %s\n", open.Url)
		return nil
	}
	title, _ := e.git(ctx, wt, "log", "-1", "--format=%s", "HEAD")
	body := fmt.Sprintf("Releases %s: the version files, the release notes and the changelogs, on %s made from %s. Once merged with a merge commit, the tag goes on the merge commit (`molten release tag %s`).\n\nOpened by `molten release open-pr`.", tag, branch, p.Trunk, tag)
	// The release ticket's link, alone on its line: a workflow guard (SaaSFoundryAI's Done check) recognizes the release
	// pull request by it. Into a release branch that is not the default one, it closes nothing by itself.
	if ticket, err := e.releaseTicket(ctx, p, v.Base().String()); err == nil && ticket > 0 {
		body += fmt.Sprintf("\n\nCloses #%d", ticket)
	}
	created, err := e.gh(ctx, p.Root, "pr", "create", "--base", p.Release, "--head", branch, "--title", title, "--body", body)
	if err != nil {
		return fmt.Errorf("%s is pushed, but the pull request could not be opened: %w", branch, err)
	}
	e.printf("Pull request opened: %s\n", strings.TrimSpace(string(created)))
	return nil
}

// TagRcBranch cuts a release candidate that nothing publishes (no workflow starts on its tag): the release commit on
// the RC branch, the branch and the tag pushed together, and nothing merged into the release branch or the trunk. The
// labels bumped to the candidate's version stay on the RC branch; the public release sets them to its own.
func (e *Env) TagRcBranch(ctx context.Context, tag string) error {
	p, err := e.LoadProject(ctx)
	if err != nil {
		return err
	}
	v, channel, err := p.releaseOf(tag)
	if err != nil {
		return err
	}
	unlock, err := e.lock(ctx, p.Root)
	if err != nil {
		return err
	}
	defer unlock()
	branch, wt, err := e.preparedPr(ctx, p, tag, v)
	if err != nil {
		return err
	}
	if err := e.fetch(ctx, p.Root); err != nil {
		return err
	}
	if where := e.tagTaken(ctx, p.Root, tag); where != "" {
		return fmt.Errorf("%s already exists %s: nothing was committed", tag, where)
	}
	committed, err := e.commitPrepared(ctx, p, wt, tag, v, channel)
	if err != nil {
		return err
	}
	if _, err := e.git(ctx, wt, "tag", tag); err != nil {
		return fmt.Errorf("could not tag the release: %w", err)
	}
	if _, err := e.git(ctx, wt, "push", "--quiet", "--atomic", "--force-with-lease=refs/heads/"+branch, "origin", "HEAD:refs/heads/"+branch, "refs/tags/"+tag); err != nil {
		e.git(ctx, wt, "tag", "-d", tag)
		if committed {
			e.git(ctx, wt, "reset", "--quiet", "HEAD~1")
		}
		return fmt.Errorf("the push was refused, nothing reached origin (tag again): %w", err)
	}
	head := e.revParse(ctx, wt, "HEAD")
	e.printf("%s committed on %s (%s), tagged and pushed with it. Nothing reaches %s or %s: the candidate lives on %s.\n", tag, branch, head[:min(7, len(head))], p.Release, p.Trunk, branch)
	return nil
}

func upToDateHint(p *Project, tag string) string {
	return fmt.Sprintf("when every commit of %s already has its equivalent on %s, reconcile (molten release reconcile %s, after the preparation), else carry them to %s; then prepare %s again", p.Release, p.Trunk, tag, p.Trunk, tag)
}

// mergeReleaseBranch brings the release branch into the fresh RC branch, before the bump, when that merge is clean and
// leaves the trunk's tree (after a release whose commit came back by cherry-pick: the same change on both sides).
// Otherwise nothing is merged and the reason is printed: the reconciliation, or the trunk, has to take it.
func (e *Env) mergeReleaseBranch(ctx context.Context, p *Project, wt string, branch string, tag string, v versions.Version) {
	releaseRef := "origin/" + p.Release
	if e.isAncestor(ctx, wt, releaseRef, "HEAD") {
		return
	}
	ticket, err := e.releaseTicket(ctx, p, v.Base().String())
	if err != nil {
		e.printf("%s is not merged into %s: %v.\n", p.Release, branch, err)
		return
	}
	before := e.revParse(ctx, wt, "HEAD")
	msg := p.Convention.header(ticket, "merge "+p.Release+" into "+branch)
	if _, err := e.git(ctx, wt, "merge", "--quiet", "--no-ff", "--no-edit", "-m", msg, releaseRef); err != nil {
		conflicts, _ := e.gitLines(ctx, wt, "diff", "--name-only", "--diff-filter=U")
		e.git(ctx, wt, "merge", "--abort")
		e.git(ctx, wt, "reset", "--quiet", "--hard", before)
		e.printf("%s is not merged into %s: their merge conflicts (%d file(s)); %s.\n", p.Release, branch, len(conflicts), upToDateHint(p, tag))
		return
	}
	if _, err := e.git(ctx, wt, "diff", "--quiet", before, "HEAD"); err != nil {
		drift, _ := e.gitLines(ctx, wt, "diff", "--name-only", before, "HEAD")
		e.git(ctx, wt, "reset", "--quiet", "--hard", before)
		e.printf("%s is not merged into %s: it would change %s, which %s does not hold; %s.\n", p.Release, branch, strings.Join(drift, ", "), p.Trunk, upToDateHint(p, tag))
		return
	}
	e.printf("%s merged into %s: it holds nothing %s lacks.\n", p.Release, branch, p.Trunk)
}

type MergePrOptions struct {
	// merge (the default), squash or rebase: the tag goes on the commit the release branch gets.
	Method string
}

type prChecks struct {
	Name   string `json:"name"`
	State  string `json:"state"`
	Bucket string `json:"bucket"`
	Link   string `json:"link"`
}

// requiredChecks reads the pull request's required checks; gh exits non-zero while one is pending or failed, with its
// list on the standard output all the same. A pull request with no required check reads as none.
func (e *Env) requiredChecks(ctx context.Context, p *Project, number int) ([]prChecks, error) {
	out, err := e.gh(ctx, p.Root, "pr", "checks", fmt.Sprint(number), "--required", "--json", "name,state,bucket,link")
	var checks []prChecks
	if jerr := json.Unmarshal(out, &checks); jerr == nil {
		return checks, nil
	}
	if err != nil && strings.Contains(err.Error(), "no required checks") {
		return []prChecks{}, nil
	}
	if err != nil {
		return nil, err
	}
	return nil, fmt.Errorf("gh pr checks: unreadable answer")
}

// waitAndMerge waits for a pull request's required checks and for GitHub to let it merge, then merges it by method,
// only if its head is still the commit that was checked. A failed check, a branch behind its base or a conflict
// stops it with what to do (redo).
func (e *Env) waitAndMerge(ctx context.Context, p *Project, pr *releasePr, base string, method string, redo string) error {
	e.printf("Pull request %s: waiting for its required checks.\n", pr.Url)
	poll, limit := e.CiPoll, e.CiLimit
	if poll <= 0 {
		poll = ciPollInterval
	}
	if limit <= 0 {
		limit = ciWaitLimit
	}
	begin := e.now()
	reported := map[string]string{}
	for {
		checks, err := e.requiredChecks(ctx, p, pr.Number)
		if err != nil {
			return fmt.Errorf("could not read the checks of %s: %w", pr.Url, err)
		}
		pending := []string{}
		for _, c := range checks {
			if reported[c.Name] != c.Bucket {
				reported[c.Name] = c.Bucket
				e.printf("  %s: %s\n", c.Name, strings.ToLower(c.State))
			}
			switch c.Bucket {
			case "fail", "cancel":
				return fmt.Errorf("the required check %s failed on %s: %s, or re-run it when the code was not the cause; nothing was merged", c.Name, c.Link, redo)
			case "pass", "skipping":
			default:
				pending = append(pending, c.Name)
			}
		}
		view, err := e.prState(ctx, p, pr.Number)
		if err != nil {
			return err
		}
		switch view.MergeStateStatus {
		case mergeStateBehind:
			return fmt.Errorf("%s moved on since the pull request was opened: %s; nothing was merged", base, redo)
		case mergeStateDirty:
			return fmt.Errorf("the pull request conflicts with %s: %s; nothing was merged", base, redo)
		}
		ready := view.MergeStateStatus == mergeStateClean || view.MergeStateStatus == mergeStateUnstable || view.MergeStateStatus == mergeStateHasHooks
		if len(pending) == 0 && ready {
			break
		}
		if e.now().Sub(begin) > limit {
			if len(pending) == 0 {
				return fmt.Errorf("GitHub still does not let the pull request merge after %s (%s: a review or an unresolved conversation?): %s; nothing was merged", limit, strings.ToLower(view.MergeStateStatus), pr.Url)
			}
			return fmt.Errorf("the required checks are still not done after %s (%s): nothing was merged, run it again later", limit, strings.Join(pending, ", "))
		}
		e.sleep(poll)
	}
	args := []string{"pr", "merge", fmt.Sprint(pr.Number), "--" + method}
	if pr.HeadRefOid != "" {
		args = append(args, "--match-head-commit", pr.HeadRefOid)
	}
	if _, err := e.gh(ctx, p.Root, args...); err != nil {
		return fmt.Errorf("GitHub refused the merge of %s: %w", pr.Url, err)
	}
	return nil
}

// MergePr merges the release's pull request into the release branch once its required checks are green: the
// developer confirmed the step (Mission Control asks before it runs), so it does not ask again. A failed check, a
// branch behind the release branch or a conflict stops it; an already merged pull request is reported as merged.
func (e *Env) MergePr(ctx context.Context, tag string, opts MergePrOptions) error {
	p, err := e.LoadProject(ctx)
	if err != nil {
		return err
	}
	v, _, err := p.releaseOf(tag)
	if err != nil {
		return err
	}
	method := opts.Method
	if method == "" {
		method = MergeMethodMerge
	}
	if method != MergeMethodMerge && method != MergeMethodSquash && method != MergeMethodRebase {
		return fmt.Errorf("--method must be merge, squash or rebase (got %q)", method)
	}
	branch, err := p.RcBranch(v)
	if err != nil {
		return err
	}
	if !e.OnGithub(ctx, p.Root) {
		return fmt.Errorf("origin is not on GitHub: merge %s into %s there, then tag it (molten release tag %s)", branch, p.Release, tag)
	}
	if merged, err := e.findPr(ctx, p, branch, p.Release, tag, "merged"); err != nil {
		return err
	} else if merged != nil {
		e.printf("The pull request of %s is already merged: %s\n", tag, merged.Url)
		return nil
	}
	pr, err := e.findPr(ctx, p, branch, p.Release, tag, "open")
	if err != nil {
		return err
	}
	if pr == nil {
		return fmt.Errorf("no open pull request of %s from %s to %s: open it first (molten release open-pr %s)", tag, branch, p.Release, tag)
	}
	redo := fmt.Sprintf("fix it on %s, prepare %s again and open-pr again", p.Trunk, tag)
	if err := e.waitAndMerge(ctx, p, pr, p.Release, method, redo); err != nil {
		return err
	}
	e.printf("Pull request merged into %s (%s): tag the merge commit next (molten release tag %s).\n", p.Release, method, tag)
	return nil
}

type prView struct {
	State            string `json:"state"`
	MergeStateStatus string `json:"mergeStateStatus"`
}

func (e *Env) prState(ctx context.Context, p *Project, number int) (prView, error) {
	out, err := e.gh(ctx, p.Root, "pr", "view", fmt.Sprint(number), "--json", "state,mergeStateStatus")
	if err != nil {
		return prView{}, err
	}
	var view prView
	if err := json.Unmarshal(out, &view); err != nil {
		return prView{}, fmt.Errorf("gh pr view: unreadable answer")
	}
	return view, nil
}

// releaseCommitOn finds the release commit of a tag reachable from ref, by its subject or its Molten-Release trailer.
func (e *Env) releaseCommitOn(ctx context.Context, dir string, ref string, tag string) string {
	out, _ := e.git(ctx, dir, "log", "-n", fmt.Sprint(maxReleaseSearch), "--format=%H%x1f%s%x1f%b%x1e", ref)
	for _, record := range strings.Split(out, "\x1e") {
		fields := strings.SplitN(strings.TrimSpace(record), "\x1f", 3)
		if len(fields) == 3 && IsReleaseCommit(fields[1], fields[2], tag) {
			return fields[0]
		}
	}
	return ""
}

// mergeCommitOf is the commit of the release branch's first-parent line that brought the release commit in: the
// merge commit of a merged pull request, or the release commit itself after a fast-forward or a rebase.
func (e *Env) mergeCommitOf(ctx context.Context, dir string, ref string, release string) string {
	line, _ := e.gitLines(ctx, dir, "rev-list", "--first-parent", "-n", fmt.Sprint(maxReleaseSearch), ref)
	found := ""
	for _, sha := range line {
		if !e.isAncestor(ctx, dir, release, sha) {
			break
		}
		found = sha
	}
	return found
}

// Tag puts the tag on the commit the merged pull request left on the release branch, after reading the version back
// from it, and pushes the tag alone.
func (e *Env) Tag(ctx context.Context, tag string) error {
	p, err := e.LoadProject(ctx)
	if err != nil {
		return err
	}
	v, channel, err := p.releaseOf(tag)
	if err != nil {
		return err
	}
	unlock, err := e.lock(ctx, p.Root)
	if err != nil {
		return err
	}
	defer unlock()
	if err := e.fetch(ctx, p.Root); err != nil {
		return err
	}
	if where := e.tagTaken(ctx, p.Root, tag); where != "" {
		return fmt.Errorf("%s already exists %s: nothing was tagged", tag, where)
	}
	releaseRef := "origin/" + p.Release
	if e.revParse(ctx, p.Root, releaseRef) == "" {
		return p.releaseBranchMissing()
	}
	commit := e.releaseCommitOn(ctx, p.Root, releaseRef, tag)
	if commit == "" {
		return fmt.Errorf("%s holds no release commit of %s: merge its pull request first (molten release merge-pr %s)", p.Release, tag, tag)
	}
	target := e.mergeCommitOf(ctx, p.Root, releaseRef, commit)
	if target == "" {
		return fmt.Errorf("could not find the commit of %s that brought %s in", p.Release, tag)
	}
	wt, err := e.ReleaseWorktree(ctx, p.Root)
	if err != nil {
		return err
	}
	if err := e.resetWorktree(ctx, p.Root, wt, target); err != nil {
		return err
	}
	for _, f := range p.Files {
		found, err := versions.ReadFileVersions(wt, f)
		if err != nil {
			return fmt.Errorf("%s at %s: %w", f.Path, target[:7], err)
		}
		for _, got := range found {
			if got != v.String() {
				return fmt.Errorf("%s at %s reads %s, not %s: nothing was tagged", f.Path, target[:7], got, v)
			}
		}
	}
	if _, err := e.git(ctx, p.Root, "tag", tag, target); err != nil {
		return fmt.Errorf("could not tag the release: %w", err)
	}
	if _, err := e.git(ctx, p.Root, "push", "--quiet", "origin", "refs/tags/"+tag); err != nil {
		e.git(ctx, p.Root, "tag", "-d", tag)
		return fmt.Errorf("the tag push was refused, nothing reached origin (tag again): %w", err)
	}
	e.printf("%s tagged on %s (%s) and pushed.\n", tag, p.Release, target[:min(7, len(target))])
	e.printTagged(p, tag, channel)
	return nil
}

// releaseCommitOfTag is the commit carrying a tag's release: the tagged commit itself, or, for a tag on the merge
// commit of a pull request, the release commit it merged.
func (e *Env) releaseCommitOfTag(ctx context.Context, dir string, tag string) string {
	ref := "refs/tags/" + tag
	if e.revParse(ctx, dir, ref+"^2") == "" {
		return e.revParse(ctx, dir, ref)
	}
	if commit := e.releaseCommitOn(ctx, dir, ref+"^1.."+ref, tag); commit != "" {
		return commit
	}
	return e.revParse(ctx, dir, ref)
}
