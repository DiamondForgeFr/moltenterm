// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package release

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// SyncBack carries a release commit back to the trunk by pull request: without it the trunk keeps the previous
// version, and the next promotion is refused (the release branch would hold a change the trunk does not). The commit
// is cherry-picked rather than merged, so the pull request can be merged by any method the trunk accepts. Nothing is
// done when the trunk already holds it.
func (e *Env) SyncBack(ctx context.Context, tag string) error {
	p, err := e.LoadProject(ctx)
	if err != nil {
		return err
	}
	if _, _, err := p.releaseOf(tag); err != nil {
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
	pushed, err := e.tagOnOrigin(ctx, p.Root, tag)
	if err != nil {
		return err
	}
	if !pushed {
		return fmt.Errorf("%s is not on origin: finalize it first", tag)
	}
	trunkRef := "origin/" + p.Trunk
	if e.revParse(ctx, p.Root, trunkRef) == "" {
		return fmt.Errorf("origin has no %s branch", p.Trunk)
	}
	// A tag on a pull request's merge commit (#1046) carries the release commit it merged, not the merge itself.
	commit := e.releaseCommitOfTag(ctx, p.Root, tag)
	cherry, err := e.gitLines(ctx, p.Root, "cherry", trunkRef, commit, commit+"^")
	if err != nil {
		return err
	}
	missing := false
	for _, line := range cherry {
		if strings.HasPrefix(line, "+") {
			missing = true
		}
	}
	if !missing {
		e.printf("%s already holds the release commit of %s: nothing to carry back.\n", p.Trunk, tag)
		return nil
	}
	wt, err := e.ReleaseWorktree(ctx, p.Root)
	if err != nil {
		return err
	}
	if err := e.resetWorktree(ctx, p.Root, wt, trunkRef); err != nil {
		return err
	}
	branch := SyncBackBranchPrefix + tag
	e.printf("Carrying %s back to %s on %s.\n", tag, p.Trunk, branch)
	if _, err := e.git(ctx, wt, "checkout", "--quiet", "-B", branch, trunkRef); err != nil {
		return err
	}
	if _, err := e.git(ctx, wt, "cherry-pick", commit); err != nil {
		e.git(ctx, wt, "cherry-pick", "--abort")
		e.git(ctx, wt, "checkout", "--quiet", "--detach", trunkRef)
		return fmt.Errorf("the release commit of %s conflicts with %s: carry it back by hand (git cherry-pick %s)", tag, p.Trunk, tag)
	}
	if _, err := e.git(ctx, wt, "push", "--quiet", "--force-with-lease", "origin", branch+":refs/heads/"+branch); err != nil {
		return fmt.Errorf("could not push %s: %w", branch, err)
	}
	// The worktree lets go of the branch, so that a later checkout of it elsewhere is not refused.
	e.git(ctx, wt, "checkout", "--quiet", "--detach")
	if !e.OnGithub(ctx, p.Root) {
		e.printf("%s pushed. origin is not on GitHub: merge it into %s there.\n", branch, p.Trunk)
		return nil
	}
	out, err := e.gh(ctx, p.Root, "pr", "list", "--head", branch, "--base", p.Trunk, "--state", "open", "--json", "url")
	if err != nil {
		return err
	}
	var open []struct {
		Url string `json:"url"`
	}
	json.Unmarshal(out, &open)
	if len(open) > 0 {
		e.printf("The pull request is already open, updated: %s\n", open[0].Url)
		return nil
	}
	title := fmt.Sprintf("chore(release): carry %s back to %s", tag, p.Trunk)
	body := fmt.Sprintf("Carries the release commit of %s back to %s: the version files and the release notes. Without it the next promotion of %s is refused.\n\nOpened by `molten release sync-back`.", tag, p.Trunk, p.Trunk)
	created, err := e.gh(ctx, p.Root, "pr", "create", "--base", p.Trunk, "--head", branch, "--title", title, "--body", body)
	if err != nil {
		return fmt.Errorf("%s is pushed, but the pull request could not be opened: %w", branch, err)
	}
	e.printf("Pull request opened: %s\n", strings.TrimSpace(string(created)))
	return nil
}

// SyncBackMerge brings the tagged release back to the trunk by a pull request of the tagged commit itself, and merges
// it with a merge commit once its required checks are green (#1046). Only a merge commit makes the release branch part
// of the trunk's history: squashed or rebased, the release commit lands on the trunk as a copy, the branches diverge
// again, and the next release finds the release branch ahead with commits the trunk only holds as equivalents. The
// developer confirmed the step; nothing is done when the trunk already holds the tag.
func (e *Env) SyncBackMerge(ctx context.Context, tag string) error {
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
	if err := e.fetch(ctx, p.Root); err != nil {
		return err
	}
	pushed, err := e.tagOnOrigin(ctx, p.Root, tag)
	if err != nil {
		return err
	}
	if !pushed {
		return fmt.Errorf("%s is not on origin: tag it first", tag)
	}
	trunkRef := "origin/" + p.Trunk
	if e.revParse(ctx, p.Root, trunkRef) == "" {
		return fmt.Errorf("origin has no %s branch", p.Trunk)
	}
	tagged := e.revParse(ctx, p.Root, "refs/tags/"+tag)
	if e.isAncestor(ctx, p.Root, tagged, trunkRef) {
		e.printf("%s already holds %s: nothing to bring back.\n", p.Trunk, tag)
		return nil
	}
	ticket, err := e.releaseTicket(ctx, p, v.Base().String())
	if err != nil {
		return err
	}
	// The branch is the trunk with the tag merged in, not the tag alone: a trunk whose required checks are strict only
	// takes a pull request up to date with it.
	wt, err := e.ReleaseWorktree(ctx, p.Root)
	if err != nil {
		return err
	}
	if err := e.resetWorktree(ctx, p.Root, wt, trunkRef); err != nil {
		return err
	}
	branch := SyncBackBranchPrefix + tag
	if _, err := e.git(ctx, wt, "checkout", "--quiet", "-B", branch, trunkRef); err != nil {
		return err
	}
	if err := e.installForHooks(ctx, p, wt); err != nil {
		return err
	}
	msg := p.Convention.header(ticket, "bring "+tag+" back to "+p.Trunk)
	if _, err := e.git(ctx, wt, "merge", "--quiet", "--no-ff", "--no-edit", "-m", msg, "refs/tags/"+tag); err != nil {
		conflicts, _ := e.gitLines(ctx, wt, "diff", "--name-only", "--diff-filter=U")
		e.git(ctx, wt, "merge", "--abort")
		e.git(ctx, wt, "checkout", "--quiet", "--detach", trunkRef)
		return fmt.Errorf("merging %s into %s conflicts (%s): merge it by hand with a merge commit on a branch, nothing was pushed", tag, p.Trunk, strings.Join(conflicts, ", "))
	}
	if _, err := e.git(ctx, wt, "push", "--quiet", "--force-with-lease=refs/heads/"+branch, "origin", branch+":refs/heads/"+branch); err != nil {
		return fmt.Errorf("could not push %s: %w", branch, err)
	}
	e.git(ctx, wt, "checkout", "--quiet", "--detach")
	if !e.OnGithub(ctx, p.Root) {
		e.printf("%s pushed with %s merged in. origin is not on GitHub: merge it into %s there with a merge commit (never squash or rebase).\n", branch, tag, p.Trunk)
		return nil
	}
	pr, err := e.findPr(ctx, p, branch, p.Trunk, tag, "open")
	if err != nil {
		return err
	}
	if pr == nil {
		title := msg
		body := fmt.Sprintf("Brings %s back to %s: the release commit and the history of %s. Merged with a merge commit by `molten release sync-back --merge`, never squashed or rebased: %s must become part of %s's history, or the branches diverge again.", tag, p.Trunk, p.Release, p.Release, p.Trunk)
		if _, err := e.gh(ctx, p.Root, "pr", "create", "--base", p.Trunk, "--head", branch, "--title", title, "--body", body); err != nil {
			return fmt.Errorf("%s is pushed, but the pull request could not be opened: %w", branch, err)
		}
		if pr, err = e.findPr(ctx, p, branch, p.Trunk, tag, "open"); err != nil || pr == nil {
			return fmt.Errorf("the pull request of %s into %s was opened but cannot be read back: merge it there with a merge commit", branch, p.Trunk)
		}
		e.printf("Pull request opened: %s\n", pr.Url)
	}
	redo := fmt.Sprintf("run sync-back --merge again (it merges %s into the new %s), or merge %s by hand with a merge commit, never squash or rebase", tag, p.Trunk, branch)
	if err := e.waitAndMerge(ctx, p, pr, p.Trunk, MergeMethodMerge, redo); err != nil {
		return err
	}
	e.printf("%s merged into %s with a merge commit: %s is now part of %s's history.\n", tag, p.Trunk, p.Release, p.Trunk)
	return nil
}
