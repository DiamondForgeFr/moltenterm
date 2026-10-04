// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Branch cleaning (FR-MC-017), as Notulia's: which branches can go, and their deletion. "Already merged" cannot be read
// from ancestry: pull requests merged with rebase-and-merge (or squashed, or cherry-picked) reach the trunk under new
// commit ids. The question is asked of the content instead: would merging the branch into the trunk change anything?
// `git merge-tree --write-tree` answers it — the trunk's own tree means the branch brings nothing. Every doubt keeps a
// branch: one deleted by mistake is work lost, one kept by mistake is a line in a list.

const (
	BranchActionDelete = "delete"
	BranchActionKeep   = "keep"

	BranchKeepProtected      = "protected"
	BranchKeepNotOnTrunk     = "not-on-trunk"
	BranchKeepContentUnknown = "content-unknown"
	BranchKeepCheckedOut     = "checked-out"
	BranchKeepOpenPr         = "open-pr"
	BranchKeepPrUnknown      = "pr-unknown"

	branchesTimeout = 60 * time.Second
)

var branchNameRegex = regexp.MustCompile(`^[A-Za-z0-9._/-]+$`)
var treeIdRegex = regexp.MustCompile(`^[0-9a-f]{40,64}$`)

type BranchPlan struct {
	Name   string `json:"name"`
	Remote bool   `json:"remote"`
	Action string `json:"action"`
	Reason string `json:"reason,omitempty"`
}

type BranchesPlan struct {
	Trunk    string       `json:"trunk"`
	Branches []BranchPlan `json:"branches"`
}

type BranchesCleanRequest struct {
	Dir   string   `json:"dir"`
	Names []string `json:"names"`
}

type BranchesCleanResult struct {
	Deleted []string `json:"deleted"`
	Failed  int      `json:"failed"`
	Errors  []string `json:"errors,omitempty"`
}

type branchFacts struct {
	name       string
	remote     bool
	onTrunk    *bool
	checkedOut bool
	openPr     *bool
}

func planBranch(f branchFacts, protected map[string]bool) BranchPlan {
	keep := func(reason string) BranchPlan {
		return BranchPlan{Name: f.name, Remote: f.remote, Action: BranchActionKeep, Reason: reason}
	}
	switch {
	case protected[f.name]:
		return keep(BranchKeepProtected)
	case f.onTrunk == nil:
		return keep(BranchKeepContentUnknown)
	case !*f.onTrunk:
		return keep(BranchKeepNotOnTrunk)
	case f.checkedOut:
		return keep(BranchKeepCheckedOut)
	case f.openPr == nil:
		return keep(BranchKeepPrUnknown)
	case *f.openPr:
		return keep(BranchKeepOpenPr)
	}
	return BranchPlan{Name: f.name, Remote: f.remote, Action: BranchActionDelete}
}

// contentOnTrunk tells whether a branch's code is all on the trunk; nil when git could not say. A conflict answers no:
// the branch changes something the trunk has not.
func contentOnTrunk(g *gitReader, trunkTree string, trunkRef string, ref string) *bool {
	out, err := g.out("merge-tree", "--write-tree", trunkRef, ref)
	tree := strings.TrimSpace(strings.SplitN(out, "\n", 2)[0])
	if !treeIdRegex.MatchString(tree) {
		return nil
	}
	// A conflict still prints the conflicted tree first, and fails.
	same := err == nil && tree == trunkTree
	return &same
}

func (r *Runs) planBranches(ctx context.Context, dir string) (BranchesPlan, error) {
	g := &gitReader{ctx: ctx, run: r.git, dir: dir}
	g.out("fetch", "--quiet", "--prune", "origin")
	trunk, trunkRef := resolveTrunk(ctx, r.git, dir)
	if trunkRef == "" {
		return BranchesPlan{}, errors.New("the project has no trunk branch to compare with")
	}
	trunkTree, err := g.out("rev-parse", trunkRef+"^{tree}")
	if err != nil {
		return BranchesPlan{}, fmt.Errorf("reading %s: %w", trunkRef, err)
	}
	protected := protectedBranches(dir, trunk)
	checkedOut := map[string]bool{}
	for _, line := range g.lines("worktree", "list", "--porcelain") {
		if name, ok := strings.CutPrefix(line, "branch refs/heads/"); ok {
			checkedOut[name] = true
		}
	}
	var openPrs map[string]bool
	out, err := ghJson(ctx, r.git, dir, "pr", "list", "--state", "open", "--limit", "200", "--json", "headRefName")
	if err != nil && isNotGithubError(err) {
		// No remote is on GitHub: no pull request can be open.
		openPrs = map[string]bool{}
	}
	if err == nil {
		var prs []struct {
			HeadRefName string `json:"headRefName"`
		}
		if json.Unmarshal(out, &prs) == nil {
			openPrs = map[string]bool{}
			for _, pr := range prs {
				openPrs[pr.HeadRefName] = true
			}
		}
	}
	plan := BranchesPlan{Trunk: trunk, Branches: []BranchPlan{}}
	add := func(name string, ref string, remote bool) {
		f := branchFacts{name: name, remote: remote, checkedOut: !remote && checkedOut[name]}
		if !protected[name] {
			f.onTrunk = contentOnTrunk(g, trunkTree, trunkRef, ref)
		}
		if openPrs != nil {
			open := openPrs[name]
			f.openPr = &open
		}
		plan.Branches = append(plan.Branches, planBranch(f, protected))
	}
	for _, name := range g.lines("for-each-ref", "--format=%(refname:short)", "refs/heads") {
		add(name, "refs/heads/"+name, false)
	}
	for _, ref := range g.lines("for-each-ref", "--format=%(refname:short)", "refs/remotes/origin") {
		name, ok := strings.CutPrefix(ref, "origin/")
		if !ok || name == "HEAD" || name == "" {
			continue
		}
		add(name, "refs/remotes/origin/"+name, true)
	}
	sort.SliceStable(plan.Branches, func(i, j int) bool {
		if plan.Branches[i].Name != plan.Branches[j].Name {
			return plan.Branches[i].Name < plan.Branches[j].Name
		}
		return !plan.Branches[i].Remote && plan.Branches[j].Remote
	})
	return plan, nil
}

// PlanBranches says what cleaning would do: each branch, deleted or kept, and why. Nothing is deleted here.
func (r *Runs) PlanBranches(dir string) (BranchesPlan, error) {
	if err := checkDir(dir); err != nil {
		return BranchesPlan{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), branchesTimeout)
	defer cancel()
	return r.planBranches(ctx, filepath.Clean(dir))
}

func branchLabel(b BranchPlan) string {
	if b.Remote {
		return "origin/" + b.Name
	}
	return b.Name
}

// CleanBranches deletes these branches, local and remote, each checked again first: the plan the user saw is not
// trusted blindly.
func (r *Runs) CleanBranches(req BranchesCleanRequest) (BranchesCleanResult, error) {
	if err := checkDir(req.Dir); err != nil {
		return BranchesCleanResult{}, err
	}
	if len(req.Names) == 0 {
		return BranchesCleanResult{}, errors.New("no branch to delete")
	}
	wanted := map[string]bool{}
	for _, name := range req.Names {
		if strings.HasPrefix(name, "-") || !branchNameRegex.MatchString(name) {
			return BranchesCleanResult{}, fmt.Errorf("not a branch name: %q", name)
		}
		wanted[name] = true
	}
	dir := filepath.Clean(req.Dir)
	ctx, cancel := context.WithTimeout(context.Background(), branchesTimeout)
	defer cancel()
	plan, err := r.planBranches(ctx, dir)
	if err != nil {
		return BranchesCleanResult{}, err
	}
	result := BranchesCleanResult{Deleted: []string{}}
	for _, b := range plan.Branches {
		if !wanted[b.Name] {
			continue
		}
		if b.Action != BranchActionDelete {
			result.Failed++
			result.Errors = append(result.Errors, fmt.Sprintf("%s: kept (%s)", branchLabel(b), b.Reason))
			continue
		}
		var err error
		if b.Remote {
			_, err = r.git(ctx, dir, "git", "push", "--quiet", "origin", "--delete", b.Name)
		} else {
			_, err = r.git(ctx, dir, "git", "branch", "-D", b.Name)
		}
		if err != nil {
			result.Failed++
			result.Errors = append(result.Errors, fmt.Sprintf("%s: %v", branchLabel(b), err))
			continue
		}
		result.Deleted = append(result.Deleted, branchLabel(b))
	}
	return result, nil
}

func isNotGithubError(err error) bool {
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "none of the git remotes") || strings.Contains(msg, "no git remotes")
}
