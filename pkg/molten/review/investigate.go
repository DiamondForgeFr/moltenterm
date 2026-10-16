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
// chooses how (#758). The brief names the failed checks, their runs and how to read their logs; the agent says whether
// the PR caused the failure or a flaky or unrelated test did, proposes what to do (rerun, fix on the branch, or a
// ticket for the flaky test) and waits for the developer's choice. Nothing starts without the developer's click.

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
	return r.askOnBranch(ctx, rreq, r.origin(rreq, AgentOriginInvestigate), func(tree string, result *RestartResult) (string, bool) {
		path, err := r.writeInvestigateBrief(req, tree)
		if err != nil {
			result.Status, result.Reason, result.Message = RestartFailed, RestartReasonBrief, fmt.Sprintf("the brief could not be written: %v", err)
			return "", false
		}
		result.BriefPath = path
		return investigatePromptLine(req, path), true
	}), nil
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
	return fmt.Sprintf("MoltenTerm: CI failed on PR #%d (%s): %s. Read the failed jobs' logs, say whether the PR caused it "+
		"or a flaky or unrelated test did, and propose: rerun, fix on %s, or a ticket for the flaky test. Change nothing "+
		"until I choose. Brief: %s", req.Number, req.HeadRef, investigateNames(req.Checks), req.HeadRef, briefPath)
}

func renderInvestigateBrief(req InvestigateRequest, tree string, ticket int) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# Investigate the failed CI of PR #%d\n\n", req.Number)
	b.WriteString("MoltenTerm wrote this brief when the developer clicked Investigate in the Reviews list: checks of the pull " +
		"request failed, so it cannot be merged. You work under the developer's usual permissions.\n\n")
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
		b.WriteString("\n")
	}
	b.WriteString("\n## Steps\n\n")
	b.WriteString("1. Read each failed job's log (the commands above) and find the failing step: the `--- FAIL` lines for Go, the failing test for vitest, the first error otherwise.\n")
	fmt.Fprintf(&b, "2. Decide whether the PR caused it: does the failing code or test touch what the PR changes (`git diff origin/%s...HEAD`)? Run the failing test in %s, several times when it may be flaky. Look at the same check on %s (`gh run list --branch %s -R %s`) to see whether it fails there too.\n", req.BaseRef, tree, req.BaseRef, req.BaseRef, req.Repo)
	b.WriteString("3. Tell the developer, in their language and in a few lines: what failed, the cause with the evidence (log lines, test runs), and whether it is the PR's fault, a flaky test or an unrelated failure.\n")
	b.WriteString("4. Propose one of: rerun the failed jobs (the developer clicks Rerun failed jobs on the PR's row in the Reviews list), fix it on the PR's branch, or open a ticket for the flaky test. Then wait for the developer's choice.\n")
	fmt.Fprintf(&b, "5. Until the developer chooses, change nothing: no edit, commit, push, rerun or ticket. A fix, once chosen, is committed in the project's format and pushed on %s (never a force push without lease); a ticket follows the project's workflow.\n", req.HeadRef)
	b.WriteString("6. Do not change the ticket's status, do not approve or merge the PR: the developer validates it in MoltenTerm.\n")
	return b.String()
}

// writeInvestigateBrief writes the brief in MoltenTerm's data folder, never in the project:
// <data>/molten/reviews/<repo-key>/investigate/<N>-<head>.md.
func (r *Restarter) writeInvestigateBrief(req InvestigateRequest, tree string) (string, error) {
	text := renderInvestigateBrief(req, tree, restartTicket(req.restartRequest()))
	dir := filepath.Join(r.env.DataDir, "molten", "reviews", RepoKey(req.Repo), investigateDirName)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	name := strconv.Itoa(req.Number) + ".md"
	if isOid(req.HeadOid) {
		name = fmt.Sprintf("%d-%s.md", req.Number, shortId(req.HeadOid))
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(text), 0600); err != nil {
		return "", err
	}
	return path, nil
}
