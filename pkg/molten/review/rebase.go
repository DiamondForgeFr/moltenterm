// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/reviewsession"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// Ask for a rebase (#683): the Reviews list's action on a PR that conflicts with its base. It goes the way Restart work
// goes (restart.go): an agent running on the PR's branch gets the prompt through the guarded typing path of the
// handoffs (#595); when none does, the window offers to start one, and on the developer's choice (out of sight or with
// them, #758) an agent starts in the worktree of the branch, in a tab of its own. The brief, in MoltenTerm's data folder,
// asks for a rebase on the base (never a merge of the base into the branch) and a push with lease; the agent never
// merges the PR.

const (
	RebaseCommand = "moltenreviewrebase"

	// RebaseOffer: no agent runs on the branch; the window offers to start one (Start).
	RebaseOffer = RestartOffer

	rebaseDirName = "rebase"
)

type RebaseRequest struct {
	PrKey
	Dir     string `json:"dir"`
	HeadRef string `json:"headref"`
	BaseRef string `json:"baseref"`
	HeadOid string `json:"headoid,omitempty"`
	Title   string `json:"title,omitempty"`
	Url     string `json:"url,omitempty"`
	Ticket  int    `json:"ticket,omitempty"`
	// MergedPr: the merge that made this PR conflict, when the cleanup after a merge asks (#691); 0 for a row's click.
	MergedPr int `json:"mergedpr,omitempty"`
	// Start: the developer chose how a new agent works (Mode, #758); its tab goes in WorkspaceId, named TabName.
	Start       bool   `json:"start,omitempty"`
	Mode        string `json:"mode,omitempty"`
	WorkspaceId string `json:"workspaceid,omitempty"`
	TabName     string `json:"tabname,omitempty"`
	// Agent: the coding agent picked for this run (#845).
	Agent string `json:"agent,omitempty"`
}

func (req RebaseRequest) check() error {
	if err := req.PrKey.check(); err != nil {
		return err
	}
	if err := checkDir(req.Dir); err != nil {
		return err
	}
	if !reviewsession.ValidRef(req.HeadRef) {
		return fmt.Errorf("headref must be the PR's head branch")
	}
	if !reviewsession.ValidRef(req.BaseRef) {
		return fmt.Errorf("baseref must be the PR's base branch")
	}
	return req.restartRequest().checkStart()
}

func (req RebaseRequest) restartRequest() RestartRequest {
	return RestartRequest{
		PrKey:       req.PrKey,
		Dir:         req.Dir,
		HeadRef:     req.HeadRef,
		BaseRef:     req.BaseRef,
		Title:       req.Title,
		Url:         req.Url,
		Ticket:      req.Ticket,
		Start:       req.Start,
		Mode:        req.Mode,
		WorkspaceId: req.WorkspaceId,
		TabName:     req.TabName,
		Agent:       req.Agent,
	}
}

// branchTrees: the linked worktrees where the branch is checked out, and the main checkout when it is there. An agent
// already working in the main checkout on the branch is reached there for a rebase; MoltenTerm never starts one there.
func (r *Restarter) branchTrees(ctx context.Context, dir string, headRef string) ([]string, string, error) {
	entries, err := r.worktrees(ctx, dir)
	if err != nil {
		return nil, "", err
	}
	ref := "refs/heads/" + headRef
	var linked []string
	main := ""
	for i, e := range entries {
		if e.branch != ref || !pathExists(e.path) {
			continue
		}
		if i == 0 {
			main = e.path
		} else {
			linked = append(linked, e.path)
		}
	}
	return linked, main, nil
}

// AskRebase hands the rebase to the agent on the PR's branch, or, with Start, to a new one (the developer's click, a
// window's only).
func (r *Restarter) AskRebase(ctx context.Context, req RebaseRequest) (RestartResult, error) {
	if err := req.check(); err != nil {
		return RestartResult{}, err
	}
	origin := r.origin(req.restartRequest(), AgentOriginRebase)
	origin.MergedPr = req.MergedPr
	return r.askOnBranch(ctx, req.restartRequest(), origin, func(tree string, result *RestartResult) (string, bool) {
		return r.rebaseLine(req, tree, result)
	}), nil
}

// askOnBranch hands a prompt to the agent on the PR's branch (its linked worktrees, then the main checkout), or, with
// Start, to a new one in the branch's worktree; without Start and with no agent there, it answers the offer. line
// writes the brief for a tree and returns the prompt.
func (r *Restarter) askOnBranch(ctx context.Context, rreq RestartRequest, origin AgentOrigin, line func(tree string, result *RestartResult) (string, bool)) RestartResult {
	if !r.claim(rreq.PrKey) {
		return RestartResult{Status: RestartBusy, Reason: RestartReasonInFlight, Message: "An agent is already being reached for this PR."}
	}
	defer r.release(rreq.PrKey)
	linked, main, err := r.branchTrees(ctx, rreq.Dir, rreq.HeadRef)
	if err != nil {
		return RestartResult{Status: RestartFailed, Reason: RestartReasonWorktree, Branch: rreq.HeadRef, Message: err.Error(), MessageText: uimsg.TextOf(err)}
	}
	trees := linked
	if main != "" {
		trees = append(trees, main)
	}
	for _, tree := range trees {
		result := RestartResult{Branch: rreq.HeadRef, Worktree: tree}
		prompt, ok := line(tree, &result)
		if !ok {
			return result
		}
		if r.reuseAgent(ctx, tree, prompt, &result) {
			r.noteReused(ctx, rreq, &result)
			return result
		}
	}
	if !rreq.Start {
		return r.offer(ctx, rreq, "")
	}
	tree, created, err := r.agentTree(ctx, rreq)
	if err != nil {
		return RestartResult{Status: RestartFailed, Reason: restartTreeReason(err), Branch: rreq.HeadRef, Message: err.Error(), MessageText: uimsg.TextOf(err)}
	}
	result := RestartResult{Branch: rreq.HeadRef, Worktree: tree, WorktreeCreated: created}
	prompt, ok := line(tree, &result)
	if !ok {
		return result
	}
	r.startAgent(ctx, rreq, origin, tree, created, prompt, &result)
	return result
}

func restartTreeReason(err error) string {
	var main *mainCheckoutError
	if errors.As(err, &main) {
		return RestartReasonMainCheckout
	}
	return RestartReasonWorktree
}

// rebaseLine writes the brief for the tree and returns the prompt; false (the result says why) when it was not written.
func (r *Restarter) rebaseLine(req RebaseRequest, tree string, result *RestartResult) (string, bool) {
	path, err := r.writeRebaseBrief(req, tree)
	if err != nil {
		result.Status, result.Reason, result.Message = RestartFailed, RestartReasonBrief, fmt.Sprintf("the brief could not be written: %v", err)
		return "", false
	}
	result.BriefPath = path
	return rebasePromptLine(req, path), true
}

// rebasePromptLine holds the rules that must hold even if the brief is not read; it fits the guarded typing path.
func rebasePromptLine(req RebaseRequest, briefPath string) string {
	return fmt.Sprintf("MoltenTerm: PR #%d (%s) conflicts with %s. Rebase it on origin/%s (never merge %s into the branch), "+
		"resolve the conflicts, re-run the project's checks, then push with git push --force-with-lease. Brief: %s",
		req.Number, req.HeadRef, req.BaseRef, req.BaseRef, req.BaseRef, briefPath)
}

func renderRebaseBrief(req RebaseRequest, tree string, ticket int) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# Rebase PR #%d on %s\n\n", req.Number, req.BaseRef)
	if req.MergedPr > 0 {
		fmt.Fprintf(&b, "MoltenTerm wrote this brief after the developer merged PR #%d into %s: the pull request ", req.MergedPr, req.BaseRef)
	} else {
		b.WriteString("MoltenTerm wrote this brief when the developer clicked Ask for a rebase in the Reviews list: the pull request ")
	}
	fmt.Fprintf(&b, "conflicts with %s and cannot be merged until it is rebased. You work under the developer's usual permissions.\n\n", req.BaseRef)
	fmt.Fprintf(&b, "- Pull request: #%d", req.Number)
	if req.Title != "" {
		fmt.Fprintf(&b, " %s", req.Title)
	}
	if req.Url != "" {
		fmt.Fprintf(&b, " (%s)", req.Url)
	}
	fmt.Fprintf(&b, "\n- Repository: %s\n- Branch: %s into %s\n", req.Repo, req.HeadRef, req.BaseRef)
	if req.HeadOid != "" {
		fmt.Fprintf(&b, "- Head when asked: %s\n", req.HeadOid)
	}
	if ticket > 0 {
		fmt.Fprintf(&b, "- Ticket: #%d (it stays in its current status)\n", ticket)
	}
	fmt.Fprintf(&b, "- Worktree: %s\n\n## Steps\n\n", tree)
	fmt.Fprintf(&b, "1. Work in %s, on %s. If the worktree has uncommitted changes, stop and ask the developer before rebasing.\n", tree, req.HeadRef)
	fmt.Fprintf(&b, "2. `git fetch origin`, then `git rebase origin/%s`. Never merge %s into the branch (no `git merge`, no `git pull` without `--rebase`).\n", req.BaseRef, req.BaseRef)
	b.WriteString("3. Resolve each conflict keeping the intent of both sides, then `git rebase --continue`. When a conflict's right resolution is unclear, `git rebase --abort` and ask the developer.\n")
	b.WriteString("4. Run the project's checks (build, tests, lint) on the rebased branch and fix what the rebase broke.\n")
	fmt.Fprintf(&b, "5. Push with `git push --force-with-lease` (never a plain `--force`).\n")
	b.WriteString("6. Do not change the ticket's status, do not approve or merge the PR: the developer validates it in MoltenTerm.\n")
	return b.String()
}

// writeRebaseBrief writes the brief in MoltenTerm's data folder, never in the project:
// <data>/molten/reviews/<repo-key>/rebase/<N>-<head>.md.
func (r *Restarter) writeRebaseBrief(req RebaseRequest, tree string) (string, error) {
	text := renderRebaseBrief(req, tree, restartTicket(req.restartRequest()))
	dir := filepath.Join(r.env.DataDir, "molten", "reviews", RepoKey(req.Repo), rebaseDirName)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	name := fmt.Sprintf("%d.md", req.Number)
	if head := shortId(req.HeadOid); isOid(req.HeadOid) {
		name = fmt.Sprintf("%d-%s.md", req.Number, head)
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(text), 0600); err != nil {
		return "", err
	}
	return path, nil
}
