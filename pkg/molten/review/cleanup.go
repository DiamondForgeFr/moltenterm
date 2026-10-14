// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/molten/reviewsession"
)

// The cleanup after a merge (FR-REV-013, DS-REV-010 steps 2 to 5): the ticket closed and Done, the review worktree and
// the branch's agent worktree removed when it is safe, the branch deleted when its content is on the base, and the
// other open PRs on the same base brought up to date by GitHub. Validate (FR-REV-012) calls it right after its merge;
// it also runs on its own for a PR merged earlier. Each step reports done, skipped (why) or failed (the message), and a
// failure stops only the steps that depend on it. Every removal goes through the safety checks Mission Control already
// has: nothing uncommitted or unpushed is deleted without the second confirmation of the plan the developer saw.

const (
	CleanupCommand = "moltenreviewcleanup"

	CleanupStepPr           = "pr"
	CleanupStepTicketClose  = "ticket-close"
	CleanupStepTicketDone   = "ticket-done"
	CleanupStepReviewTree   = "review-worktree"
	CleanupStepAgentTree    = "agent-worktree"
	CleanupStepLocalBranch  = "local-branch"
	CleanupStepRemoteBranch = "remote-branch"
	CleanupStepOtherPrs     = "other-prs"

	// CleanupStatePlanned: a step of Validate's plan sheet, before the merge (postmerge.go).
	CleanupStatePlanned = "planned"
	CleanupStateDone    = "done"
	CleanupStateSkipped = "skipped"
	CleanupStateFailed  = "failed"

	CleanupFlagAgentBusy   = "agent-busy"
	CleanupFlagNeedsRebase = "needs-rebase"

	CleanupWorkflowCliPath = ".claude/skills/sf-workflow/workflow-cli.sh"

	cleanupTimeout           = 5 * time.Minute
	cleanupOtherPrsLimit     = "100"
	cleanupMergeStateDirty   = "DIRTY"
	cleanupPrStateMerged     = "MERGED"
	cleanupIssueStateClosed  = "CLOSED"
	cleanupWorkflowDoneMatch = "status: Done"
)

// CleanupSteps is the steps' order; a request naming some of them runs those only.
var CleanupSteps = []string{CleanupStepPr, CleanupStepTicketClose, CleanupStepTicketDone, CleanupStepReviewTree,
	CleanupStepAgentTree, CleanupStepLocalBranch, CleanupStepRemoteBranch, CleanupStepOtherPrs}

var conflictRe = regexp.MustCompile(`(?i)conflict`)

// cleanupRunner runs git, gh and the workflow CLI for the cleanup in wavesrv (a test build may replace it).
var cleanupRunner mission.Runner = mission.ExecRunner

type CleanupRequest struct {
	// Dir: the project's main checkout.
	Dir    string `json:"dir"`
	Repo   string `json:"repo"`
	Number int    `json:"number"`
	// Ticket: the PR's ticket when the caller knows it; otherwise the PR's closing issue, else the branch's {N}.
	Ticket int `json:"ticket,omitempty"`
	// Steps: run these steps only (a retry, or the agent worktree after its second confirmation); all when empty.
	Steps []string `json:"steps,omitempty"`
	// WorktreeConfirmed: the agent worktree's risk the developer confirmed a second time (the step's Confirm).
	WorktreeConfirmed *mission.WorktreeRisk `json:"worktreeconfirmed,omitempty"`
}

// CleanupPr is what the cleanup did to another open PR on the same base.
type CleanupPr struct {
	Number  int    `json:"number"`
	Branch  string `json:"branch"`
	State   string `json:"state"`
	Reason  string `json:"reason,omitempty"`
	Message string `json:"message,omitempty"`
	// Flag: CleanupFlagAgentBusy (update after the agent finishes) or CleanupFlagNeedsRebase (Restart work offers it).
	Flag string `json:"flag,omitempty"`
}

type CleanupStepResult struct {
	Id    string `json:"id"`
	State string `json:"state"`
	// Reason: why the step was skipped; Message: the error of a failed step, or what a done step did.
	Reason  string `json:"reason,omitempty"`
	Message string `json:"message,omitempty"`
	// The agent worktree kept for a second confirmation: its plan, and the risk to send back as WorktreeConfirmed.
	Worktree *mission.WorktreePlan `json:"worktree,omitempty"`
	Confirm  *mission.WorktreeRisk `json:"confirm,omitempty"`
	Prs      []CleanupPr           `json:"prs,omitempty"`
}

type CleanupResult struct {
	Repo    string              `json:"repo"`
	Number  int                 `json:"number"`
	Ticket  int                 `json:"ticket,omitempty"`
	Branch  string              `json:"branch,omitempty"`
	Base    string              `json:"base,omitempty"`
	Steps   []CleanupStepResult `json:"steps"`
	StartAt int64               `json:"startedat"`
	EndAt   int64               `json:"endedat"`
}

// Step returns the result's step, nil when it did not run.
func (r CleanupResult) Step(id string) *CleanupStepResult {
	for i := range r.Steps {
		if r.Steps[i].Id == id {
			return &r.Steps[i]
		}
	}
	return nil
}

// CleanupEnv is what the cleanup reaches outside git and gh; the tests give fakes.
type CleanupEnv struct {
	// Run runs git, gh and the workflow CLI (mission.ExecRunner in wavesrv).
	Run mission.Runner
	// Terminals lists the open terminals of a worktree (mission.WorktreeTerminalsOf).
	Terminals func(ctx context.Context, path string) []mission.WorktreeTerminal
	// AgentState is the state of the agent in a terminal block, "" when none runs.
	AgentState func(blockId string) string
	// EndSession ends the PR's review session (reviewsession.EndSession).
	EndSession func(ctx context.Context, repo string, number int) error
	DataDir    string
	Now        func() time.Time
}

type Cleaner struct {
	env       CleanupEnv
	worktrees *mission.Worktrees
}

func MakeCleaner(env CleanupEnv) *Cleaner {
	if env.Now == nil {
		env.Now = time.Now
	}
	terminals := func(ctx context.Context, path string, exclude []string) []mission.WorktreeTerminal {
		if env.Terminals == nil {
			return nil
		}
		rtn := []mission.WorktreeTerminal{}
		for _, t := range env.Terminals(ctx, path) {
			if !slices.Contains(exclude, t.BlockId) {
				rtn = append(rtn, t)
			}
		}
		return rtn
	}
	return &Cleaner{env: env, worktrees: mission.MakeWorktrees(env.Run, terminals)}
}

type mergedPrFacts struct {
	State       string `json:"state"`
	HeadRefName string `json:"headRefName"`
	HeadRefOid  string `json:"headRefOid"`
	BaseRefName string `json:"baseRefName"`
	Closing     []struct {
		Number int `json:"number"`
	} `json:"closingIssuesReferences"`
}

type openPrFacts struct {
	Number      int    `json:"number"`
	HeadRefName string `json:"headRefName"`
	MergeState  string `json:"mergeStateStatus"`
}

type cleanupRun struct {
	c      *Cleaner
	ctx    context.Context
	req    CleanupRequest
	dir    string
	pr     mergedPrFacts
	ticket int
	// The linked worktree on the PR's branch, "" when none.
	agentTree string
	result    CleanupResult
}

func (r *cleanupRun) gh(args ...string) ([]byte, error) {
	return r.c.env.Run(r.ctx, r.dir, "gh", append(args, "--repo", r.req.Repo)...)
}

func (r *cleanupRun) git(dir string, args ...string) (string, error) {
	out, err := r.c.env.Run(r.ctx, dir, "git", append([]string{"-c", "core.hooksPath=/dev/null"}, args...)...)
	return strings.TrimSpace(string(out)), err
}

func (r *cleanupRun) wanted(id string) bool {
	return len(r.req.Steps) == 0 || slices.Contains(r.req.Steps, id)
}

func (r *cleanupRun) add(step CleanupStepResult) *CleanupStepResult {
	r.result.Steps = append(r.result.Steps, step)
	return &r.result.Steps[len(r.result.Steps)-1]
}

func done(id string, message string) CleanupStepResult {
	return CleanupStepResult{Id: id, State: CleanupStateDone, Message: message}
}

func skipped(id string, reason string) CleanupStepResult {
	return CleanupStepResult{Id: id, State: CleanupStateSkipped, Reason: reason}
}

func failed(id string, err error) CleanupStepResult {
	return CleanupStepResult{Id: id, State: CleanupStateFailed, Message: err.Error()}
}

func (req CleanupRequest) check() error {
	if err := checkDir(req.Dir); err != nil {
		return err
	}
	if err := (PrKey{Repo: req.Repo, Number: req.Number}).check(); err != nil {
		return err
	}
	for _, id := range req.Steps {
		if !slices.Contains(CleanupSteps, id) {
			return fmt.Errorf("unknown cleanup step %q", id)
		}
	}
	return nil
}

// Run runs the cleanup of a merged PR. An error means the request itself was wrong; what happened to each step is in
// the result.
func (c *Cleaner) Run(ctx context.Context, req CleanupRequest) (CleanupResult, error) {
	if err := req.check(); err != nil {
		return CleanupResult{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, cleanupTimeout)
	defer cancel()
	r := &cleanupRun{c: c, ctx: ctx, req: req, dir: filepath.Clean(req.Dir)}
	r.result = CleanupResult{Repo: req.Repo, Number: req.Number, Steps: []CleanupStepResult{}, StartAt: c.env.Now().UnixMilli()}
	defer func() {
		r.result.EndAt = c.env.Now().UnixMilli()
	}()
	// Every step needs the merged PR: without it, nothing is touched.
	if err := r.readPr(); err != nil {
		r.add(failed(CleanupStepPr, err))
		for _, id := range CleanupSteps[1:] {
			if r.wanted(id) {
				r.add(skipped(id, "the merged PR could not be confirmed"))
			}
		}
		r.result.EndAt = c.env.Now().UnixMilli()
		return r.result, nil
	}
	r.result.Ticket, r.result.Branch, r.result.Base = r.ticket, r.pr.HeadRefName, r.pr.BaseRefName
	if r.wanted(CleanupStepTicketClose) {
		r.add(r.closeTicket())
	}
	if r.wanted(CleanupStepTicketDone) {
		r.add(r.ticketDone())
	}
	if r.wanted(CleanupStepReviewTree) {
		r.add(r.removeReviewTree())
	}
	r.agentTree = r.findAgentTree()
	var agentStep *CleanupStepResult
	if r.wanted(CleanupStepAgentTree) {
		agentStep = r.add(r.removeAgentTree())
	}
	if r.wanted(CleanupStepLocalBranch) {
		r.add(r.deleteLocalBranch(agentStep))
	}
	if r.wanted(CleanupStepRemoteBranch) {
		r.add(r.deleteRemoteBranch())
	}
	if r.wanted(CleanupStepOtherPrs) {
		r.add(r.updateOtherPrs())
	}
	r.result.EndAt = c.env.Now().UnixMilli()
	return r.result, nil
}

// readPr confirms the PR is merged and reads its branches and ticket, then fetches: the content checks compare with
// the base as GitHub has it now, and a pruned remote branch shows the merge deleted it.
func (r *cleanupRun) readPr() error {
	out, err := r.gh("pr", "view", strconv.Itoa(r.req.Number), "--json", "state,headRefName,headRefOid,baseRefName,closingIssuesReferences")
	if err != nil {
		return err
	}
	if err := json.Unmarshal(out, &r.pr); err != nil {
		return fmt.Errorf("gh pr view: unreadable answer")
	}
	if r.pr.State != cleanupPrStateMerged {
		return fmt.Errorf("PR #%d is not merged (%s)", r.req.Number, strings.ToLower(r.pr.State))
	}
	if !reviewsession.ValidRef(r.pr.HeadRefName) || !reviewsession.ValidRef(r.pr.BaseRefName) {
		return fmt.Errorf("PR #%d: unusual branch names", r.req.Number)
	}
	r.ticket = r.req.Ticket
	if r.ticket <= 0 && len(r.pr.Closing) > 0 {
		r.ticket = r.pr.Closing[0].Number
	}
	if r.ticket <= 0 {
		r.ticket = mission.TicketOfBranch(r.dir, r.pr.HeadRefName)
	}
	if r.wanted(CleanupStepPr) {
		r.add(done(CleanupStepPr, fmt.Sprintf("PR #%d is merged into %s", r.req.Number, r.pr.BaseRefName)))
	}
	if _, err := r.git(r.dir, "fetch", "--quiet", "--prune", "origin"); err != nil {
		if step := r.result.Step(CleanupStepPr); step != nil {
			step.Message += "; the fetch failed: " + err.Error()
		}
	}
	return nil
}

func (r *cleanupRun) closeTicket() CleanupStepResult {
	if r.ticket <= 0 {
		return skipped(CleanupStepTicketClose, "no ticket found for the PR")
	}
	out, err := r.gh("issue", "view", strconv.Itoa(r.ticket), "--json", "state")
	if err != nil {
		return failed(CleanupStepTicketClose, err)
	}
	var issue struct {
		State string `json:"state"`
	}
	if json.Unmarshal(out, &issue) == nil && issue.State == cleanupIssueStateClosed {
		return skipped(CleanupStepTicketClose, fmt.Sprintf("#%d is already closed", r.ticket))
	}
	if _, err := r.gh("issue", "close", strconv.Itoa(r.ticket)); err != nil {
		return failed(CleanupStepTicketClose, err)
	}
	return done(CleanupStepTicketClose, fmt.Sprintf("#%d closed", r.ticket))
}

// UsesSfWorkflow tells whether the project moves its tickets with sf-workflow's CLI.
func UsesSfWorkflow(dir string) bool {
	info, err := os.Stat(filepath.Join(dir, CleanupWorkflowCliPath))
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	_, err = os.Stat(filepath.Join(dir, molten.ProjectSaaSFoundryFile))
	return err == nil
}

// ticketDone moves the ticket to Done through the project's workflow; its PR-merged guard verifies the merge. A project
// without sf-workflow has no board MoltenTerm moves.
func (r *cleanupRun) ticketDone() CleanupStepResult {
	if r.ticket <= 0 {
		return skipped(CleanupStepTicketDone, "no ticket found for the PR")
	}
	if !UsesSfWorkflow(r.dir) {
		return skipped(CleanupStepTicketDone, "the project does not use sf-workflow")
	}
	cli := filepath.Join(r.dir, CleanupWorkflowCliPath)
	ticket := strconv.Itoa(r.ticket)
	if out, err := r.c.env.Run(r.ctx, r.dir, "bash", cli, "status", ticket); err == nil && strings.Contains(string(out), cleanupWorkflowDoneMatch) {
		return skipped(CleanupStepTicketDone, fmt.Sprintf("#%d is already Done", r.ticket))
	}
	if _, err := r.c.env.Run(r.ctx, r.dir, "bash", cli, "update-status", ticket, "Done"); err != nil {
		return failed(CleanupStepTicketDone, err)
	}
	return done(CleanupStepTicketDone, fmt.Sprintf("#%d moved to Done", r.ticket))
}

// worktreeEntries reads the project's worktrees as path → branch (refs/heads/… or "" when detached).
func (r *cleanupRun) worktreeEntries() ([][2]string, error) {
	out, err := r.git(r.dir, "worktree", "list", "--porcelain")
	if err != nil {
		return nil, err
	}
	var rtn [][2]string
	for _, line := range strings.Split(out, "\n") {
		if path, ok := strings.CutPrefix(line, "worktree "); ok {
			rtn = append(rtn, [2]string{path, ""})
			continue
		}
		if branch, ok := strings.CutPrefix(line, "branch "); ok && len(rtn) > 0 {
			rtn[len(rtn)-1][1] = branch
		}
	}
	return rtn, nil
}

func samePath(a string, b string) bool {
	ra, errA := filepath.EvalSymlinks(a)
	rb, errB := filepath.EvalSymlinks(b)
	if errA != nil || errB != nil {
		return filepath.Clean(a) == filepath.Clean(b)
	}
	return ra == rb
}

// removeReviewTree ends the review session and removes MoltenTerm's detached checkout of the PR. It only ever holds the
// PR's commits, now merged; uncommitted changes in it keep it all the same.
func (r *cleanupRun) removeReviewTree() CleanupStepResult {
	if r.c.env.EndSession != nil {
		if err := r.c.env.EndSession(r.ctx, r.req.Repo, r.req.Number); err != nil {
			return failed(CleanupStepReviewTree, err)
		}
	}
	tree := reviewsession.ReviewTreeDir(r.c.env.DataDir, r.dir, r.req.Number)
	if _, err := os.Stat(tree); errors.Is(err, os.ErrNotExist) {
		return skipped(CleanupStepReviewTree, "no review worktree of this PR (none was made, or the review read the agent's worktree)")
	}
	entries, err := r.worktreeEntries()
	if err != nil {
		return failed(CleanupStepReviewTree, err)
	}
	listed := false
	for i, e := range entries {
		if i > 0 && samePath(e[0], tree) {
			listed = true
		}
	}
	if !listed {
		return skipped(CleanupStepReviewTree, tree+" is not a worktree of the project: left as it is")
	}
	status, err := r.git(tree, "status", "--porcelain", "--untracked-files=normal")
	if err != nil {
		return failed(CleanupStepReviewTree, err)
	}
	if status != "" {
		return skipped(CleanupStepReviewTree, "the review worktree holds uncommitted changes: kept at "+tree)
	}
	if _, err := r.git(r.dir, "worktree", "remove", "--", tree); err != nil {
		return failed(CleanupStepReviewTree, err)
	}
	return done(CleanupStepReviewTree, "removed "+tree)
}

// findAgentTree is the linked worktree that has the PR's branch checked out; never the main checkout.
func (r *cleanupRun) findAgentTree() string {
	entries, err := r.worktreeEntries()
	if err != nil {
		return ""
	}
	for i, e := range entries {
		if i > 0 && e[1] == "refs/heads/"+r.pr.HeadRefName {
			return e[0]
		}
	}
	return ""
}

func riskOf(plan mission.WorktreePlan) *mission.WorktreeRisk {
	return &mission.WorktreeRisk{Sha: plan.Sha, ChangeCount: plan.ChangeCount, Unpushed: plan.Unpushed, IgnoredFileCount: plan.IgnoredFileCount}
}

func keptReason(plan mission.WorktreePlan) string {
	var why []string
	if plan.ChangeCount > 0 {
		why = append(why, fmt.Sprintf("%d uncommitted change(s)", plan.ChangeCount))
	}
	if plan.UnpushedAtRisk() {
		if plan.Unpushed == mission.UnknownCount {
			why = append(why, "commits git could not count")
		} else {
			why = append(why, fmt.Sprintf("%d commit(s) not on the base or a remote", plan.Unpushed))
		}
	}
	if plan.IgnoredFileCount > 0 {
		why = append(why, fmt.Sprintf("%d ignored file(s)", plan.IgnoredFileCount))
	}
	if len(plan.Terminals) > 0 {
		why = append(why, fmt.Sprintf("%d open terminal(s)", len(plan.Terminals)))
	}
	return "the agent worktree holds " + strings.Join(why, ", ") + ": kept until you confirm"
}

// removeAgentTree goes through Mission Control's worktree plan: anything at risk keeps the worktree until the developer
// confirms that plan a second time, and a worktree that changed since is kept again.
func (r *cleanupRun) removeAgentTree() CleanupStepResult {
	if r.agentTree == "" {
		return skipped(CleanupStepAgentTree, "no worktree has "+r.pr.HeadRefName+" checked out")
	}
	plan, err := r.c.worktrees.Plan(mission.WorktreeRequest{Dir: r.agentTree})
	if err != nil {
		return failed(CleanupStepAgentTree, err)
	}
	if plan.Refused != "" {
		return skipped(CleanupStepAgentTree, "MoltenTerm does not remove "+r.agentTree+": "+plan.Refused)
	}
	if plan.Locked {
		return skipped(CleanupStepAgentTree, "the agent worktree is locked")
	}
	if plan.NeedsConfirmation() && r.req.WorktreeConfirmed == nil {
		step := skipped(CleanupStepAgentTree, keptReason(plan))
		step.Worktree, step.Confirm = &plan, riskOf(plan)
		return step
	}
	res, err := r.c.worktrees.Remove(mission.WorktreeRemoveRequest{Dir: r.agentTree, Confirmed: r.req.WorktreeConfirmed})
	if err != nil {
		step := failed(CleanupStepAgentTree, err)
		if again, perr := r.c.worktrees.Plan(mission.WorktreeRequest{Dir: r.agentTree}); perr == nil && !again.Missing {
			step.Worktree, step.Confirm = &again, riskOf(again)
		}
		return step
	}
	r.agentTree = ""
	if res.Gone {
		return skipped(CleanupStepAgentTree, "the agent worktree was already removed")
	}
	return done(CleanupStepAgentTree, "removed "+res.Real)
}

// deleteLocalBranch deletes the PR's local branch when what it holds is on the base: its tip is the head GitHub merged,
// or its content is on origin/<base> (a rebase merge gives new commit ids, so ancestry cannot tell).
func (r *cleanupRun) deleteLocalBranch(agentStep *CleanupStepResult) CleanupStepResult {
	branch := r.pr.HeadRefName
	tip, err := r.git(r.dir, "rev-parse", "--verify", "--quiet", "refs/heads/"+branch)
	if err != nil || tip == "" {
		return skipped(CleanupStepLocalBranch, "no local branch "+branch)
	}
	if r.agentTree != "" {
		if agentStep != nil && agentStep.State == CleanupStateFailed {
			return skipped(CleanupStepLocalBranch, "depends on the agent worktree, which could not be removed")
		}
		return skipped(CleanupStepLocalBranch, branch+" is checked out in the kept agent worktree")
	}
	entries, err := r.worktreeEntries()
	if err != nil {
		return failed(CleanupStepLocalBranch, err)
	}
	if len(entries) > 0 && entries[0][1] == "refs/heads/"+branch {
		return skipped(CleanupStepLocalBranch, branch+" is checked out in the project's main checkout")
	}
	base := "refs/remotes/origin/" + r.pr.BaseRefName
	mergedHead := reviewsession.IsOid(r.pr.HeadRefOid) && tip == r.pr.HeadRefOid
	if !mergedHead {
		on := mission.BranchContentOn(r.ctx, r.c.env.Run, r.dir, base, "refs/heads/"+branch)
		if on == nil {
			return skipped(CleanupStepLocalBranch, "could not tell whether "+branch+" is on "+r.pr.BaseRefName+": kept")
		}
		if !*on {
			return skipped(CleanupStepLocalBranch, branch+" has work that is not on "+r.pr.BaseRefName+": kept")
		}
	}
	// -D: a rebase-merged branch is not an ancestor of the base; its content was checked instead.
	if _, err := r.git(r.dir, "branch", "-D", branch); err != nil {
		return failed(CleanupStepLocalBranch, err)
	}
	return done(CleanupStepLocalBranch, "deleted "+branch)
}

// deleteRemoteBranch: the merge deletes it (gh pr merge --delete-branch, or the repository's automatic deletion); one
// still there is deleted only when it is still the head GitHub merged.
func (r *cleanupRun) deleteRemoteBranch() CleanupStepResult {
	branch := r.pr.HeadRefName
	tip, err := r.git(r.dir, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/"+branch)
	if err != nil || tip == "" {
		return skipped(CleanupStepRemoteBranch, "origin/"+branch+" was deleted by the merge")
	}
	if !reviewsession.IsOid(r.pr.HeadRefOid) || tip != r.pr.HeadRefOid {
		return skipped(CleanupStepRemoteBranch, "origin/"+branch+" has commits pushed after the merge: kept")
	}
	if _, err := r.git(r.dir, "push", "--quiet", "origin", "--delete", branch); err != nil {
		return failed(CleanupStepRemoteBranch, err)
	}
	return done(CleanupStepRemoteBranch, "deleted origin/"+branch)
}

// Cleanup runs the cleanup of a merged PR and records its outcome in the review store, which the Review tab and the
// Validate sheet read.
func (s *Service) Cleanup(ctx context.Context, req CleanupRequest) (CleanupResult, error) {
	if s.cleaner == nil {
		return CleanupResult{}, errors.New("the cleanup is not available")
	}
	result, err := s.cleaner.Run(ctx, req)
	if err != nil {
		return result, err
	}
	state, changed, err := s.store.SetCleanup(result)
	if _, err := s.changed(state, changed, err); err != nil {
		return result, fmt.Errorf("the cleanup ran but its outcome could not be recorded: %w", err)
	}
	return result, nil
}

// busyAgent tells whether an agent works or waits in a worktree that has the branch checked out.
func (r *cleanupRun) busyAgent(entries [][2]string, branch string) bool {
	if r.c.env.Terminals == nil || r.c.env.AgentState == nil {
		return false
	}
	for _, e := range entries {
		if e[1] != "refs/heads/"+branch {
			continue
		}
		for _, t := range r.c.env.Terminals(r.ctx, e[0]) {
			state := r.c.env.AgentState(t.BlockId)
			if state == molten.AgentStateWorking || state == molten.AgentStateWaiting {
				return true
			}
		}
	}
	return false
}

// updateOtherPrs asks GitHub to rebase every other open PR on the same base (gh pr update-branch --rebase), server
// side: no local rebase or force push. A PR whose agent is busy is left for later; a conflict needs an agent.
func (r *cleanupRun) updateOtherPrs() CleanupStepResult {
	out, err := r.gh("pr", "list", "--state", "open", "--base", r.pr.BaseRefName, "--limit", cleanupOtherPrsLimit,
		"--json", "number,headRefName,mergeStateStatus")
	if err != nil {
		return failed(CleanupStepOtherPrs, err)
	}
	var prs []openPrFacts
	if err := json.Unmarshal(out, &prs); err != nil {
		return failed(CleanupStepOtherPrs, errors.New("gh pr list: unreadable answer"))
	}
	entries, _ := r.worktreeEntries()
	step := CleanupStepResult{Id: CleanupStepOtherPrs, Prs: []CleanupPr{}}
	updated, flagged, failures := 0, 0, 0
	for _, pr := range prs {
		if pr.Number == r.req.Number {
			continue
		}
		item := CleanupPr{Number: pr.Number, Branch: pr.HeadRefName}
		switch {
		case r.busyAgent(entries, pr.HeadRefName):
			item.State, item.Flag, item.Reason = CleanupStateSkipped, CleanupFlagAgentBusy, "update after the agent finishes"
			flagged++
		case pr.MergeState == cleanupMergeStateDirty:
			item.State, item.Flag, item.Reason = CleanupStateSkipped, CleanupFlagNeedsRebase, "needs a rebase: conflicts with "+r.pr.BaseRefName
			flagged++
		default:
			_, err := r.gh("pr", "update-branch", strconv.Itoa(pr.Number), "--rebase")
			switch {
			case err == nil:
				item.State = CleanupStateDone
				updated++
			case conflictRe.MatchString(err.Error()):
				item.State, item.Flag, item.Reason = CleanupStateSkipped, CleanupFlagNeedsRebase, "needs a rebase: conflicts with "+r.pr.BaseRefName
				item.Message = err.Error()
				flagged++
			default:
				item.State, item.Message = CleanupStateFailed, err.Error()
				failures++
			}
		}
		step.Prs = append(step.Prs, item)
	}
	switch {
	case len(step.Prs) == 0:
		step.State, step.Reason = CleanupStateSkipped, "no other open PR on "+r.pr.BaseRefName
	case failures > 0:
		step.State = CleanupStateFailed
		step.Message = fmt.Sprintf("%d updated, %d flagged, %d failed", updated, flagged, failures)
	default:
		step.State = CleanupStateDone
		step.Message = fmt.Sprintf("%d updated, %d flagged", updated, flagged)
	}
	return step
}
