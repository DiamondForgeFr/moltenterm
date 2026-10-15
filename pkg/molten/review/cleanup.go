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

	// What a step did or why it was skipped (#672: the sheet writes the sentences from these codes and the data).
	CleanupCodeMerged         = "merged"
	CleanupCodeNotMerged      = "notmerged"
	CleanupCodePrUnconfirmed  = "prunconfirmed"
	CleanupCodeNoTicket       = "noticket"
	CleanupCodeClosed         = "closed"
	CleanupCodeAlreadyClosed  = "alreadyclosed"
	CleanupCodeNoSfWorkflow   = "nosfworkflow"
	CleanupCodeMovedDone      = "moveddone"
	CleanupCodeAlreadyDone    = "alreadydone"
	CleanupCodeNoReviewTree   = "noreviewtree"
	CleanupCodeNotAWorktree   = "notaworktree"
	CleanupCodeNoAgentTree    = "noagenttree"
	CleanupCodeRefusedHome    = "refusedhome"
	CleanupCodeRefusedRepo    = "refusedrepo"
	CleanupCodeLocked         = "locked"
	CleanupCodeKept           = "kept"
	CleanupCodeAlreadyGone    = "alreadygone"
	CleanupCodeRemoved        = "removed"
	CleanupCodeWillRemove     = "willremove"
	CleanupCodeNoLocalBranch  = "nolocalbranch"
	CleanupCodeTreeFailed     = "treefailed"
	CleanupCodeInKeptTree     = "inkepttree"
	CleanupCodeInMainCheckout = "inmaincheckout"
	CleanupCodeMoved          = "moved"
	CleanupCodeDeleted        = "deleted"
	CleanupCodeDeletedByMerge = "deletedbymerge"
	CleanupCodePushedAfter    = "pushedafter"
	CleanupCodeNoOtherPr      = "noother"
	CleanupCodeOtherPrs       = "otherprs"

	CleanupWorkflowCliPath = ".claude/skills/sf-workflow/workflow-cli.sh"

	cleanupTimeout           = 5 * time.Minute
	cleanupFetchRetry        = 2 * time.Second
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
	// WorktreeConfirmed: the developer chose to lose what the kept agent worktree holds (the step's Confirm). The
	// worktree goes, and its branch too while its tip is still the one confirmed.
	WorktreeConfirmed *mission.WorktreeRisk `json:"worktreeconfirmed,omitempty"`
}

// CleanupPr is what the cleanup did to another open PR on the same base.
type CleanupPr struct {
	Number int    `json:"number"`
	Branch string `json:"branch"`
	Url    string `json:"url,omitempty"`
	State  string `json:"state"`
	// Flag: why it was left (CleanupFlagAgentBusy: update after the agent finishes; CleanupFlagNeedsRebase: Restart
	// work offers it); Error: gh's error.
	Flag  string `json:"flag,omitempty"`
	Error string `json:"error,omitempty"`
}

type CleanupStepResult struct {
	Id    string `json:"id"`
	State string `json:"state"`
	// Code: what the step did or why it was skipped (CleanupCode…), written by the sheet from the data below; Error:
	// the raw error of a failed step (or of the fetch after the merge check).
	Code   string `json:"code,omitempty"`
	Error  string `json:"error,omitempty"`
	Ticket int    `json:"ticket,omitempty"`
	Branch string `json:"branch,omitempty"`
	Base   string `json:"base,omitempty"`
	Path   string `json:"path,omitempty"`
	// Loss: what removing the worktree or the branch loses (kept), or the ignored files that went with it (removed).
	Loss *WorktreeLoss `json:"loss,omitempty"`
	// Confirm: the kept agent worktree's risk, sent back as WorktreeConfirmed to remove it and lose its work.
	Confirm *mission.WorktreeRisk `json:"confirm,omitempty"`
	// The other PRs: what was done to each, and the counts.
	Prs     []CleanupPr `json:"prs,omitempty"`
	Updated int         `json:"updated,omitempty"`
	Flagged int         `json:"flagged,omitempty"`
	Failed  int         `json:"failed,omitempty"`
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
	Url         string `json:"url"`
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
	// confirmedTip: the agent worktree went on the developer's choice to lose its work; its branch goes too while its
	// tip is still this one.
	confirmedTip   string
	mergedHeadRead bool
	mergedHeadOid  string
	result         CleanupResult
}

func (r *cleanupRun) gh(args ...string) ([]byte, error) {
	return r.c.env.Run(r.ctx, r.dir, "gh", append(args, "--repo", r.req.Repo)...)
}

func (r *cleanupRun) git(dir string, args ...string) (string, error) {
	out, err := r.c.env.Run(r.ctx, dir, "git", append([]string{"-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"}, args...)...)
	return strings.TrimSpace(string(out)), err
}

func (r *cleanupRun) wanted(id string) bool {
	return len(r.req.Steps) == 0 || slices.Contains(r.req.Steps, id)
}

func (r *cleanupRun) add(step CleanupStepResult) *CleanupStepResult {
	r.result.Steps = append(r.result.Steps, step)
	return &r.result.Steps[len(r.result.Steps)-1]
}

func done(id string, code string) CleanupStepResult {
	return CleanupStepResult{Id: id, State: CleanupStateDone, Code: code}
}

func skipped(id string, code string) CleanupStepResult {
	return CleanupStepResult{Id: id, State: CleanupStateSkipped, Code: code}
}

func failed(id string, err error) CleanupStepResult {
	return CleanupStepResult{Id: id, State: CleanupStateFailed, Error: err.Error()}
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
	if step, ok := r.readPr(); !ok {
		r.add(step)
		for _, id := range CleanupSteps[1:] {
			if r.wanted(id) {
				r.add(skipped(id, CleanupCodePrUnconfirmed))
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
// the base as GitHub has it now, and a pruned remote branch shows the merge deleted it. ok false: the PR step failed.
func (r *cleanupRun) readPr() (CleanupStepResult, bool) {
	out, err := r.gh("pr", "view", strconv.Itoa(r.req.Number), "--json", "state,headRefName,headRefOid,baseRefName,closingIssuesReferences")
	if err != nil {
		return failed(CleanupStepPr, err), false
	}
	if err := json.Unmarshal(out, &r.pr); err != nil {
		return failed(CleanupStepPr, errors.New("gh pr view: unreadable answer")), false
	}
	if r.pr.State != cleanupPrStateMerged {
		step := CleanupStepResult{Id: CleanupStepPr, State: CleanupStateFailed, Code: CleanupCodeNotMerged, Error: strings.ToLower(r.pr.State)}
		return step, false
	}
	if !reviewsession.ValidRef(r.pr.HeadRefName) || !reviewsession.ValidRef(r.pr.BaseRefName) {
		return failed(CleanupStepPr, fmt.Errorf("PR #%d: unusual branch names", r.req.Number)), false
	}
	r.ticket = r.req.Ticket
	if r.ticket <= 0 && len(r.pr.Closing) > 0 {
		r.ticket = r.pr.Closing[0].Number
	}
	if r.ticket <= 0 {
		r.ticket = mission.TicketOfBranch(r.dir, r.pr.HeadRefName)
	}
	step := done(CleanupStepPr, CleanupCodeMerged)
	step.Base = r.pr.BaseRefName
	if err := r.fetch(); err != nil {
		step.Error = err.Error()
	}
	if r.wanted(CleanupStepPr) {
		r.add(step)
	}
	return step, true
}

// fetch tries twice: right after Validate's merge, the Review tab's refresh fetches the same repository, and git
// refuses a fetch whose refs another one is updating ("cannot lock ref").
func (r *cleanupRun) fetch() error {
	_, err := r.git(r.dir, "fetch", "--quiet", "--prune", "origin")
	if err == nil || !sleepCtx(r.ctx, cleanupFetchRetry) {
		return err
	}
	_, err = r.git(r.dir, "fetch", "--quiet", "--prune", "origin")
	return err
}

func (r *cleanupRun) closeTicket() CleanupStepResult {
	if r.ticket <= 0 {
		return skipped(CleanupStepTicketClose, CleanupCodeNoTicket)
	}
	out, err := r.gh("issue", "view", strconv.Itoa(r.ticket), "--json", "state")
	if err != nil {
		return withTicket(failed(CleanupStepTicketClose, err), r.ticket)
	}
	var issue struct {
		State string `json:"state"`
	}
	if json.Unmarshal(out, &issue) == nil && issue.State == cleanupIssueStateClosed {
		return withTicket(skipped(CleanupStepTicketClose, CleanupCodeAlreadyClosed), r.ticket)
	}
	if _, err := r.gh("issue", "close", strconv.Itoa(r.ticket)); err != nil {
		return withTicket(failed(CleanupStepTicketClose, err), r.ticket)
	}
	return withTicket(done(CleanupStepTicketClose, CleanupCodeClosed), r.ticket)
}

func withTicket(step CleanupStepResult, ticket int) CleanupStepResult {
	step.Ticket = ticket
	return step
}

func withBranch(step CleanupStepResult, branch string, base string) CleanupStepResult {
	step.Branch, step.Base = branch, base
	return step
}

func withPath(step CleanupStepResult, path string) CleanupStepResult {
	step.Path = path
	return step
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
		return skipped(CleanupStepTicketDone, CleanupCodeNoTicket)
	}
	if !UsesSfWorkflow(r.dir) {
		return withTicket(skipped(CleanupStepTicketDone, CleanupCodeNoSfWorkflow), r.ticket)
	}
	cli := filepath.Join(r.dir, CleanupWorkflowCliPath)
	ticket := strconv.Itoa(r.ticket)
	if out, err := r.c.env.Run(r.ctx, r.dir, "bash", cli, "status", ticket); err == nil && strings.Contains(string(out), cleanupWorkflowDoneMatch) {
		return withTicket(skipped(CleanupStepTicketDone, CleanupCodeAlreadyDone), r.ticket)
	}
	if _, err := r.c.env.Run(r.ctx, r.dir, "bash", cli, "update-status", ticket, "Done"); err != nil {
		return withTicket(failed(CleanupStepTicketDone, err), r.ticket)
	}
	return withTicket(done(CleanupStepTicketDone, CleanupCodeMovedDone), r.ticket)
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

// statusChanges reads the uncommitted changes of a folder: changes to tracked files and untracked files that are not
// ignored, as git status names them.
func (r *cleanupRun) statusChanges(dir string) ([]string, int, error) {
	status, err := r.git(dir, "status", "--porcelain", "--untracked-files=normal")
	if err != nil {
		return nil, 0, err
	}
	var paths []string
	for _, line := range strings.Split(status, "\n") {
		if len(line) > 3 {
			paths = append(paths, line[3:])
		}
	}
	return firstOf(paths), len(paths), nil
}

// removeReviewTree ends the review session and removes MoltenTerm's detached checkout of the PR. It only ever holds the
// PR's commits, now merged; uncommitted changes in it keep it all the same, and the step names them.
func (r *cleanupRun) removeReviewTree() CleanupStepResult {
	if r.c.env.EndSession != nil {
		if err := r.c.env.EndSession(r.ctx, r.req.Repo, r.req.Number); err != nil {
			return failed(CleanupStepReviewTree, err)
		}
	}
	tree := reviewsession.ReviewTreeDir(r.c.env.DataDir, r.dir, r.req.Number)
	if _, err := os.Stat(tree); errors.Is(err, os.ErrNotExist) {
		return skipped(CleanupStepReviewTree, CleanupCodeNoReviewTree)
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
		return withPath(skipped(CleanupStepReviewTree, CleanupCodeNotAWorktree), tree)
	}
	changes, count, err := r.statusChanges(tree)
	if err != nil {
		return failed(CleanupStepReviewTree, err)
	}
	if count > 0 {
		step := withPath(skipped(CleanupStepReviewTree, CleanupCodeKept), tree)
		step.Loss = &WorktreeLoss{Changes: changes, ChangeCount: count, Commits: []LossCommit{}, Ignored: []string{}}
		return step
	}
	if _, err := r.git(r.dir, "worktree", "remove", "--force", "--", tree); err != nil {
		return failed(CleanupStepReviewTree, err)
	}
	return withPath(done(CleanupStepReviewTree, CleanupCodeRemoved), tree)
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

func refusalCode(refused string) string {
	if strings.Contains(refused, "home") {
		return CleanupCodeRefusedHome
	}
	return CleanupCodeRefusedRepo
}

// agentLoss is what removing the agent worktree and its branch would lose.
func (r *cleanupRun) agentLoss(plan mission.WorktreePlan) WorktreeLoss {
	commits, count := r.commitsAtRisk("refs/heads/" + r.pr.HeadRefName)
	return worktreeLossOf(plan, commits, count)
}

// removeAgentTree removes the agent worktree after the merge unless it holds real work (loss.go): uncommitted changes,
// untracked files that are not ignored, or commits that are not in the merged PR. Then it is kept, with the loss named,
// until the developer chooses to lose it (WorktreeConfirmed); a worktree that changed since is kept again. Removal goes
// through Mission Control's worktree removal, which reads the worktree again first.
func (r *cleanupRun) removeAgentTree() CleanupStepResult {
	if r.agentTree == "" {
		return withBranch(skipped(CleanupStepAgentTree, CleanupCodeNoAgentTree), r.pr.HeadRefName, "")
	}
	tree := r.agentTree
	plan, err := r.c.worktrees.Plan(mission.WorktreeRequest{Dir: tree})
	if err != nil {
		return withPath(failed(CleanupStepAgentTree, err), tree)
	}
	if plan.Refused != "" {
		return withPath(skipped(CleanupStepAgentTree, refusalCode(plan.Refused)), tree)
	}
	if plan.Locked {
		return withPath(skipped(CleanupStepAgentTree, CleanupCodeLocked), tree)
	}
	loss := r.agentLoss(plan)
	confirmed := r.req.WorktreeConfirmed
	if confirmed == nil {
		if !loss.Nothing() {
			step := withBranch(withPath(skipped(CleanupStepAgentTree, CleanupCodeKept), tree), r.pr.HeadRefName, r.pr.BaseRefName)
			step.Loss, step.Confirm = &loss, riskOf(plan)
			return step
		}
		// Nothing to lose: what the plan saw is confirmed here, and the removal reads the worktree again.
		confirmed = riskOf(plan)
	}
	res, err := r.c.worktrees.Remove(mission.WorktreeRemoveRequest{Dir: tree, Confirmed: confirmed})
	if err != nil {
		step := withBranch(withPath(failed(CleanupStepAgentTree, err), tree), r.pr.HeadRefName, r.pr.BaseRefName)
		if again, perr := r.c.worktrees.Plan(mission.WorktreeRequest{Dir: tree}); perr == nil && !again.Missing {
			againLoss := r.agentLoss(again)
			step.Loss, step.Confirm = &againLoss, riskOf(again)
		}
		return step
	}
	r.agentTree = ""
	if r.req.WorktreeConfirmed != nil {
		r.confirmedTip = r.req.WorktreeConfirmed.Sha
	}
	if res.Gone {
		return withPath(skipped(CleanupStepAgentTree, CleanupCodeAlreadyGone), tree)
	}
	step := withPath(done(CleanupStepAgentTree, CleanupCodeRemoved), res.Real)
	step.Loss = &loss
	return step
}

// deleteLocalBranch deletes the PR's local branch when it holds no commit outside the merged PR (loss.go), or when
// the developer chose to lose the kept worktree's work and the branch tip is still the one they saw.
func (r *cleanupRun) deleteLocalBranch(agentStep *CleanupStepResult) CleanupStepResult {
	branch := r.pr.HeadRefName
	base := r.pr.BaseRefName
	tip, err := r.git(r.dir, "rev-parse", "--verify", "--quiet", "refs/heads/"+branch)
	if err != nil || tip == "" {
		return withBranch(skipped(CleanupStepLocalBranch, CleanupCodeNoLocalBranch), branch, base)
	}
	if r.agentTree != "" {
		if agentStep != nil && agentStep.State == CleanupStateFailed {
			return withBranch(skipped(CleanupStepLocalBranch, CleanupCodeTreeFailed), branch, base)
		}
		return withBranch(skipped(CleanupStepLocalBranch, CleanupCodeInKeptTree), branch, base)
	}
	entries, err := r.worktreeEntries()
	if err != nil {
		return failed(CleanupStepLocalBranch, err)
	}
	if len(entries) > 0 && entries[0][1] == "refs/heads/"+branch {
		return withBranch(skipped(CleanupStepLocalBranch, CleanupCodeInMainCheckout), branch, base)
	}
	if r.confirmedTip == "" || tip != r.confirmedTip {
		if r.confirmedTip != "" {
			return withBranch(skipped(CleanupStepLocalBranch, CleanupCodeMoved), branch, base)
		}
		commits, count := r.commitsAtRisk("refs/heads/" + branch)
		if count != 0 {
			step := withBranch(skipped(CleanupStepLocalBranch, CleanupCodeKept), branch, base)
			step.Loss = &WorktreeLoss{Changes: []string{}, Commits: commits, CommitCount: count, Ignored: []string{}}
			return step
		}
	}
	// -D: a rebase- or squash-merged branch is not an ancestor of the base; its commits were checked instead.
	if _, err := r.git(r.dir, "branch", "-D", branch); err != nil {
		return failed(CleanupStepLocalBranch, err)
	}
	return withBranch(done(CleanupStepLocalBranch, CleanupCodeDeleted), branch, base)
}

// deleteRemoteBranch: the merge deletes it (gh pr merge --delete-branch, or the repository's automatic deletion); one
// still there is deleted only when it is still the head GitHub merged.
func (r *cleanupRun) deleteRemoteBranch() CleanupStepResult {
	branch := r.pr.HeadRefName
	tip, err := r.git(r.dir, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/"+branch)
	if err != nil || tip == "" {
		return withBranch(done(CleanupStepRemoteBranch, CleanupCodeDeletedByMerge), branch, "")
	}
	if !reviewsession.IsOid(r.pr.HeadRefOid) || tip != r.pr.HeadRefOid {
		return withBranch(skipped(CleanupStepRemoteBranch, CleanupCodePushedAfter), branch, "")
	}
	if _, err := r.git(r.dir, "push", "--quiet", "origin", "--delete", branch); err != nil {
		return failed(CleanupStepRemoteBranch, err)
	}
	return withBranch(done(CleanupStepRemoteBranch, CleanupCodeDeleted), branch, "")
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
	base := r.pr.BaseRefName
	out, err := r.gh("pr", "list", "--state", "open", "--base", base, "--limit", cleanupOtherPrsLimit,
		"--json", "number,headRefName,mergeStateStatus,url")
	if err != nil {
		return failed(CleanupStepOtherPrs, err)
	}
	var prs []openPrFacts
	if err := json.Unmarshal(out, &prs); err != nil {
		return failed(CleanupStepOtherPrs, errors.New("gh pr list: unreadable answer"))
	}
	entries, _ := r.worktreeEntries()
	step := CleanupStepResult{Id: CleanupStepOtherPrs, Base: base, Code: CleanupCodeOtherPrs, Prs: []CleanupPr{}}
	for _, pr := range prs {
		if pr.Number == r.req.Number {
			continue
		}
		item := CleanupPr{Number: pr.Number, Branch: pr.HeadRefName, Url: pr.Url}
		switch {
		case r.busyAgent(entries, pr.HeadRefName):
			item.State, item.Flag = CleanupStateSkipped, CleanupFlagAgentBusy
			step.Flagged++
		case pr.MergeState == cleanupMergeStateDirty:
			item.State, item.Flag = CleanupStateSkipped, CleanupFlagNeedsRebase
			step.Flagged++
		default:
			_, err := r.gh("pr", "update-branch", strconv.Itoa(pr.Number), "--rebase")
			switch {
			case err == nil:
				item.State = CleanupStateDone
				step.Updated++
			case conflictRe.MatchString(err.Error()):
				item.State, item.Flag, item.Error = CleanupStateSkipped, CleanupFlagNeedsRebase, err.Error()
				step.Flagged++
			default:
				item.State, item.Error = CleanupStateFailed, err.Error()
				step.Failed++
			}
		}
		step.Prs = append(step.Prs, item)
	}
	switch {
	case len(step.Prs) == 0:
		step.State, step.Code = CleanupStateSkipped, CleanupCodeNoOtherPr
	case step.Failed > 0:
		step.State = CleanupStateFailed
	default:
		step.State = CleanupStateDone
	}
	return step
}
