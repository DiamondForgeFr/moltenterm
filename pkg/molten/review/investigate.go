// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/reviewsession"
)

// Investigate (#797): the Reviews list's action on a PR whose check failed. It goes the way Ask for a rebase goes
// (rebase.go): the agent on the PR's branch gets the prompt, else the window offers to start one and the developer
// chooses how (#758). The brief names the failed checks, their runs and how to read their logs. Investigate and fix
// (#896): the agent finds the cause and resolves it (a fix pushed on the branch, a rebase on the base pushed with lease,
// or a rerun of a flaky job with its ticket, found or opened), never merges, and asks only for a real decision; its
// state stays MoltenTerm's until the PR's checks pass (investigate_follow.go). Nothing starts without the developer's
// click. Analyze and resolve (#1020, FR-REV-028 AC6): the same path for every blocker of the PR, listed in the brief in
// the order the agent resolves them: the rebase first, then the remote checks, the local CI, the test report and the
// review round.

const (
	InvestigateCommand = "moltenreviewinvestigate"

	investigateDirName = "investigate"
	// The checks a brief names; a PR with more names the first ones and says how many are left.
	maxInvestigateChecks = 8
	// The names a prompt line carries per blocker: it must fit the guarded typing path.
	maxPromptNames = 3

	// What the Reviews row read of the PR's merge with its base (pkg/molten/mission/reviews.go).
	InvestigateMergeBehind    = "behind"
	InvestigateMergeConflicts = "conflicts"
)

type InvestigateCheck struct {
	Name     string `json:"name"`
	Workflow string `json:"workflow,omitempty"`
	Url      string `json:"url,omitempty"`
	RunId    int64  `json:"runid,omitempty"`
	JobId    int64  `json:"jobid,omitempty"`
	// Local: a status the local CI posts (molten ci run's local-<job>, or a check named after the local CI).
	Local bool `json:"local,omitempty"`
}

type InvestigateRequest struct {
	PrKey
	Dir     string `json:"dir"`
	HeadRef string `json:"headref"`
	BaseRef string `json:"baseref"`
	HeadOid string `json:"headoid,omitempty"`
	Title   string `json:"title,omitempty"`
	Url     string `json:"url,omitempty"`
	Ticket  int    `json:"ticket,omitempty"`
	// Checks: the failed checks of the PR's head, remote and local.
	Checks []InvestigateCheck `json:"checks,omitempty"`
	// The other blockers the row read (#1020): Merge behind or conflicts with the base, changes requested by a
	// reviewer, no test report. LocalSeen: the head carries a local CI status, failed or not.
	Merge            string `json:"merge,omitempty"`
	ChangesRequested bool   `json:"changesrequested,omitempty"`
	NoReport         bool   `json:"noreport,omitempty"`
	LocalSeen        bool   `json:"localseen,omitempty"`
	// Start: the developer chose how a new agent works (Mode, #758); its tab goes in WorkspaceId, named TabName.
	Start       bool   `json:"start,omitempty"`
	Mode        string `json:"mode,omitempty"`
	WorkspaceId string `json:"workspaceid,omitempty"`
	TabName     string `json:"tabname,omitempty"`
	// Agent: the coding agent picked for this run (#845).
	Agent string `json:"agent,omitempty"`
}

// blockers: what stops the PR, as the brief lists it; the review round and a missing local CI are wavesrv's own reads.
type blockers struct {
	rebase           string
	remote           []InvestigateCheck
	local            []InvestigateCheck
	localMissing     bool
	noReport         bool
	changesRequested bool
	round            *Round
	roundNumber      int
}

func (b blockers) empty() bool {
	return b.rebase == "" && len(b.remote) == 0 && len(b.local) == 0 && !b.localMissing && !b.noReport &&
		!b.changesRequested && b.round == nil
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
	switch req.Merge {
	case "", InvestigateMergeBehind, InvestigateMergeConflicts:
	default:
		return fmt.Errorf("merge must be %s or %s", InvestigateMergeBehind, InvestigateMergeConflicts)
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

// IsLocalCiCheck: a check the local CI reports, by molten ci run's status name or a name that says so ("AI testing /
// local CI").
func IsLocalCiCheck(name string) bool {
	lower := strings.ToLower(name)
	return strings.HasPrefix(lower, "local-") || strings.Contains(lower, "local ci") || strings.Contains(lower, "local-ci")
}

// publishesLocalStatuses: the project declares a local CI that posts its verdicts as commit statuses
// (.molten/project.json ci.statuses "github"); a head without one has not been through it.
func publishesLocalStatuses(dir string) bool {
	data, err := os.ReadFile(filepath.Join(dir, molten.ProjectPipelineFile))
	if err != nil {
		return false
	}
	var p struct {
		Ci *struct {
			Jobs     []json.RawMessage `json:"jobs"`
			Statuses string            `json:"statuses"`
		} `json:"ci"`
	}
	if json.Unmarshal(data, &p) != nil || p.Ci == nil {
		return false
	}
	return len(p.Ci.Jobs) > 0 && p.Ci.Statuses == molten.PipelineCiStatusesGithub
}

// readBlockers sorts the row's blockers and adds wavesrv's: a published review round not handed over yet, and a local
// CI whose statuses are missing on the head.
func (r *Restarter) readBlockers(req InvestigateRequest) blockers {
	b := blockers{rebase: req.Merge, noReport: req.NoReport, changesRequested: req.ChangesRequested}
	for _, c := range req.Checks {
		if c.Local || IsLocalCiCheck(c.Name) {
			c.Local = true
			b.local = append(b.local, c)
			continue
		}
		b.remote = append(b.remote, c)
	}
	b.localMissing = len(b.local) == 0 && !req.LocalSeen && publishesLocalStatuses(req.Dir)
	if r.store != nil {
		if state, err := r.store.Get(req.PrKey); err == nil {
			if round, number := lastPublishedRound(state.Rounds); round != nil && round.RestartedAt == 0 {
				b.round, b.roundNumber = round, number
			}
		}
	}
	return b
}

// AskInvestigate hands the PR's blockers to the agent on its branch, or, with Start, to a new one (the developer's
// click, a window's only).
func (r *Restarter) AskInvestigate(ctx context.Context, req InvestigateRequest) (RestartResult, error) {
	if err := req.check(); err != nil {
		return RestartResult{}, err
	}
	for i := range req.Checks {
		req.Checks[i] = cleanCheck(req.Checks[i])
	}
	b := r.readBlockers(req)
	if b.empty() {
		return RestartResult{}, fmt.Errorf("nothing blocks PR #%d: no failed check, conflict, missing report or review round", req.Number)
	}
	rreq := req.restartRequest()
	origin := r.origin(rreq, AgentOriginInvestigate)
	var state State
	if b.round != nil {
		state, _ = r.store.Get(req.PrKey)
	}
	result := r.askOnBranch(ctx, rreq, origin, func(tree string, result *RestartResult) (string, bool) {
		roundBrief := ""
		if b.round != nil {
			// The round's own brief (Restart work's), so its comments reach the agent word for word.
			path, err := r.writeBrief(state, *b.round, b.roundNumber, rreq, tree, restartTicket(rreq))
			if err != nil {
				result.Status, result.Reason, result.Message = RestartFailed, RestartReasonBrief, fmt.Sprintf("the brief could not be written: %v", err)
				return "", false
			}
			roundBrief = path
			result.Round = b.round.Id
		}
		path, err := r.writeInvestigateBrief(req, b, tree, roundBrief)
		if err != nil {
			result.Status, result.Reason, result.Message = RestartFailed, RestartReasonBrief, fmt.Sprintf("the brief could not be written: %v", err)
			return "", false
		}
		result.BriefPath = path
		return investigatePromptLine(req, b, path), true
	})
	if result.Status == RestartSent && result.BlockId != "" {
		// An agent already on the branch took the work: its state is MoltenTerm's until the PR is green, as a new one's.
		startHead, _ := r.git(ctx, result.Worktree, "rev-parse", "HEAD")
		r.followAgent(agentFollow{req: rreq, origin: origin, tree: result.Worktree, blockId: result.BlockId,
			startHead: startHead, agent: result.Agent}, result.BriefPath)
	}
	if b.round != nil && (result.Status == RestartSent || result.Status == RestartTyped || result.Status == RestartStarted) {
		return r.markRestarted(rreq, b.round.Id, result.Worktree, result)
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

func investigateNames(checks []InvestigateCheck, limit int) string {
	names := make([]string, 0, len(checks))
	for i, c := range checks {
		if i == limit {
			names = append(names, "…")
			break
		}
		names = append(names, c.Name)
	}
	return strings.Join(names, ", ")
}

// promptBlockers: the blockers in the brief's order, in the prompt's few words.
func promptBlockers(req InvestigateRequest, b blockers) []string {
	var parts []string
	switch b.rebase {
	case InvestigateMergeConflicts:
		parts = append(parts, "conflicts with "+req.BaseRef+": rebase on origin/"+req.BaseRef)
	case InvestigateMergeBehind:
		parts = append(parts, "behind "+req.BaseRef+": rebase on origin/"+req.BaseRef)
	}
	if len(b.remote) > 0 {
		parts = append(parts, "CI failed: "+investigateNames(b.remote, maxPromptNames))
	}
	if len(b.local) > 0 {
		parts = append(parts, "local CI failed: "+investigateNames(b.local, maxPromptNames)+" (molten ci run)")
	} else if b.localMissing {
		parts = append(parts, "local CI not run on the head (molten ci run)")
	}
	if b.noReport {
		parts = append(parts, "no test report")
	}
	if b.round != nil {
		parts = append(parts, fmt.Sprintf("review round %d to answer", b.roundNumber))
	} else if b.changesRequested {
		parts = append(parts, "changes requested")
	}
	for i := range parts {
		parts[i] = strconv.Itoa(i+1) + ". " + parts[i]
	}
	return parts
}

// investigatePromptLine holds the rules that must hold even if the brief is not read; it fits the guarded typing path.
func investigatePromptLine(req InvestigateRequest, b blockers, briefPath string) string {
	return fmt.Sprintf("MoltenTerm: PR #%d (%s) is blocked, resolve in this order: %s. Fix on %s and push; rebase with "+
		"push --force-with-lease, never over commits by others; rerun a flaky job and ticket it. Never merge. Ask me "+
		"only for a real decision. Brief: %s", req.Number, req.HeadRef, strings.Join(promptBlockers(req, b), "; "),
		req.HeadRef, briefPath)
}

func writeChecks(sb *strings.Builder, req InvestigateRequest, checks []InvestigateCheck) {
	for i, c := range checks {
		if i == maxInvestigateChecks {
			fmt.Fprintf(sb, "- and %d more: `gh pr checks %d -R %s` lists them\n", len(checks)-i, req.Number, req.Repo)
			break
		}
		fmt.Fprintf(sb, "- %s", c.Name)
		if c.Workflow != "" {
			fmt.Fprintf(sb, " (workflow %s)", c.Workflow)
		}
		if c.Url != "" {
			fmt.Fprintf(sb, ": %s", c.Url)
		}
		switch {
		case c.JobId > 0:
			fmt.Fprintf(sb, "\n  - log: `gh run view --job %d --log-failed -R %s`", c.JobId, req.Repo)
		case c.RunId > 0:
			fmt.Fprintf(sb, "\n  - log: `gh run view %d --log-failed -R %s`", c.RunId, req.Repo)
		}
		if c.RunId > 0 {
			fmt.Fprintf(sb, "\n  - rerun: `gh run rerun %d --failed -R %s`", c.RunId, req.Repo)
		}
		sb.WriteString("\n")
	}
}

func renderInvestigateBrief(req InvestigateRequest, b blockers, tree string, ticket int, commit string, outcomePath string, roundBrief string) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "# Analyze and resolve what blocks PR #%d\n\n", req.Number)
	sb.WriteString("MoltenTerm wrote this brief when the developer clicked Analyze and resolve in the Integration panel (the PR panel): the pull " +
		"request cannot be merged yet. The developer asks you to find the cause of each blocker below and resolve it, not " +
		"only to diagnose it, in the order listed. You work under the developer's usual permissions.\n\n")
	fmt.Fprintf(&sb, "- Pull request: #%d", req.Number)
	if req.Title != "" {
		fmt.Fprintf(&sb, " %s", req.Title)
	}
	if req.Url != "" {
		fmt.Fprintf(&sb, " (%s)", req.Url)
	}
	fmt.Fprintf(&sb, "\n- Repository: %s\n- Branch: %s into %s\n", req.Repo, req.HeadRef, req.BaseRef)
	if req.HeadOid != "" {
		fmt.Fprintf(&sb, "- Head when asked: %s\n", req.HeadOid)
	}
	if ticket > 0 {
		fmt.Fprintf(&sb, "- Ticket: #%d (it stays in its current status)\n", ticket)
	}
	fmt.Fprintf(&sb, "- Worktree: %s\n\n## What blocks the PR, in order\n\n", tree)
	for _, part := range promptBlockers(req, b) {
		sb.WriteString(part + "\n")
	}
	sb.WriteString("\n## First\n\n")
	fmt.Fprintf(&sb, "Work only in %s, on %s: `git fetch origin`, then `git pull --ff-only`. If the worktree has changes you did not make, stop and ask the developer.\n", tree, req.HeadRef)
	step := 0
	section := func(title string) {
		step++
		fmt.Fprintf(&sb, "\n## %d. %s\n\n", step, title)
	}
	if b.rebase != "" {
		what := "is behind"
		if b.rebase == InvestigateMergeConflicts {
			what = "conflicts with"
		}
		section("Rebase on " + req.BaseRef)
		fmt.Fprintf(&sb, "The branch %s %s. `git rebase origin/%s` (never merge %s into the branch: no `git merge`, no `git pull` without `--rebase`). Resolve each conflict keeping the intent of both sides; when the right resolution is unclear, `git rebase --abort` and ask the developer. Run the project's checks on the rebased branch, then `git push --force-with-lease` (never a plain `--force`).\n",
			what, req.BaseRef, req.BaseRef, req.BaseRef)
		fmt.Fprintf(&sb, "Before pushing, look at `git log --format='%%h %%an %%s' origin/%s ^HEAD`: when origin/%s holds commits whose author is neither the developer nor you, the push would rewrite someone else's work: do not push, stop and ask the developer.\n",
			req.HeadRef, req.HeadRef)
	}
	if len(b.remote) > 0 {
		section("Failed remote checks")
		writeChecks(&sb, req, b.remote)
		sb.WriteString("\nRead each failed job's log (the commands above) and find the failing step: the `--- FAIL` lines for Go, the failing test for vitest, the first error otherwise. ")
		fmt.Fprintf(&sb, "Does it touch what the PR changes (`git diff origin/%s...HEAD`)? Is the branch missing a workflow, a script or a fix that exists on %s only? Run the failing test in the worktree, several times when it may be flaky, and look at the same check on %s (`gh run list --branch %s -R %s`).\n",
			req.BaseRef, req.BaseRef, req.BaseRef, req.BaseRef, req.Repo)
		fmt.Fprintf(&sb, "- The PR caused it: fix it in the worktree, run the project's checks that cover it, commit in the project's format `%s`", commit)
		if ticket > 0 {
			fmt.Fprintf(&sb, " with the ticket #%d", ticket)
		}
		sb.WriteString(", then `git push` (never force).\n")
		fmt.Fprintf(&sb, "- A flaky or unrelated test: rerun the failed jobs once (the rerun commands above). If the same unrelated failure comes back, look for an open ticket on that test first (`gh issue list -R %s --state open --search \"<test name> in:title\"`) and open one only when none exists, following the project's workflow, with the test, the failing runs and the log lines. Link it in a PR comment (`gh pr comment %d -R %s --body '…'`), then rerun the failed jobs again.\n",
			req.Repo, req.Number, req.Repo)
	}
	if len(b.local) > 0 || b.localMissing {
		section("Local CI")
		if len(b.local) > 0 {
			sb.WriteString("These statuses of the local CI fail on the head:\n")
			writeChecks(&sb, req, b.local)
		} else {
			sb.WriteString("The project's local CI posts its verdicts as commit statuses, and the head has none yet.\n")
		}
		fmt.Fprintf(&sb, "\nThese statuses have no GitHub log and no GitHub rerun: rerunning a GitHub job does not change them. Run the local CI through MoltenTerm in the worktree: `molten ci run %s` (it waits for the verdict, exit 0 when green, and prints the failed job's log), `molten ci status` reads a verdict. Fix what fails, commit, push, then run it again on the pushed head until it is green: only a run on that head posts its statuses there, and MoltenTerm waits for them before it says green. ", req.HeadRef)
		sb.WriteString("A GitHub check named after the local CI (a gate job with a rerun command above) reads those statuses: once the local CI is green on the pushed head, rerun it. ")
		sb.WriteString("If `molten ci run` refuses because the project's commands are not trusted yet, do not run them yourself: MoltenTerm shows the developer a notification to review and trust them, and tells you when to run it again. Until then write the outcome line below with `needs you: the local CI commands need your approval`.\n")
		fmt.Fprintf(&sb, "\nTell a failure of the code from a broken local CI before you fix anything. Run the failing job on %s too (`molten ci run %s --only <job>`, or `molten ci status origin/%s`): a job that fails there as well, or fails before any test runs, points at the CI, not at the PR. Then, by cause:\n", req.BaseRef, req.BaseRef, req.BaseRef)
		sb.WriteString("- The code: fix it as for a remote check, push, run the local CI again on the pushed head.\n")
		fmt.Fprintf(&sb, "- The project's pipeline declaration (`%s`): invalid, a wrong command, folder or environment variable, a job that cannot pass on any branch. Fix the declaration on this branch, commit, push. A changed declaration needs the developer's trust again before it runs: write `needs you: local CI declaration: <what you changed and why>` and stop.\n", molten.ProjectPipelineFile)
		sb.WriteString("- The environment: a missing tool or dependency, a port in use, a stale cache, a process left running. Fix what the worktree can fix (install the project's dependencies, clear its own cache) and run again; otherwise write `needs you: environment: <exactly what the developer must do>` and stop.\n")
		sb.WriteString("- MoltenTerm itself: `molten ci run` crashes, hangs or times out, a run stays stuck, the status posted does not match the run's verdict, or the statuses are not posted on the pushed head after a green run. Do not loop and do not work around it: collect the command, its output and the run's log path, write `needs you: MoltenTerm bug: <command>, <what happened>, <log path>` and stop, so the developer can report it.\n")
	}
	if b.noReport {
		section("Test report")
		sb.WriteString("No test report was found on the PR or its ticket. Do the project's AI Testing step: run the ticket's acceptance criteria, then post the report on the PR as its workflow says (a comment starting with `## Test report`).\n")
	}
	if b.round != nil {
		section(fmt.Sprintf("Review round %d", b.roundNumber))
		fmt.Fprintf(&sb, "The developer published review round %d and nobody answered it yet. Follow its own brief: %s (apply the change requests, answer the questions, reply on each GitHub thread).\n", b.roundNumber, roundBrief)
	} else if b.changesRequested {
		section("Changes requested")
		fmt.Fprintf(&sb, "A reviewer requested changes: read the review threads (`gh pr view %d -R %s --comments`), do what they ask, and answer each thread you handled.\n", req.Number, req.Repo)
	}
	sb.WriteString("\n## Then\n\n")
	fmt.Fprintf(&sb, "- After each push or rerun, watch the checks until they end: `gh pr checks %d -R %s --watch`. At most two fix attempts and two reruns per blocker: if a check still fails, stop.\n", req.Number, req.Repo)
	sb.WriteString("- Never merge or approve the PR, never change the ticket's status, never check out the branch in another folder and never touch another checkout. Stop to ask the developer only for a real decision: a fix that changes the product's behaviour, or a risk to accept.\n")
	fmt.Fprintf(&sb, "- Last, write one line in the developer's language to %s: what you did (\"rebased on %s\", \"fixed <what>\", \"reran <job> (flaky, ticket #<n>)\", \"local CI green\"). When you stop for a decision or give up, start the line with `needs you:` and say why. Then end your turn: MoltenTerm watches the PR's checks on the pushed head and tells the developer when none fails, or why it needs them.\n",
		outcomePath, req.BaseRef)
	return sb.String()
}

// writeInvestigateBrief writes the brief in MoltenTerm's data folder, never in the project:
// <data>/molten/reviews/<repo-key>/investigate/<N>-<head>.md.
func (r *Restarter) writeInvestigateBrief(req InvestigateRequest, b blockers, tree string, roundBrief string) (string, error) {
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
	text := renderInvestigateBrief(req, b, tree, ticket, r.commitFormat(req.Dir, ticket), outcome, roundBrief)
	if err := os.WriteFile(path, []byte(text), 0600); err != nil {
		return "", err
	}
	return path, nil
}
