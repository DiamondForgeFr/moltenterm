// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// Branch cleaning (FR-MC-017), as Notulia's: which branches can go, and their deletion. "Already merged" cannot be read
// from ancestry: pull requests merged with rebase-and-merge (or squashed, or cherry-picked) reach the trunk under new
// commit ids. Two signals answer it instead. On GitHub, the merged pull requests: a branch whose head is exactly the
// head of a pull request merged into a main branch brought nothing since (#571). Otherwise the content: would merging
// the branch into the trunk change anything? `git merge-tree --write-tree` answers it — the trunk's own tree means the
// branch brings nothing — and `git cherry` catches the branches whose commits all reached the trunk under new ids when
// later trunk edits make that merge conflict. Every doubt keeps a branch: one deleted by mistake is work lost, one
// kept by mistake is a line in a list.

const (
	BranchActionDelete = "delete"
	BranchActionKeep   = "keep"

	BranchDeleteMergedPr       = "merged-pr"
	BranchDeleteOnTrunk        = "on-trunk"
	BranchDeletePatchesOnTrunk = "patches-on-trunk"
	// The branch goes with the worktree MoltenTerm made for its pull request, now merged (#906).
	BranchDeleteMergedPrTree = "merged-pr-worktree"

	BranchKeepProtected      = "protected"
	BranchKeepNotOnTrunk     = "not-on-trunk"
	BranchKeepContentUnknown = "content-unknown"
	BranchKeepCheckedOut     = "checked-out"
	BranchKeepOpenPr         = "open-pr"
	BranchKeepPrUnknown      = "pr-unknown"
	BranchKeepCommitsAfterPr = "commits-after-pr"
	// #906: a merged pull request's branch holding commits that pull request never carried.
	BranchKeepNotInPr = "not-in-pr"
	// #906: MoltenTerm's worktree of a merged pull request still holds uncommitted work, or a terminal is open in it.
	BranchKeepTreeChanges = "worktree-changes"
	BranchKeepTreeInUse   = "worktree-in-use"
	// #906: a branch tools keep (pull request screenshots, or one the project lists in branches.tools).
	BranchKeepPrAssets = "pr-assets"
	BranchKeepTool     = "tool-branch"

	// The answer to the "Automatically delete head branches" offer, Turn on or Not now: it is asked once per project.
	autoDeleteAnsweredFile = "autodelete-offer-answered"
	mergedPrsLimit         = "1000"
	prAssetsBranch         = "pr-assets"
	forcePushesQuery       = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){timelineItems(itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT],first:100){nodes{... on HeadRefForcePushedEvent{beforeCommit{oid} afterCommit{oid}}}}}}}`

	branchesTimeout = 60 * time.Second
)

var branchNameRegex = regexp.MustCompile(`^[A-Za-z0-9._/-]+$`)
var treeIdRegex = regexp.MustCompile(`^[0-9a-f]{40,64}$`)

// ownTreeRegex: the worktrees restart.go makes for a pull request in the data folder, work-<PR> or work-<PR>-<k>.
var ownTreeRegex = regexp.MustCompile(`^work-\d+(-\d+)?$`)

type BranchPlan struct {
	Name   string `json:"name"`
	Remote bool   `json:"remote"`
	Action string `json:"action"`
	Reason string `json:"reason,omitempty"`
	// The merged pull request behind merged-pr, merged-pr-worktree, commits-after-pr and not-in-pr.
	Pr int `json:"pr,omitempty"`
	// Worktree: MoltenTerm's worktree holding the branch, removed with it (merged-pr-worktree) or the reason it stays.
	Worktree string `json:"worktree,omitempty"`
	// Terminals: the terminals holding the worktree open (worktree-in-use), so the dialog names their sessions (#932).
	Terminals []WorktreeTerminal `json:"terminals,omitempty"`
	// risk: what the worktree held when it was read, so the removal refuses a worktree that grew since.
	risk *WorktreeRisk
}

type BranchesPlan struct {
	Trunk    string       `json:"trunk"`
	Branches []BranchPlan `json:"branches"`
	// The GitHub repository does not delete head branches on merge, and the offer to turn it on was not answered yet.
	AutoDeleteOffer bool `json:"autodeleteoffer,omitempty"`
}

type BranchesCleanRequest struct {
	Dir   string   `json:"dir"`
	Names []string `json:"names"`
}

type BranchesCleanResult struct {
	Deleted []string `json:"deleted"`
	Failed  int      `json:"failed"`
	Errors  []string `json:"errors,omitempty"`
	// ErrorsText: Errors' codes, by position (#656).
	ErrorsText []*uimsg.Text `json:"errorstext,omitempty"`
}

type BranchesAutoDeleteRequest struct {
	Dir    string `json:"dir"`
	Enable bool   `json:"enable"`
}

type mergedPr struct {
	Number      int    `json:"number"`
	HeadRefName string `json:"headRefName"`
	HeadRefOid  string `json:"headRefOid"`
	BaseRefName string `json:"baseRefName"`
}

type branchFacts struct {
	name       string
	remote     bool
	onTrunk    *bool
	patches    *bool
	checkedOut bool
	openPr     *bool
	// A merged pull request whose head is this branch's head (or one it carried), one whose head this branch has moved
	// past, and one this branch has commits that pull request never carried.
	mergedPr   int
	afterPr    int
	notInPr    int
	tool       string
	ownTree    string
	ownTreeFit string
	treeRisk   *WorktreeRisk
	treeTerms  []WorktreeTerminal
}

func planBranch(f branchFacts, protected map[string]bool) BranchPlan {
	keep := func(reason string) BranchPlan {
		return BranchPlan{Name: f.name, Remote: f.remote, Action: BranchActionKeep, Reason: reason}
	}
	drop := func(reason string) BranchPlan {
		return BranchPlan{Name: f.name, Remote: f.remote, Action: BranchActionDelete, Reason: reason}
	}
	switch {
	case protected[f.name]:
		return keep(BranchKeepProtected)
	case f.tool != "":
		return keep(f.tool)
	case f.checkedOut && f.ownTree != "" && f.mergedPr > 0 && f.openPr != nil && !*f.openPr:
		b := keep(f.ownTreeFit)
		if f.ownTreeFit == "" {
			b = drop(BranchDeleteMergedPrTree)
			b.risk = f.treeRisk
		}
		if b.Reason == BranchKeepCheckedOut {
			return b
		}
		b.Pr, b.Worktree = f.mergedPr, f.ownTree
		if b.Reason == BranchKeepTreeInUse {
			b.Terminals = f.treeTerms
		}
		return b
	case f.checkedOut:
		return keep(BranchKeepCheckedOut)
	case f.openPr != nil && *f.openPr:
		return keep(BranchKeepOpenPr)
	case f.mergedPr > 0 && f.openPr != nil:
		b := drop(BranchDeleteMergedPr)
		b.Pr = f.mergedPr
		return b
	case f.afterPr > 0:
		b := keep(BranchKeepCommitsAfterPr)
		b.Pr = f.afterPr
		return b
	case f.onTrunk == nil:
		return keep(BranchKeepContentUnknown)
	case !*f.onTrunk && (f.patches == nil || !*f.patches) && f.notInPr > 0:
		b := keep(BranchKeepNotInPr)
		b.Pr = f.notInPr
		return b
	case !*f.onTrunk && (f.patches == nil || !*f.patches):
		return keep(BranchKeepNotOnTrunk)
	case f.openPr == nil:
		return keep(BranchKeepPrUnknown)
	case !*f.onTrunk:
		return drop(BranchDeletePatchesOnTrunk)
	}
	return drop(BranchDeleteOnTrunk)
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

// patchesOnTrunk tells whether every commit of the branch has an equivalent on the trunk (same patch id), the case of
// an old rebase-merged branch whose re-merge now conflicts with later trunk edits; nil when git could not say.
func patchesOnTrunk(g *gitReader, trunkRef string, ref string) *bool {
	out, err := g.out("cherry", trunkRef, ref)
	if err != nil {
		return nil
	}
	all := strings.TrimSpace(out) != ""
	for _, line := range strings.Split(out, "\n") {
		if !strings.HasPrefix(line, "- ") {
			all = false
		}
	}
	return &all
}

// prSignal reads the merged pull requests of a branch: the one whose head is the branch's head or a head it carried,
// the newest one whose head the branch has commits after, and the newest one the branch shares nothing with (notInPr).
// Only pull requests merged into a main branch count: one merged into another feature branch says nothing about the
// trunk. A head the pull request carried is an ancestor of its merged head, or one of the heads it had before a force
// push (#906: the batch merge rebases a branch before merging it, so the merged head is not the local one).
func prSignal(g *gitReader, head string, prs []mergedPr, protected map[string]bool, earlierHeads func(number int) []string) (int, int, int) {
	after := 0
	var candidates []mergedPr
	for _, pr := range prs {
		if !protected[pr.BaseRefName] || !treeIdRegex.MatchString(pr.HeadRefOid) {
			continue
		}
		if pr.HeadRefOid == head {
			return pr.Number, 0, 0
		}
		candidates = append(candidates, pr)
		if pr.Number <= after {
			continue
		}
		// Fails as well when the pull request's head is not in this clone: then it says nothing.
		if _, err := g.out("merge-base", "--is-ancestor", pr.HeadRefOid, head); err == nil {
			after = pr.Number
		}
	}
	if after > 0 || len(candidates) == 0 {
		return 0, after, 0
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].Number > candidates[j].Number })
	carried := func(oid string) bool {
		if oid == head {
			return true
		}
		_, err := g.out("merge-base", "--is-ancestor", head, oid)
		return err == nil
	}
	for _, pr := range candidates {
		if carried(pr.HeadRefOid) {
			return pr.Number, 0, 0
		}
		if earlierHeads == nil {
			continue
		}
		for _, oid := range earlierHeads(pr.Number) {
			if carried(oid) {
				return pr.Number, 0, 0
			}
		}
	}
	return 0, 0, candidates[0].Number
}

// forcePushedHeads reads the heads a pull request had before and after each force push; nil when GitHub did not say.
func forcePushedHeads(ctx context.Context, run Runner, dir string, number int) []string {
	out, err := ghJson(ctx, run, dir, "api", "graphql", "-F", "owner={owner}", "-F", "repo={repo}",
		"-F", "number="+strconv.Itoa(number), "-f", "query="+forcePushesQuery)
	if err != nil {
		return nil
	}
	type commit struct {
		Oid string `json:"oid"`
	}
	var answer struct {
		Data struct {
			Repository struct {
				PullRequest struct {
					TimelineItems struct {
						Nodes []struct {
							BeforeCommit *commit `json:"beforeCommit"`
							AfterCommit  *commit `json:"afterCommit"`
						} `json:"nodes"`
					} `json:"timelineItems"`
				} `json:"pullRequest"`
			} `json:"repository"`
		} `json:"data"`
	}
	if json.Unmarshal(out, &answer) != nil {
		return nil
	}
	var rtn []string
	for _, node := range answer.Data.Repository.PullRequest.TimelineItems.Nodes {
		for _, c := range []*commit{node.BeforeCommit, node.AfterCommit} {
			if c != nil && treeIdRegex.MatchString(c.Oid) {
				rtn = append(rtn, c.Oid)
			}
		}
	}
	return rtn
}

// toolBranches are the branches tools keep: pr-assets (pull request screenshots) and those `.molten/project.json`
// lists in branches.tools.
func toolBranches(dir string) map[string]string {
	rtn := map[string]string{prAssetsBranch: BranchKeepPrAssets}
	var pipeline struct {
		Branches struct {
			Tools []string `json:"tools"`
		} `json:"branches"`
	}
	readJson(filepath.Join(dir, molten.ProjectPipelineFile), &pipeline)
	for _, name := range pipeline.Branches.Tools {
		if name != "" && rtn[name] == "" {
			rtn[name] = BranchKeepTool
		}
	}
	return rtn
}

// ownTree tells whether a linked worktree is one MoltenTerm made for a pull request: <data>/molten/worktrees/<project
// folder>/work-<PR>. The developer's and the agent tools' worktrees are never removed by branch cleaning.
func ownTree(dataDir string, path string) bool {
	if dataDir == "" || !ownTreeRegex.MatchString(filepath.Base(path)) {
		return false
	}
	trees := realPath(DepSyncTreesDir(dataDir))
	return filepath.Dir(filepath.Dir(realPath(path))) == trees
}

// ownTreeFit reads MoltenTerm's worktree of a merged pull request as closing it would (Worktrees.Plan): "" when it can
// go with its branch, else why it stays. Git-ignored files go with it, as after a merge (review/loss.go); the branch's
// commits are checked against the pull request instead of the remote, deleted by the merge.
func (r *Runs) ownTreeFit(path string) (string, *WorktreeRisk, []WorktreeTerminal) {
	if r.worktrees == nil {
		return BranchKeepCheckedOut, nil, nil
	}
	plan, err := r.worktrees.Plan(WorktreeRequest{Dir: path})
	switch {
	case err != nil || plan.Locked || plan.Refused != "":
		return BranchKeepCheckedOut, nil, nil
	case plan.Missing:
		return "", nil, nil
	case plan.ChangeCount != 0:
		return BranchKeepTreeChanges, nil, nil
	case len(plan.Terminals) > 0:
		return BranchKeepTreeInUse, nil, plan.Terminals
	}
	return "", &WorktreeRisk{Sha: plan.Sha, ChangeCount: plan.ChangeCount, Unpushed: plan.Unpushed, IgnoredFileCount: plan.IgnoredFileCount}, nil
}

// readPrs reads the open pull requests' head names and the merged ones by head name; each nil when GitHub did not
// answer. Both are empty when no remote is on GitHub: no pull request exists.
func readPrs(ctx context.Context, run Runner, dir string) (map[string]bool, map[string][]mergedPr, bool) {
	var openPrs map[string]bool
	out, err := ghJson(ctx, run, dir, "pr", "list", "--state", "open", "--limit", "200", "--json", "headRefName")
	if err != nil && isNotGithubError(err) {
		return map[string]bool{}, map[string][]mergedPr{}, false
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
	var merged map[string][]mergedPr
	out, err = ghJson(ctx, run, dir, "pr", "list", "--state", "merged", "--limit", mergedPrsLimit, "--json",
		"number,headRefName,headRefOid,baseRefName")
	if err == nil {
		var prs []mergedPr
		if json.Unmarshal(out, &prs) == nil {
			merged = map[string][]mergedPr{}
			for _, pr := range prs {
				merged[pr.HeadRefName] = append(merged[pr.HeadRefName], pr)
			}
		}
	}
	return openPrs, merged, true
}

// autoDeleteOff tells whether the GitHub repository keeps head branches after a merge; false when GitHub did not say.
func autoDeleteOff(ctx context.Context, run Runner, dir string) bool {
	out, err := ghJson(ctx, run, dir, "repo", "view", "--json", "deleteBranchOnMerge")
	if err != nil {
		return false
	}
	var repo struct {
		DeleteBranchOnMerge *bool `json:"deleteBranchOnMerge"`
	}
	if json.Unmarshal(out, &repo) != nil || repo.DeleteBranchOnMerge == nil {
		return false
	}
	return !*repo.DeleteBranchOnMerge
}

func (r *Runs) autoDeleteAnsweredPath(dir string) string {
	return filepath.Join(r.projectDir(dir), autoDeleteAnsweredFile)
}

func (r *Runs) planBranches(ctx context.Context, dir string) (BranchesPlan, error) {
	g := &gitReader{ctx: ctx, run: r.git, dir: dir}
	g.out("fetch", "--quiet", "--prune", "origin")
	trunk, trunkRef := resolveTrunk(ctx, r.git, dir)
	if trunkRef == "" {
		return BranchesPlan{}, uimsg.Errorf(uimsg.Make("mission.branches.noTrunk"), "the project has no trunk branch to compare with")
	}
	trunkTree, err := g.out("rev-parse", trunkRef+"^{tree}")
	if err != nil {
		return BranchesPlan{}, uimsg.Errorf(uimsg.Make("mission.branches.readTrunk", "ref", trunkRef, "detail", err.Error()), "reading %s: %w", trunkRef, err)
	}
	protected := protectedBranches(dir, trunk)
	tools := toolBranches(dir)
	// The worktree holding each checked-out branch; the main checkout's branch is never MoltenTerm's to remove.
	checkedOut := map[string]string{}
	var treePath string
	for i, line := range g.lines("worktree", "list", "--porcelain") {
		if path, ok := strings.CutPrefix(line, "worktree "); ok {
			treePath = path
			if i == 0 {
				treePath = ""
			}
			continue
		}
		if name, ok := strings.CutPrefix(line, "branch refs/heads/"); ok {
			checkedOut[name] = treePath
		}
	}
	openPrs, merged, onGithub := readPrs(ctx, r.git, dir)
	plan := BranchesPlan{Trunk: trunk, Branches: []BranchPlan{}}
	if onGithub && autoDeleteOff(ctx, r.git, dir) {
		_, err := os.Stat(r.autoDeleteAnsweredPath(dir))
		plan.AutoDeleteOffer = errors.Is(err, os.ErrNotExist)
	}
	forcePushes := map[int][]string{}
	earlierHeads := func(number int) []string {
		heads, ok := forcePushes[number]
		if !ok {
			heads = forcePushedHeads(ctx, r.git, dir, number)
			forcePushes[number] = heads
		}
		return heads
	}
	add := func(name string, ref string, head string, remote bool) {
		tree, held := checkedOut[name]
		f := branchFacts{name: name, remote: remote, checkedOut: !remote && held, tool: tools[name]}
		if openPrs != nil {
			open := openPrs[name]
			f.openPr = &open
		}
		if !protected[name] && f.tool == "" && treeIdRegex.MatchString(head) {
			f.mergedPr, f.afterPr, f.notInPr = prSignal(g, head, merged[name], protected, earlierHeads)
		}
		if f.checkedOut && tree != "" && ownTree(r.dataDir, tree) && f.mergedPr > 0 && f.openPr != nil && !*f.openPr {
			f.ownTree = tree
			f.ownTreeFit, f.treeRisk, f.treeTerms = r.ownTreeFit(tree)
		}
		decided := protected[name] || f.tool != "" || f.checkedOut || (f.openPr != nil && *f.openPr) ||
			(f.mergedPr > 0 && f.openPr != nil) || f.afterPr > 0
		if !decided {
			f.onTrunk = contentOnTrunk(g, trunkTree, trunkRef, ref)
			if f.onTrunk != nil && !*f.onTrunk {
				f.patches = patchesOnTrunk(g, trunkRef, ref)
			}
		}
		plan.Branches = append(plan.Branches, planBranch(f, protected))
	}
	refFormat := "--format=%(refname:short)%09%(objectname)"
	for _, line := range g.lines("for-each-ref", refFormat, "refs/heads") {
		name, head, _ := strings.Cut(line, "\t")
		add(name, "refs/heads/"+name, head, false)
	}
	for _, line := range g.lines("for-each-ref", refFormat, "refs/remotes/origin") {
		ref, head, _ := strings.Cut(line, "\t")
		name, ok := strings.CutPrefix(ref, "origin/")
		if !ok || name == "HEAD" || name == "" {
			continue
		}
		add(name, "refs/remotes/origin/"+name, head, true)
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
		return BranchesCleanResult{}, uimsg.Errorf(uimsg.Make("mission.branches.noneToDelete"), "no branch to delete")
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
			result.ErrorsText = append(result.ErrorsText, uimsg.Make("mission.branches.kept", "branch", branchLabel(b), "reason", b.Reason, "pr", strconv.Itoa(b.Pr)))
			continue
		}
		var err error
		switch {
		case b.Remote:
			_, err = r.git(ctx, dir, "git", "push", "--quiet", "origin", "--delete", b.Name)
		case b.Reason == BranchDeleteMergedPrTree:
			err = r.removeOwnTree(ctx, dir, b)
		default:
			_, err = r.git(ctx, dir, "git", "branch", "-D", b.Name)
		}
		if err != nil {
			result.Failed++
			result.Errors = append(result.Errors, fmt.Sprintf("%s: %v", branchLabel(b), err))
			result.ErrorsText = append(result.ErrorsText, uimsg.Make("mission.branches.deleteFailed", "branch", branchLabel(b), "detail", err.Error()))
			continue
		}
		result.Deleted = append(result.Deleted, branchLabel(b))
	}
	return result, nil
}

// removeOwnTree removes MoltenTerm's worktree of a merged pull request through the close-worktree removal, which reads
// it again and refuses one that changed since the plan, then deletes its branch.
func (r *Runs) removeOwnTree(ctx context.Context, dir string, b BranchPlan) error {
	res, err := r.worktrees.Remove(WorktreeRemoveRequest{Dir: b.Worktree, Confirmed: b.risk})
	if err != nil {
		return err
	}
	if res.Gone {
		// Its folder was deleted while git still lists it: prune the entry, or the branch stays "checked out" there.
		r.git(ctx, dir, "git", "worktree", "prune")
	}
	_, err = r.git(ctx, dir, "git", "branch", "-D", b.Name)
	return err
}

// AnswerAutoDelete answers the offer to turn on GitHub's "Automatically delete head branches": Turn on changes the
// repository setting, Not now changes nothing. Either answer is remembered, so the offer is made once.
func (r *Runs) AnswerAutoDelete(req BranchesAutoDeleteRequest) error {
	if err := checkDir(req.Dir); err != nil {
		return err
	}
	dir := filepath.Clean(req.Dir)
	if req.Enable {
		ctx, cancel := context.WithTimeout(context.Background(), branchesTimeout)
		defer cancel()
		if _, err := r.git(ctx, dir, "gh", "repo", "edit", "--delete-branch-on-merge"); err != nil {
			return uimsg.Errorf(uimsg.Make("mission.branches.autoDeleteFailed", "detail", err.Error()), "turning on automatic branch deletion: %w", err)
		}
	}
	if err := os.MkdirAll(r.projectDir(dir), 0700); err != nil {
		return err
	}
	return os.WriteFile(r.autoDeleteAnsweredPath(dir), []byte(time.Now().UTC().Format(time.RFC3339)+"\n"), 0600)
}

func isNotGithubError(err error) bool {
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "none of the git remotes") || strings.Contains(msg, "no git remotes")
}
