// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/reviewsession"
)

// Investigate (#797): the Reviews list's action on a PR whose check failed. It goes the way Ask for a rebase goes
// (rebase.go): the agent on the PR's branch gets the prompt, else the window offers to start one and the developer
// chooses how (#758). The brief names the failed checks, their runs and how to read their logs. Investigate and fix
// (#896): the agent finds the cause and resolves it (a fix pushed on the branch, a rebase on the base pushed with lease,
// or a rerun of a flaky job with its ticket, found or opened), never merges, and asks only for a real decision; its
// state stays MoltenTerm's until the PR's required checks pass (investigate_follow.go). Nothing starts without the
// developer's click.

const (
	InvestigateCommand = "moltenreviewinvestigate"

	investigateDirName = "investigate"
	// The checks a brief names; a PR with more names the first ones and says how many are left.
	maxInvestigateChecks = 8
)

type InvestigateCheck struct {
	Name     string `json:"name"`
	Workflow string `json:"workflow,omitempty"`
	Url      string `json:"url,omitempty"`
	RunId    int64  `json:"runid,omitempty"`
	JobId    int64  `json:"jobid,omitempty"`
}

type InvestigateRequest struct {
	PrKey
	Dir     string             `json:"dir"`
	HeadRef string             `json:"headref"`
	BaseRef string             `json:"baseref"`
	HeadOid string             `json:"headoid,omitempty"`
	Title   string             `json:"title,omitempty"`
	Url     string             `json:"url,omitempty"`
	Ticket  int                `json:"ticket,omitempty"`
	Checks  []InvestigateCheck `json:"checks"`
	// Start: the developer chose how a new agent works (Mode, #758); its tab goes in WorkspaceId, named TabName.
	Start       bool   `json:"start,omitempty"`
	Mode        string `json:"mode,omitempty"`
	WorkspaceId string `json:"workspaceid,omitempty"`
	TabName     string `json:"tabname,omitempty"`
	// Agent: the coding agent picked for this run (#845).
	Agent string `json:"agent,omitempty"`
}

func (req InvestigateRequest) check() error {
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
	if len(req.Checks) == 0 {
		return fmt.Errorf("checks must name the failed checks to investigate")
	}
	for _, c := range req.Checks {
		if strings.TrimSpace(c.Name) == "" || c.RunId < 0 || c.JobId < 0 {
			return fmt.Errorf("each check needs its name, and ids that are not negative")
		}
	}
	return req.restartRequest().checkStart()
}

func (req InvestigateRequest) restartRequest() RestartRequest {
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

// AskInvestigate hands the failed checks to the agent on the PR's branch, or, with Start, to a new one (the developer's
// click, a window's only).
func (r *Restarter) AskInvestigate(ctx context.Context, req InvestigateRequest) (RestartResult, error) {
	if err := req.check(); err != nil {
		return RestartResult{}, err
	}
	for i := range req.Checks {
		req.Checks[i] = cleanCheck(req.Checks[i])
	}
	rreq := req.restartRequest()
	origin := r.origin(rreq, AgentOriginInvestigate)
	result := r.askOnBranch(ctx, rreq, origin, func(tree string, result *RestartResult) (string, bool) {
		path, err := r.writeInvestigateBrief(req, tree)
		if err != nil {
			result.Status, result.Reason, result.Message = RestartFailed, RestartReasonBrief, fmt.Sprintf("the brief could not be written: %v", err)
			return "", false
		}
		result.BriefPath = path
		return investigatePromptLine(req, path), true
	})
	if result.Status == RestartSent && result.BlockId != "" {
		// An agent already on the branch took the work: its state is MoltenTerm's until the PR is green, as a new one's.
		startHead, _ := r.git(ctx, result.Worktree, "rev-parse", "HEAD")
		r.followAgent(agentFollow{req: rreq, origin: origin, tree: result.Worktree, blockId: result.BlockId,
			startHead: startHead, agent: result.Agent}, result.BriefPath)
	}
	return result, nil
}

// cleanCheck keeps a check's text on one short line: a job's name comes from the PR's workflow files, and it is typed
// in an agent's prompt.
func cleanCheck(c InvestigateCheck) InvestigateCheck {
	one := func(text string, limit int) string {
		text = strings.Join(strings.FieldsFunc(text, func(r rune) bool { return r < 0x20 || r == 0x7f }), " ")
		if runes := []rune(text); len(runes) > limit {
			text = string(runes[:limit]) + "…"
		}
		return strings.TrimSpace(text)
	}
	c.Name, c.Workflow = one(c.Name, 80), one(c.Workflow, 80)
	if !strings.HasPrefix(c.Url, "https://") || strings.ContainsAny(c.Url, " \t\r\n`") {
		c.Url = ""
	}
	return c
}

func investigateNames(checks []InvestigateCheck) string {
	names := make([]string, 0, len(checks))
	for i, c := range checks {
		if i == maxInvestigateChecks {
			names = append(names, "…")
			break
		}
		names = append(names, c.Name)
	}
	return strings.Join(names, ", ")
}

// investigatePromptLine holds the rules that must hold even if the brief is not read; it fits the guarded typing path.
func investigatePromptLine(req InvestigateRequest, briefPath string) string {
	return fmt.Sprintf("MoltenTerm: CI failed on PR #%d (%s): %s. Find the cause and resolve it: fix it on %s and push, "+
		"rebase on origin/%s and push --force-with-lease, or rerun a flaky job and ticket it. Never merge. Ask me only for "+
		"a real decision. Brief: %s", req.Number, req.HeadRef, investigateNames(req.Checks), req.HeadRef, req.BaseRef, briefPath)
}

func renderInvestigateBrief(req InvestigateRequest, tree string, ticket int, commit string, outcomePath string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# Investigate and fix the failed CI of PR #%d\n\n", req.Number)
	b.WriteString("MoltenTerm wrote this brief when the developer clicked Investigate and fix in the Reviews list: checks of " +
		"the pull request failed, so it cannot be merged. The developer asks you to find the cause and resolve it, not only " +
		"to diagnose it. You work under the developer's usual permissions.\n\n")
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
	fmt.Fprintf(&b, "- Worktree: %s\n\n## Failed checks\n\n", tree)
	for i, c := range req.Checks {
		if i == maxInvestigateChecks {
			fmt.Fprintf(&b, "- and %d more: `gh pr checks %d -R %s` lists them\n", len(req.Checks)-i, req.Number, req.Repo)
			break
		}
		fmt.Fprintf(&b, "- %s", c.Name)
		if c.Workflow != "" {
			fmt.Fprintf(&b, " (workflow %s)", c.Workflow)
		}
		if c.Url != "" {
			fmt.Fprintf(&b, ": %s", c.Url)
		}
		switch {
		case c.JobId > 0:
			fmt.Fprintf(&b, "\n  - log: `gh run view --job %d --log-failed -R %s`", c.JobId, req.Repo)
		case c.RunId > 0:
			fmt.Fprintf(&b, "\n  - log: `gh run view %d --log-failed -R %s`", c.RunId, req.Repo)
		}
		if c.RunId > 0 {
			fmt.Fprintf(&b, "\n  - rerun: `gh run rerun %d --failed -R %s`", c.RunId, req.Repo)
		}
		b.WriteString("\n")
	}
	b.WriteString("\n## Steps\n\n")
	fmt.Fprintf(&b, "1. Work only in %s, on %s: `git fetch origin`, then `git pull --ff-only`. If the worktree has changes you did not make, stop and ask the developer.\n", tree, req.HeadRef)
	b.WriteString("2. Read each failed job's log (the commands above) and find the failing step: the `--- FAIL` lines for Go, the failing test for vitest, the first error otherwise.\n")
	fmt.Fprintf(&b, "3. Find the cause. Does the failing code or test touch what the PR changes (`git diff origin/%s...HEAD`)? Is the branch behind %s (`git log --oneline HEAD..origin/%s`): a workflow, a script or a fix the failing job needs that exists on %s only? Run the failing test in the worktree, several times when it may be flaky, and look at the same check on %s (`gh run list --branch %s -R %s`).\n",
		req.BaseRef, req.BaseRef, req.BaseRef, req.BaseRef, req.BaseRef, req.BaseRef, req.Repo)
	b.WriteString("4. Resolve it, by cause (several causes can combine: resolve each):\n")
	fmt.Fprintf(&b, "   - The PR caused it: fix it in the worktree, run the project's checks that cover it, commit in the project's format `%s`", commit)
	if ticket > 0 {
		fmt.Fprintf(&b, " with the ticket #%d", ticket)
	}
	fmt.Fprintf(&b, ", then `git push` (never force).\n")
	fmt.Fprintf(&b, "   - The branch is behind %s (missing workflow or script files, conflicts with merged work): `git rebase origin/%s` (never merge %s into the branch), resolve the conflicts keeping the intent of both sides (`git rebase --abort` and ask when the right resolution is unclear), run the project's checks, then `git push --force-with-lease` (never a plain `--force`).\n",
		req.BaseRef, req.BaseRef, req.BaseRef)
	fmt.Fprintf(&b, "   - A flaky or unrelated test: rerun the failed jobs once (the rerun commands above). If the same unrelated failure comes back, look for an open ticket on that test first (`gh issue list -R %s --state open --search \"<test name> in:title\"`) and open one only when none exists, following the project's workflow, with the test, the failing runs and the log lines. Link it in a PR comment (`gh pr comment %d -R %s --body '…'`), then rerun the failed jobs again.\n",
		req.Repo, req.Number, req.Repo)
	fmt.Fprintf(&b, "5. After each push or rerun, watch the checks until they end: `gh pr checks %d -R %s --required --watch` (without `--required` when the repository requires none). At most two fix attempts and two reruns: if the checks still fail, stop.\n", req.Number, req.Repo)
	b.WriteString("6. Never merge or approve the PR, never change the ticket's status, never check out the branch in another folder and never touch another checkout. Stop to ask the developer only for a real decision: a fix that changes the product's behaviour, or a risk to accept.\n")
	fmt.Fprintf(&b, "7. Last, write one line in the developer's language to %s: what you did (\"rebased on %s\", \"fixed <what>\", \"reran <job> (flaky, ticket #<n>)\"). When you stop for a decision or give up, start the line with `needs you:` and say why. Then end your turn: MoltenTerm watches the PR's checks on the pushed head and tells the developer when they pass, or why it needs them.\n",
		outcomePath, req.BaseRef)
	return b.String()
}

// writeInvestigateBrief writes the brief in MoltenTerm's data folder, never in the project:
// <data>/molten/reviews/<repo-key>/investigate/<N>-<head>.md.
func (r *Restarter) writeInvestigateBrief(req InvestigateRequest, tree string) (string, error) {
	dir := filepath.Join(r.env.DataDir, "molten", "reviews", RepoKey(req.Repo), investigateDirName)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	name := strconv.Itoa(req.Number) + ".md"
	if isOid(req.HeadOid) {
		name = fmt.Sprintf("%d-%s.md", req.Number, shortId(req.HeadOid))
	}
	path := filepath.Join(dir, name)
	outcome := investigateOutcomePath(path)
	// An earlier run's outcome line must not end this one.
	if err := os.Remove(outcome); err != nil && !os.IsNotExist(err) {
		return "", err
	}
	ticket := restartTicket(req.restartRequest())
	text := renderInvestigateBrief(req, tree, ticket, r.commitFormat(req.Dir, ticket), outcome)
	if err := os.WriteFile(path, []byte(text), 0600); err != nil {
		return "", err
	}
	return path, nil
}
