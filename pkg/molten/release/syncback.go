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
	cherry, err := e.gitLines(ctx, p.Root, "cherry", trunkRef, "refs/tags/"+tag, "refs/tags/"+tag+"^")
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
	if _, err := e.git(ctx, wt, "cherry-pick", "refs/tags/"+tag); err != nil {
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
