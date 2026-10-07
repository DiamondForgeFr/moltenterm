// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package release

import (
	"context"
	"fmt"
	"os"
	"strings"
)

type PromoteOptions struct {
	// The workflows that must be green on the trunk's commit (e.g. ci.yml).
	Workflows []string
	DryRun    bool
}

const maxListedCommits = 20

// Promote brings the trunk onto the release branch (Notulia's promote.mjs): a fast-forward when the release branch is
// behind, else a merge commit (a project carrying an upstream's history is never rebased). The result must hold
// exactly the trunk's tree: anything else means the release branch carries a change the trunk does not, such as a
// release commit not carried back yet, and it is refused. The trunk's CI must be green on the promoted commit. The
// merge is made in a temporary worktree, so the checkout is never touched, and pushed without force.
func (e *Env) Promote(ctx context.Context, opts PromoteOptions) error {
	p, err := e.LoadProject(ctx)
	if err != nil {
		return err
	}
	root := p.Root
	if p.Trunk == p.Release {
		e.printf("%s is both the trunk and the release branch: nothing to promote.\n", p.Trunk)
		return nil
	}
	if err := e.fetch(ctx, root); err != nil {
		return err
	}
	trunkRef, releaseRef := "origin/"+p.Trunk, "origin/"+p.Release
	trunk := e.revParse(ctx, root, trunkRef)
	if trunk == "" {
		return fmt.Errorf("origin has no %s branch", p.Trunk)
	}
	rel := e.revParse(ctx, root, releaseRef)
	if rel == "" {
		return fmt.Errorf("origin has no %s branch: create it from the first commit %s should release", p.Release, p.Trunk)
	}
	if e.isAncestor(ctx, root, trunk, rel) {
		e.printf("%s already holds every commit of %s: nothing to promote.\n", p.Release, p.Trunk)
		return nil
	}
	if _, err := e.git(ctx, root, "diff", "--quiet", rel, trunk); err == nil {
		e.printf("%s already holds the content of %s: nothing to promote.\n", p.Release, p.Trunk)
		return nil
	}

	if e.onGithub(ctx, root) {
		if err := e.requireCi(ctx, root, p.Trunk, trunk, opts.Workflows, opts.DryRun); err != nil {
			return err
		}
	} else {
		e.printf("origin is not on GitHub: no CI to wait for.\n")
	}

	result := trunk
	if !e.isAncestor(ctx, root, rel, trunk) {
		merged, err := e.mergeInTemporaryWorktree(ctx, root, p, rel, trunk)
		if err != nil {
			return err
		}
		result = merged
	}
	incoming, _ := e.gitLines(ctx, root, "log", "--no-merges", "--format=%h %s", rel+".."+result)
	how := "fast-forward"
	if result != trunk {
		how = "merge commit"
	}
	e.printf("\n%d commit(s) of %s reach %s (%s):\n", len(incoming), p.Trunk, p.Release, how)
	for i, line := range incoming {
		if i == maxListedCommits {
			e.printf("  … and %d more\n", len(incoming)-maxListedCommits)
			break
		}
		e.printf("  %s\n", line)
	}
	if opts.DryRun {
		e.printf("\n--dry-run: nothing was pushed.\n")
		return nil
	}
	if _, err := e.git(ctx, root, "push", "--quiet", "origin", result+":refs/heads/"+p.Release); err != nil {
		return fmt.Errorf("could not push %s: %w", p.Release, err)
	}
	e.printf("\n%s promoted onto %s (%s).\n", p.Trunk, p.Release, result[:min(7, len(result))])
	return nil
}

func (e *Env) mergeInTemporaryWorktree(ctx context.Context, root string, p *Project, rel string, trunk string) (string, error) {
	dir, err := os.MkdirTemp("", "molten-promote-")
	if err != nil {
		return "", err
	}
	os.Remove(dir)
	if _, err := e.git(ctx, root, "worktree", "add", "--quiet", "--detach", dir, rel); err != nil {
		return "", fmt.Errorf("could not create a temporary worktree: %w", err)
	}
	defer func() {
		e.git(ctx, root, "worktree", "remove", "--force", dir)
		os.RemoveAll(dir)
	}()
	msg := fmt.Sprintf("Merge branch '%s' into %s", p.Trunk, p.Release)
	if _, err := e.git(ctx, dir, "merge", "--no-ff", "--no-edit", "-m", msg, trunk); err != nil {
		conflicts, _ := e.gitLines(ctx, dir, "diff", "--name-only", "--diff-filter=U")
		e.git(ctx, dir, "merge", "--abort")
		return "", fmt.Errorf("merging %s into %s conflicts (%s): %s holds a change %s does not, carry it back first; nothing was pushed", p.Trunk, p.Release, strings.Join(conflicts, ", "), p.Release, p.Trunk)
	}
	if _, err := e.git(ctx, dir, "diff", "--quiet", trunk, "HEAD"); err != nil {
		drift, _ := e.gitLines(ctx, dir, "diff", "--name-only", trunk, "HEAD")
		return "", fmt.Errorf("the merge differs from %s in %s: %s holds a change %s does not (a release commit not carried back?); nothing was pushed", p.Trunk, strings.Join(drift, ", "), p.Release, p.Trunk)
	}
	return e.git(ctx, dir, "rev-parse", "HEAD")
}
