// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package release

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
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
// release commit not carried back yet, and it is refused. A sync-back copies the release commit, so the merge base stays
// behind it and a trunk change next to the version line conflicts although nothing would be lost: when every commit of
// the release branch has its equivalent on the trunk, the merge takes the trunk's tree. The trunk's CI must be green on
// the promoted commit. The merge is made in a temporary worktree, so the checkout is never touched, and pushed without
// force.
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
		return p.releaseBranchMissing()
	}
	if e.isAncestor(ctx, root, trunk, rel) {
		e.printf("%s already holds every commit of %s: nothing to promote.\n", p.Release, p.Trunk)
		return nil
	}
	if _, err := e.git(ctx, root, "diff", "--quiet", rel, trunk); err == nil {
		e.printf("%s already holds the content of %s: nothing to promote.\n", p.Release, p.Trunk)
		return nil
	}

	if e.OnGithub(ctx, root) {
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
	// The worktree goes inside a private temporary folder: on a shared /tmp, a folder made at a known path could be
	// taken by another user between its creation and git's.
	tmp, err := os.MkdirTemp("", "molten-promote-")
	if err != nil {
		return "", err
	}
	dir := filepath.Join(tmp, "wt")
	defer func() {
		e.git(ctx, root, "worktree", "remove", "--force", dir)
		os.RemoveAll(tmp)
	}()
	if _, err := e.git(ctx, root, "worktree", "add", "--quiet", "--detach", dir, rel); err != nil {
		return "", fmt.Errorf("could not create a temporary worktree: %w", err)
	}
	msg := fmt.Sprintf("Merge branch '%s' into %s", p.Trunk, p.Release)
	if _, err := e.git(ctx, dir, "merge", "--no-ff", "--no-edit", "-m", msg, trunk); err != nil {
		conflicts, _ := e.gitLines(ctx, dir, "diff", "--name-only", "--diff-filter=U")
		e.git(ctx, dir, "merge", "--abort")
		lacking, err := e.commitsLackingOnTrunk(ctx, root, trunk, rel)
		if err != nil {
			return "", err
		}
		if len(lacking) > 0 {
			listed := lacking[:min(maxListedCommits, len(lacking))]
			return "", fmt.Errorf("merging %s into %s conflicts (%s): %s holds %d commit(s) %s has no equivalent of (%s), carry them back first; nothing was pushed", p.Trunk, p.Release, strings.Join(conflicts, ", "), p.Release, len(lacking), p.Trunk, strings.Join(listed, "; "))
		}
		// commit-tree, as git has no "-s theirs": the merge must hold exactly the trunk's tree, and -X theirs would still
		// keep the release branch's changes outside the conflicts.
		merged, err := e.git(ctx, root, "commit-tree", trunk+"^{tree}", "-p", rel, "-p", trunk, "-m", msg)
		if err != nil {
			return "", fmt.Errorf("could not merge %s into %s: %w", p.Trunk, p.Release, err)
		}
		e.printf("Merging %s into %s conflicts (%s), but %s holds an equivalent of every commit of %s: the merge keeps %s's tree.\n", p.Trunk, p.Release, strings.Join(conflicts, ", "), p.Trunk, p.Release, p.Trunk)
		return merged, nil
	}
	if _, err := e.git(ctx, dir, "diff", "--quiet", trunk, "HEAD"); err != nil {
		drift, _ := e.gitLines(ctx, dir, "diff", "--name-only", trunk, "HEAD")
		return "", fmt.Errorf("the merge differs from %s in %s: %s holds a change %s does not (a release commit not carried back?); nothing was pushed", p.Trunk, strings.Join(drift, ", "), p.Release, p.Trunk)
	}
	return e.git(ctx, dir, "rev-parse", "HEAD")
}

// commitsLackingOnTrunk lists the commits of the release branch (merges aside) the trunk holds no equivalent of.
func (e *Env) commitsLackingOnTrunk(ctx context.Context, dir string, trunk string, rel string) ([]string, error) {
	commits, err := e.gitLines(ctx, dir, "log", "--no-merges", "--format=%H %s", trunk+".."+rel)
	if err != nil {
		return nil, err
	}
	var lacking []string
	for _, commit := range commits {
		sha, subject, _ := strings.Cut(commit, " ")
		missing, err := e.lacksEquivalent(ctx, dir, trunk, sha)
		if err != nil {
			return nil, err
		}
		if missing {
			lacking = append(lacking, sha[:min(7, len(sha))]+" "+subject)
		}
	}
	return lacking, nil
}

// lacksEquivalent tells whether the trunk holds no commit with the same change as sha. Each commit is compared on its
// own, as Mission Control reads a release back on the trunk: once a promotion merged the trunk, its cherry-pick is
// reachable from both branches and a branch-wide comparison no longer sees it.
func (e *Env) lacksEquivalent(ctx context.Context, dir string, trunk string, sha string) (bool, error) {
	cherry, err := e.gitLines(ctx, dir, "cherry", trunk, sha, sha+"^")
	if err != nil {
		return false, err
	}
	for _, line := range cherry {
		if strings.HasPrefix(line, "+") {
			return true, nil
		}
	}
	return false, nil
}
