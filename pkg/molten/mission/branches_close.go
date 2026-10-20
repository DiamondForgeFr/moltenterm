// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// A merged pull request's worktree held open by a terminal (#932): Clean branches names the sessions holding it and
// can close them, then clean the branch as it would have; the Sessions list marks the sessions whose branch's pull
// request is merged.

const (
	treePrsTimeout = 30 * time.Second
	// A branch with no merged pull request is asked again after this long; a merged one stays merged for its head.
	treePrsUnmergedTtl = 2 * time.Minute
	maxTreePrsAsked    = 32
)

// TerminalCloser closes a terminal: its job ends and its block goes, with no "worktree kept" notice. The sessions
// package registers wavesrv's (UseTerminalCloser): Mission Control cannot import Wave's block and job controllers.
type TerminalCloser func(ctx context.Context, blockId string) error

var terminalCloserLock sync.Mutex
var terminalCloser TerminalCloser

func UseTerminalCloser(closer TerminalCloser) {
	terminalCloserLock.Lock()
	defer terminalCloserLock.Unlock()
	terminalCloser = closer
}

func registeredTerminalCloser() TerminalCloser {
	terminalCloserLock.Lock()
	defer terminalCloserLock.Unlock()
	return terminalCloser
}

type BranchesCloseRequest struct {
	Dir  string `json:"dir"`
	Name string `json:"name"`
	// BlockIds: the terminals the user confirmed closing.
	BlockIds []string `json:"blockids"`
}

// CloseAndCleanBranch closes the terminals holding a merged pull request's worktree open, then cleans the branch as
// CleanBranches does. The plan is read again first: the branch must still be kept only by its terminals (so never
// with uncommitted work), and every terminal holding it must be one the user confirmed; otherwise nothing is closed.
func (r *Runs) CloseAndCleanBranch(req BranchesCloseRequest, closeTerminal TerminalCloser) (BranchesCleanResult, error) {
	if err := checkDir(req.Dir); err != nil {
		return BranchesCleanResult{}, err
	}
	if strings.HasPrefix(req.Name, "-") || !branchNameRegex.MatchString(req.Name) {
		return BranchesCleanResult{}, fmt.Errorf("not a branch name: %q", req.Name)
	}
	if closeTerminal == nil {
		return BranchesCleanResult{}, fmt.Errorf("terminals cannot be closed here")
	}
	dir := filepath.Clean(req.Dir)
	ctx, cancel := context.WithTimeout(context.Background(), branchesTimeout)
	defer cancel()
	plan, err := r.planBranches(ctx, dir)
	if err != nil {
		return BranchesCleanResult{}, err
	}
	var branch *BranchPlan
	for i, b := range plan.Branches {
		if !b.Remote && b.Name == req.Name {
			branch = &plan.Branches[i]
			break
		}
	}
	if branch == nil {
		return BranchesCleanResult{}, uimsg.Errorf(uimsg.Make("mission.branches.gone", "branch", req.Name), "%s is no longer a branch", req.Name)
	}
	if branch.Reason != BranchKeepTreeInUse {
		result := BranchesCleanResult{Deleted: []string{}, Failed: 1}
		result.Errors = []string{fmt.Sprintf("%s: kept (%s)", branchLabel(*branch), branch.Reason)}
		result.ErrorsText = []*uimsg.Text{uimsg.Make("mission.branches.kept", "branch", branchLabel(*branch), "reason", branch.Reason, "pr", fmt.Sprintf("%d", branch.Pr))}
		return result, nil
	}
	confirmed := map[string]bool{}
	for _, id := range req.BlockIds {
		confirmed[id] = true
	}
	for _, term := range branch.Terminals {
		if !confirmed[term.BlockId] {
			return BranchesCleanResult{}, uimsg.Errorf(uimsg.Make("mission.branches.newTerminal", "branch", req.Name),
				"another terminal opened in the worktree of %s since: nothing was closed", req.Name)
		}
	}
	for _, term := range branch.Terminals {
		if err := closeTerminal(ctx, term.BlockId); err != nil {
			return BranchesCleanResult{}, uimsg.Errorf(uimsg.Make("mission.branches.closeFailed", "detail", err.Error()), "closing a terminal: %w", err)
		}
	}
	return r.CleanBranches(BranchesCleanRequest{Dir: dir, Names: []string{req.Name}})
}

type TreeBranch struct {
	Path   string `json:"path"`
	Branch string `json:"branch"`
}

type TreePrsRequest struct {
	Trees []TreeBranch `json:"trees"`
}

type TreePr struct {
	Path   string `json:"path"`
	Branch string `json:"branch"`
	Pr     int    `json:"pr"`
}

type TreePrsResult struct {
	Merged []TreePr `json:"merged"`
}

type treePrAnswer struct {
	pr     int
	readAt time.Time
}

// TreePrs reads the merged pull request of worktree branches, for the Sessions list's mark (#932). The rule is the
// cleanup's (prSignal): the branch's head is the pull request's head, or one it carried.
type TreePrs struct {
	lock    sync.Mutex
	run     Runner
	now     func() time.Time
	answers map[string]treePrAnswer
}

func MakeTreePrs(run Runner) *TreePrs {
	return &TreePrs{run: run, now: time.Now, answers: map[string]treePrAnswer{}}
}

func (p *TreePrs) cached(key string) (int, bool) {
	p.lock.Lock()
	defer p.lock.Unlock()
	answer, ok := p.answers[key]
	if !ok || (answer.pr == 0 && p.now().Sub(answer.readAt) > treePrsUnmergedTtl) {
		return 0, false
	}
	return answer.pr, true
}

func (p *TreePrs) remember(key string, pr int) {
	p.lock.Lock()
	defer p.lock.Unlock()
	p.answers[key] = treePrAnswer{pr: pr, readAt: p.now()}
}

func (p *TreePrs) Read(req TreePrsRequest) (TreePrsResult, error) {
	rtn := TreePrsResult{Merged: []TreePr{}}
	ctx, cancel := context.WithTimeout(context.Background(), treePrsTimeout)
	defer cancel()
	for i, tree := range req.Trees {
		if i >= maxTreePrsAsked {
			break
		}
		if !filepath.IsAbs(tree.Path) || strings.HasPrefix(tree.Branch, "-") || !branchNameRegex.MatchString(tree.Branch) {
			continue
		}
		if pr := p.read(ctx, filepath.Clean(tree.Path), tree.Branch); pr > 0 {
			rtn.Merged = append(rtn.Merged, TreePr{Path: tree.Path, Branch: tree.Branch, Pr: pr})
		}
	}
	return rtn, nil
}

// read answers 0 when the branch has no merged pull request or when git or GitHub could not say; only an answer is
// remembered.
func (p *TreePrs) read(ctx context.Context, path string, branch string) int {
	g := &gitReader{ctx: ctx, run: p.run, dir: path}
	head, err := g.out("rev-parse", "--verify", "--quiet", "refs/heads/"+branch+"^{commit}")
	if err != nil || !treeIdRegex.MatchString(head) {
		return 0
	}
	key := path + "\x00" + branch + "\x00" + head
	if pr, ok := p.cached(key); ok {
		return pr
	}
	out, err := ghJson(ctx, p.run, path, "pr", "list", "--state", "merged", "--head", branch, "--limit", "20", "--json",
		"number,headRefName,headRefOid,baseRefName")
	if err != nil {
		return 0
	}
	var listed []mergedPr
	if jsonErr := json.Unmarshal(out, &listed); jsonErr != nil {
		return 0
	}
	var prs []mergedPr
	for _, pr := range listed {
		if pr.HeadRefName == branch {
			prs = append(prs, pr)
		}
	}
	trunk, _ := resolveTrunk(ctx, p.run, path)
	earlierHeads := func(number int) []string { return forcePushedHeads(ctx, p.run, path, number) }
	pr, _, _ := prSignal(g, head, prs, protectedBranches(path, trunk), earlierHeads)
	p.remember(key, pr)
	return pr
}
