// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/reviewsession"
)

// Check the agents (#954, FR-REV-022 AC8): the Reviews list's button asks the agent on each PR that has something left
// (conflicts with the base, red checks, changes requested, no test report) to verify the PR against its ticket and
// finish it. It goes the way Ask for a rebase goes (rebase.go): the agent on the PR's branch gets the prompt through the
// guarded typing path, a busy one is left alone, and with none there the window lists the PRs and starts a new agent on
// each only on the developer's confirmation. The agent never merges. Nothing starts without the developer's click.

const (
	FinishCommand = "moltenreviewfinish"

	finishDirName = "finish"
	// The failed checks a brief names; a PR with more names the first ones.
	maxFinishChecks = 8
)

type FinishRequest struct {
	PrKey
	Dir     string `json:"dir"`
	HeadRef string `json:"headref"`
	BaseRef string `json:"baseref"`
	HeadOid string `json:"headoid,omitempty"`
	Title   string `json:"title,omitempty"`
	Url     string `json:"url,omitempty"`
	Ticket  int    `json:"ticket,omitempty"`
	// What the Reviews list read as left on the PR: conflicts with the base, the failed checks, changes requested by a
	// reviewer, no test report.
	Conflicts        bool     `json:"conflicts,omitempty"`
	FailedChecks     []string `json:"failedchecks,omitempty"`
	ChangesRequested bool     `json:"changesrequested,omitempty"`
	NoReport         bool     `json:"noreport,omitempty"`
	// MarkReady (#1212): the PR is a draft its agent stopped before marking ready, in a workflow without Human Testing;
	// its last step is the agent's, never the developer's.
	MarkReady bool `json:"markready,omitempty"`
	// Start: the developer chose how a new agent works (Mode, #758); its tab goes in WorkspaceId, named TabName.
	Start       bool   `json:"start,omitempty"`
	Mode        string `json:"mode,omitempty"`
	WorkspaceId string `json:"workspaceid,omitempty"`
	TabName     string `json:"tabname,omitempty"`
	// Agent: the coding agent picked for this run (#845).
	Agent string `json:"agent,omitempty"`
}

func (req FinishRequest) check() error {
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

func (req FinishRequest) restartRequest() RestartRequest {
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

// AskFinish hands the PR's remaining work to the agent on its branch, or, with Start, to a new one (the developer's
// click, a window's only).
func (r *Restarter) AskFinish(ctx context.Context, req FinishRequest) (RestartResult, error) {
	if err := req.check(); err != nil {
		return RestartResult{}, err
	}
	checks := make([]string, 0, len(req.FailedChecks))
	for _, name := range req.FailedChecks {
		name = cleanCheck(InvestigateCheck{Name: name}).Name
		if name == "" {
			continue
		}
		if len(checks) == maxFinishChecks {
			break
		}
		checks = append(checks, name)
	}
	req.FailedChecks = checks
	rreq := req.restartRequest()
	origin := r.origin(rreq, AgentOriginFinish)
	return r.askOnBranch(ctx, rreq, origin, func(tree string, result *RestartResult) (string, bool) {
		path, err := r.writeFinishBrief(req, tree)
		if err != nil {
			result.Status, result.Reason, result.Message = RestartFailed, RestartReasonBrief, fmt.Sprintf("the brief could not be written: %v", err)
			return "", false
		}
		result.BriefPath = path
		return finishPromptLine(req, path), true
	}), nil
}

// finishLeft names what the list read as left on the PR, in the prompt's words.
func finishLeft(req FinishRequest) []string {
	var left []string
	if req.Conflicts {
		left = append(left, "conflicts with "+req.BaseRef)
	}
	if len(req.FailedChecks) > 0 {
		left = append(left, "red CI")
	}
	if req.ChangesRequested {
		left = append(left, "changes requested")
	}
	if req.NoReport {
		left = append(left, "no test report")
	}
	return left
}

// finishPromptLine holds the rules that must hold even if the brief is not read; it fits the guarded typing path.
func finishPromptLine(req FinishRequest, briefPath string) string {
	left := strings.Join(finishLeft(req), ", ")
	if left == "" {
		left = "nothing MoltenTerm can see"
	}
	ready := ""
	if req.MarkReady {
		ready = " It is still a draft: once nothing is left and its full CI is green, mark it ready and move its ticket " +
			"on as the project's workflow says."
	}
	return fmt.Sprintf("MoltenTerm: check PR #%d (%s) and finish it. Left: %s. Verify it against its ticket's acceptance "+
		"criteria, fix what remains (rebase on origin/%s, never merge it in; push with --force-with-lease), never merge "+
		"the PR.%s Brief: %s", req.Number, req.HeadRef, left, req.BaseRef, ready, briefPath)
}

func renderFinishBrief(req FinishRequest, tree string, ticket int) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# Check and finish PR #%d\n\n", req.Number)
	b.WriteString("MoltenTerm wrote this brief when the developer clicked Check the agents in the Integration panel (the PR panel): verify whether " +
		"work remains on this pull request and finish it. You work under the developer's usual permissions.\n\n")
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
		fmt.Fprintf(&b, "- Ticket: #%d\n", ticket)
	}
	fmt.Fprintf(&b, "- Worktree: %s\n\n## What MoltenTerm saw left\n\n", tree)
	if req.Conflicts {
		fmt.Fprintf(&b, "- The PR conflicts with %s.\n", req.BaseRef)
	}
	if len(req.FailedChecks) > 0 {
		fmt.Fprintf(&b, "- Failed checks: %s. Read their logs with `gh pr checks %d` and `gh run view --log-failed`.\n",
			strings.Join(req.FailedChecks, ", "), req.Number)
	}
	if req.ChangesRequested {
		fmt.Fprintf(&b, "- A reviewer requested changes: read the review threads with `gh pr view %d --comments`.\n", req.Number)
	}
	if req.NoReport {
		b.WriteString("- No test report was found on the PR or its ticket.\n")
	}
	if len(finishLeft(req)) == 0 {
		b.WriteString("- Nothing MoltenTerm can see: check the acceptance criteria and the unanswered review comments.\n")
	}
	b.WriteString("\n## Steps\n\n")
	fmt.Fprintf(&b, "1. Work in %s, on %s. If the worktree has uncommitted changes that are not yours, stop and ask the developer.\n", tree, req.HeadRef)
	b.WriteString("2. Read the ticket's acceptance criteria and the PR's unanswered review comments; list what is not done yet.\n")
	fmt.Fprintf(&b, "3. Conflicts: `git fetch origin`, `git rebase origin/%s` (never merge %s into the branch), resolve keeping both intents. When a resolution is unclear, `git rebase --abort` and ask the developer.\n", req.BaseRef, req.BaseRef)
	b.WriteString("4. Red checks: find the cause and fix it on the branch; rerun a job only when the code is not the cause.\n")
	b.WriteString("5. Review comments and acceptance criteria: do what is missing, answer each thread you handled.\n")
	b.WriteString("6. Run the project's checks (build, tests, lint), commit in the project's format, push with `git push --force-with-lease` (never a plain `--force`).\n")
	if req.MarkReady {
		b.WriteString("7. The PR is still a draft and the project's workflow has no Human Testing step: its last step is yours. " +
			"Once nothing is left, wait for its CI to be green, then mark it ready for review and move its ticket to the next status, " +
			"as the project's workflow says (its instructions or workflow tooling). The full CI runs once it is ready: watch it and fix what it finds.\n")
		b.WriteString("8. When that is done, say so in one line. Do not approve or merge the PR: the developer validates it in MoltenTerm.\n")
		return b.String()
	}
	b.WriteString("7. When nothing is left, say so in one line. Do not approve or merge the PR: the developer validates it in MoltenTerm.\n")
	return b.String()
}

// writeFinishBrief writes the brief in MoltenTerm's data folder, never in the project:
// <data>/molten/reviews/<repo-key>/finish/<N>-<head>.md.
func (r *Restarter) writeFinishBrief(req FinishRequest, tree string) (string, error) {
	text := renderFinishBrief(req, tree, restartTicket(req.restartRequest()))
	dir := filepath.Join(r.env.DataDir, "molten", "reviews", RepoKey(req.Repo), finishDirName)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	name := fmt.Sprintf("%d.md", req.Number)
	if isOid(req.HeadOid) {
		name = fmt.Sprintf("%d-%s.md", req.Number, shortId(req.HeadOid))
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(text), 0600); err != nil {
		return "", err
	}
	return path, nil
}
