// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package review

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agenthandoff"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/molten/secfix"
)

// After a security fix merged (FR-REV-036 AC15, FR-REV-013): the pull requests the shared block held are brought back,
// one by one, and the developer is told once. A scan that reads the pull request's head fails again on a plain rerun, so
// a head that holds none of the fix is updated first:
//
//   - someone works on the branch: the rebase goes to that agent, queued after its task when it is busy, never pushed over
//     it; when who works there cannot be told, or cannot be reached, nothing is touched;
//   - nobody does and the head lacks the fix: the branch is updated onto the trunk through GitHub (a merge of the trunk,
//     or a rebase when the trunk needs a linear history), which only ever adds to the branch;
//   - the head holds the fix already: its failed checks run again;
//   - none of its checks fails (any more): it is left alone, as a pull request that merges cleanly is after any merge
//     (FR-REV-013 AC4).
//
// Nothing here starts an agent, merges or closes anything, and nothing depends on one coding agent: the hand-off is the
// handoffs' own request, the same for every CLI. The step runs once per fix, from whichever sees the merge first: the
// Validate sheet's cleanup (cleanup.go) or the follow of the fix (securityfix_follow.go).

const (
	// A project's block holds a few pull requests; a runaway list is cut here.
	securityUnblockMax       = 30
	securityUnblockTimeout   = 10 * time.Minute
	securityUnblockPrTimeout = 90 * time.Second
)

// securityRebase marks a rebase asked after a security fix merged. The branch is neither conflicting nor behind in the way
// an ordinary rebase asks about, so the hand-off is judged by whether the branch holds the fix, not by its head.
type securityRebase struct {
	fixPr int
	// fixOid is the commit of the fix on the trunk, "" when GitHub did not say.
	fixOid string
	ids    string
}

// ref is what the head is compared with: the fix's commit, else the trunk (a head behind the trunk lacks the fix too).
func (s *securityRebase) ref(base string) string {
	if isOid(s.fixOid) {
		return s.fixOid
	}
	return base
}

func (s *securityRebase) briefIntro(req RebaseRequest) string {
	var b strings.Builder
	fmt.Fprintf(&b, "MoltenTerm wrote this brief after the security fix PR #%d merged into %s", s.fixPr, req.BaseRef)
	if s.ids != "" {
		fmt.Fprintf(&b, " (advisories %s)", s.ids)
	}
	fmt.Fprintf(&b, ". The pull request's dependency scan fails on its head, which holds none of the fix: it cannot pass until its branch is rebased on %s. "+
		"You work under the developer's usual permissions.\n\n", req.BaseRef)
	return b.String()
}

func (s *securityRebase) promptLine(req RebaseRequest, briefPath string) string {
	return fmt.Sprintf("MoltenTerm: security fix PR #%d merged into %s; PR #%d (%s) needs it to pass the dependency scan. Rebase it on origin/%s "+
		"(never merge %s into the branch), re-run the project's checks, then push with git push --force-with-lease. Brief: %s",
		s.fixPr, req.BaseRef, req.Number, req.HeadRef, req.BaseRef, req.BaseRef, briefPath)
}

// request is the hand-off to an agent that is busy on the branch (or to the lead whose sub-agent is): typed when its prompt
// is idle, queued until then.
func (s *securityRebase) request(req RebaseRequest, leadName string, row ownerRow) (string, string, string) {
	goal := fmt.Sprintf("MoltenTerm: security fix PR #%d merged into %s, and PR #%d (%s) needs it to pass the dependency scan. When your current task is "+
		"done, rebase the branch on origin/%s (never merge %s into it), re-run the project's checks, then push with git push --force-with-lease. "+
		"Never merge the pull request.", s.fixPr, req.BaseRef, req.Number, req.HeadRef, req.BaseRef, req.BaseRef)
	var b strings.Builder
	fmt.Fprintf(&b, "MoltenTerm wrote this request itself when the security fix PR #%d merged into %s. It came without a click of the developer's: "+
		"it asks only for a rebase, and only once your current task is done.\n\n", s.fixPr, req.BaseRef)
	b.WriteString("## What happened\n\n")
	fmt.Fprintf(&b, "- Pull request: #%d (%s) into %s, repository %s\n", req.Number, req.HeadRef, req.BaseRef, req.Repo)
	if isOid(req.HeadOid) {
		fmt.Fprintf(&b, "- Head when asked: %s\n", req.HeadOid)
	}
	if s.ids != "" {
		fmt.Fprintf(&b, "- The fix covers the advisories %s\n", s.ids)
	}
	fmt.Fprintf(&b, "- The pull request's dependency scan reads its head, so it fails again until the branch holds the fix: a rerun alone cannot help.\n\n")
	b.WriteString("## What is asked\n\n")
	if row.agent.Kind == mission.UpcomingAgentPanel {
		b.WriteString("You work on this branch. Do not interrupt what you are doing: when it is done,\n")
	} else {
		fmt.Fprintf(&b, "%s works on this branch through a sub-agent or a background agent of %s. ", cleanLeadText(row.who(), maxLeadNameRunes), cleanLeadText(leadName, maxLeadNameRunes))
		if row.agent.Kind == mission.UpcomingAgentSubagent {
			b.WriteString(subagentStep(row.agent) + "\n")
		}
		b.WriteString("Let it finish its task first, then\n")
	}
	fmt.Fprintf(&b, "1. `git fetch origin`, then `git rebase origin/%s`. Never merge %s into the branch.\n", req.BaseRef, req.BaseRef)
	b.WriteString("2. Resolve any conflict keeping the intent of both sides, or `git rebase --abort` and ask the developer when the right resolution is unclear.\n")
	b.WriteString("3. Run the project's checks on the rebased branch.\n")
	b.WriteString("4. Push with `git push --force-with-lease` (never a plain `--force`).\n")
	b.WriteString("5. Do not change the ticket's status, do not approve or merge the pull request: the developer validates it in MoltenTerm.\n")
	closing := "When the rebase is pushed, say so to the developer in one line. If you cannot do it, say why."
	return goal, b.String(), closing
}

type ghUnblockPr struct {
	State             string          `json:"state"`
	IsDraft           bool            `json:"isDraft"`
	HeadRefName       string          `json:"headRefName"`
	HeadRefOid        string          `json:"headRefOid"`
	BaseRefName       string          `json:"baseRefName"`
	Title             string          `json:"title"`
	Url               string          `json:"url"`
	Mergeable         string          `json:"mergeable"`
	MergeStateStatus  string          `json:"mergeStateStatus"`
	StatusCheckRollup json.RawMessage `json:"statusCheckRollup"`
}

const unblockPrFields = "state,isDraft,headRefName,headRefOid,baseRefName,title,url,mergeable,mergeStateStatus,statusCheckRollup"

func (p ghUnblockPr) open() bool {
	return strings.EqualFold(p.State, "OPEN")
}

// failing are the runs of the pull request's failed GitHub checks (a failed check that is not a run has id 0), and whether
// any check fails at all. A local CI status is not what a merged fix unblocks.
func (p ghUnblockPr) failing() ([]int64, bool) {
	ci, err := mission.ParseReviewChecks(p.StatusCheckRollup)
	if err != nil {
		return nil, false
	}
	var runs []int64
	failed := false
	for _, check := range ci.Checks {
		if check.State != mission.ReviewCheckFailure || check.Local || IsLocalCiCheck(check.Name) {
			continue
		}
		failed = true
		if check.RunId > 0 && !slices.Contains(runs, check.RunId) {
			runs = append(runs, check.RunId)
		}
	}
	slices.Sort(runs)
	return runs, failed
}

func (p ghUnblockPr) conflicting() bool {
	return mission.ReviewConflictOf(p.Mergeable, p.MergeStateStatus) == mission.ReviewConflictConflicting
}

// unblockRun is one step after a merged fix: what it needs to know of the fix and the project, read once.
type unblockRun struct {
	r   *Restarter
	fix secfix.Fix
	// rebase carries the fix's commit; linear: the trunk needs a linear history, so its branches are updated by a rebase.
	rebase *securityRebase
	linear bool
}

func (r *Restarter) beginUnblock(ctx context.Context, fix secfix.Fix) *unblockRun {
	u := &unblockRun{r: r, fix: fix, rebase: &securityRebase{fixPr: fix.Pr, ids: idsLine(fix)}}
	if out, err := r.ghAt(ctx, fix.Dir, "pr", "view", strconv.Itoa(fix.Pr), "--json", "mergeCommit", "--repo", fix.Repo); err == nil {
		var merged struct {
			MergeCommit *struct {
				Oid string `json:"oid"`
			} `json:"mergeCommit"`
		}
		if json.Unmarshal(out, &merged) == nil && merged.MergeCommit != nil && isOid(merged.MergeCommit.Oid) {
			u.rebase.fixOid = merged.MergeCommit.Oid
		}
	}
	if out, err := r.ghAt(ctx, fix.Dir, "api", "repos/"+fix.Repo+"/rules/branches/"+url.PathEscape(fix.Trunk)); err == nil {
		if rules, err := parseBranchRules(out); err == nil {
			u.linear = rules.linear
		}
	}
	return u
}

// unblockAfterSecurityFix takes each pull request the merged fix unblocks in turn. A pull request that merged or closed
// meanwhile is reported as gone; one aimed at another branch than the trunk is none of this step's.
func (r *Restarter) unblockAfterSecurityFix(ctx context.Context, fix secfix.Fix) []secfix.Unblocked {
	if len(fix.Unblocks) == 0 || r.env.Gh == nil || fix.Repo == "" || fix.Pr <= 0 {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), securityUnblockTimeout)
	defer cancel()
	u := r.beginUnblock(ctx, fix)
	var rtn []secfix.Unblocked
	for i, number := range fix.Unblocks {
		if i >= securityUnblockMax {
			break
		}
		if outcome, ok := u.pr(ctx, number); ok {
			rtn = append(rtn, outcome)
		}
	}
	return rtn
}

func failedUnblock(number int, err error) secfix.Unblocked {
	return secfix.Unblocked{Pr: number, Outcome: secfix.UnblockFailed, Detail: secfix.CleanLine(err.Error(), 120)}
}

func (u *unblockRun) read(ctx context.Context, number int) (ghUnblockPr, error) {
	out, err := u.r.ghAt(ctx, u.fix.Dir, "pr", "view", strconv.Itoa(number), "--json", unblockPrFields, "--repo", u.fix.Repo)
	if err != nil {
		return ghUnblockPr{}, err
	}
	var pr ghUnblockPr
	if err := json.Unmarshal(out, &pr); err != nil {
		return ghUnblockPr{}, fmt.Errorf("gh pr view answered something unreadable")
	}
	return pr, nil
}

// headHas tells whether the head holds the fix: its commit on the trunk, else the trunk's tip.
func (u *unblockRun) headHas(ctx context.Context, head string) (bool, bool) {
	return u.r.holdsCommit(ctx, u.fix.Dir, u.fix.Repo, u.rebase.ref(u.fix.Trunk), head)
}

// pr is what becomes of one pull request; false when the step has nothing to say of it.
func (u *unblockRun) pr(ctx context.Context, number int) (secfix.Unblocked, bool) {
	ctx, cancel := context.WithTimeout(ctx, securityUnblockPrTimeout)
	defer cancel()
	facts, err := u.read(ctx, number)
	if err != nil {
		return failedUnblock(number, err), true
	}
	if !facts.open() {
		return secfix.Unblocked{Pr: number, Outcome: secfix.UnblockGone}, true
	}
	if u.fix.Trunk != "" && facts.BaseRefName != u.fix.Trunk {
		return secfix.Unblocked{}, false
	}
	runs, failing := facts.failing()
	if !failing {
		return secfix.Unblocked{Pr: number, Outcome: secfix.UnblockLeft}, true
	}
	has, known := u.headHas(ctx, facts.HeadRefOid)
	if !known {
		return failedUnblock(number, fmt.Errorf("GitHub did not say whether its head holds the fix")), true
	}
	if has {
		return u.rerun(ctx, number, facts, runs), true
	}
	return u.update(ctx, number, facts), true
}

// rerun runs the failed GitHub Actions jobs of a head that holds the fix; checks that are not runs cannot be rerun here.
func (u *unblockRun) rerun(ctx context.Context, number int, facts ghUnblockPr, runs []int64) secfix.Unblocked {
	if len(runs) == 0 {
		return failedUnblock(number, fmt.Errorf("its failed checks are not GitHub Actions runs MoltenTerm can rerun"))
	}
	for _, id := range runs {
		if _, err := u.r.ghAt(ctx, u.fix.Dir, "run", "rerun", strconv.FormatInt(id, 10), "--failed", "--repo", u.fix.Repo); err != nil {
			return failedUnblock(number, err)
		}
	}
	u.r.pushSeen(u.fix.Dir, facts.HeadRefName, "")
	return secfix.Unblocked{Pr: number, Outcome: secfix.UnblockRerun}
}

func resultAgent(res RestartResult) string {
	switch {
	case res.FirstName != "":
		return res.FirstName
	case res.AgentName != "":
		return res.AgentName
	}
	return molten.AgentDisplayName(res.Agent)
}

// update puts a head that lacks the fix on its way to holding it: through the agent that works on the branch, else
// through GitHub when nobody does and that is certain.
func (u *unblockRun) update(ctx context.Context, number int, facts ghUnblockPr) secfix.Unblocked {
	req := RebaseRequest{PrKey: PrKey{Repo: u.fix.Repo, Number: number}, Dir: u.fix.Dir, HeadRef: facts.HeadRefName, BaseRef: u.fix.Trunk,
		HeadOid: facts.HeadRefOid, Title: secfix.CleanLine(facts.Title, 200), Url: facts.Url, MergedPr: u.fix.Pr, security: u.rebase}
	if err := req.check(); err != nil {
		return failedUnblock(number, err)
	}
	gate, known := u.r.gateKnown(ctx, req.restartRequest())
	if !known {
		return secfix.Unblocked{Pr: number, Outcome: secfix.UnblockWaits, Detail: "who works on it could not be told"}
	}
	res := u.r.handSecurityRebase(ctx, req, gate)
	switch res.Status {
	case RestartSent, RestartTyped, RestartStarted:
		return secfix.Unblocked{Pr: number, Outcome: secfix.UnblockHanded, Agent: resultAgent(res)}
	case RestartQueued:
		return secfix.Unblocked{Pr: number, Outcome: secfix.UnblockQueued, Agent: resultAgent(res)}
	case RestartBusy:
		if res.Reason == RestartReasonAlreadyHanded {
			return secfix.Unblocked{Pr: number, Outcome: secfix.UnblockHanded, Agent: resultAgent(res)}
		}
		return secfix.Unblocked{Pr: number, Outcome: secfix.UnblockWaits, Agent: resultAgent(res)}
	case RestartOffer:
		return u.updateThroughGithub(ctx, number, facts)
	}
	detail := res.Message
	if detail == "" {
		detail = res.Status
	}
	return failedUnblock(number, fmt.Errorf("%s", detail))
}

// updateThroughGithub updates the branch of a pull request nobody works on: gh pr update-branch, which merges the trunk
// into the branch, or rebases it onto the trunk when the trunk needs a linear history. It runs only when the head is
// still the one that was judged: a push since means someone is at work.
func (u *unblockRun) updateThroughGithub(ctx context.Context, number int, facts ghUnblockPr) secfix.Unblocked {
	if facts.conflicting() {
		return secfix.Unblocked{Pr: number, Outcome: secfix.UnblockConflicts}
	}
	again, err := u.read(ctx, number)
	if err != nil {
		return failedUnblock(number, err)
	}
	if !again.open() {
		return secfix.Unblocked{Pr: number, Outcome: secfix.UnblockGone}
	}
	if !strings.EqualFold(again.HeadRefOid, facts.HeadRefOid) {
		return secfix.Unblocked{Pr: number, Outcome: secfix.UnblockWaits, Detail: "its head moved while it was read"}
	}
	args := []string{"pr", "update-branch", strconv.Itoa(number), "--repo", u.fix.Repo}
	if u.linear {
		args = append(args, "--rebase")
	}
	if _, err := u.r.ghAt(ctx, u.fix.Dir, args...); err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "conflict") {
			return secfix.Unblocked{Pr: number, Outcome: secfix.UnblockConflicts}
		}
		return failedUnblock(number, err)
	}
	u.r.pushSeen(u.fix.Dir, facts.HeadRefName, "")
	return secfix.Unblocked{Pr: number, Outcome: secfix.UnblockUpdated}
}

// securityRebaseApplies is whether the request that waits for an agent still applies: the pull request is open and its head
// lacks the fix, whatever head the agent pushed meanwhile. GitHub not answering proves nothing: it keeps applying.
func (r *Restarter) securityRebaseApplies(ctx context.Context, req RebaseRequest) bool {
	now := r.readPrNow(ctx, req.PrKey, req.Dir)
	if !now.read {
		return true
	}
	if now.state != "" && now.state != "OPEN" {
		return false
	}
	has, known := r.holdsCommit(ctx, req.Dir, req.Repo, req.security.ref(req.BaseRef), now.head)
	return !(known && has)
}

// handSecurityRebase gives the rebase to the agent that works on the branch. A busy agent is not interrupted: the request
// waits in the handoffs' queue for its prompt, and goes on its own once the agent is done. An idle or sleeping one gets it
// as an ordinary rebase asks. With nobody there nothing starts: the answer is the offer, and the caller updates the branch.
func (r *Restarter) handSecurityRebase(ctx context.Context, req RebaseRequest, gate ownerGate) RestartResult {
	if held, ok := r.handedAlready(HandoffRebase, req.PrKey, req.HeadOid); ok {
		return held
	}
	rreq := req.restartRequest()
	ctx = withTask(ctx, &handoffTask{kind: HandoffRebase, req: rreq, head: req.HeadOid,
		applies: func(ctx context.Context) bool { return r.securityRebaseApplies(ctx, req) }})
	var res RestartResult
	if verdict, owner := decideOwner(gate.rows); verdict == OwnerWorking {
		res = r.queueSecurityRebase(ctx, req, *owner)
	} else {
		origin := r.origin(rreq, AgentOriginRebase)
		origin.MergedPr = req.MergedPr
		res = r.askOnBranchWith(ctx, rreq, origin, gate, func(tree string, result *RestartResult) (string, bool) {
			return r.rebaseLine(req, tree, result)
		})
	}
	r.noteHanded(HandoffRebase, req.PrKey, req.HeadOid, res)
	return res
}

// queueSecurityRebase hands the request to the terminal of the agent that works on the branch, or of the lead whose
// sub-agent or background agent does. When that terminal cannot be reached, nothing is sent and the pull request is left.
func (r *Restarter) queueSecurityRebase(ctx context.Context, req RebaseRequest, row ownerRow) RestartResult {
	rreq := req.restartRequest()
	blockId := row.agent.BlockId
	if row.agent.Kind != mission.UpcomingAgentPanel {
		blockId = row.agent.ParentBlockId
	}
	if blockId == "" || r.env.FindLead == nil || r.env.SendLead == nil {
		return busyResult(rreq, row)
	}
	found, ok := r.env.FindLead(ctx, agenthandoff.LeadQuery{BlockId: blockId, ProjectDir: req.Dir})
	if !ok {
		return busyResult(rreq, row)
	}
	goal, text, closing := req.security.request(req, found.FirstName, row)
	result := r.deliverToLead(ctx, found, req.HeadRef, goal, text, closing)
	if row.agent.Kind == mission.UpcomingAgentSubagent {
		result.Subagent, result.Worktree = true, row.agent.Worktree
	}
	return result
}

// takeSecurityMerge is the step after a fix's pull request merged, whoever sees the merge first: it takes the merge for the
// fix once, brings the blocked pull requests back, tells it in one notification and clears the agent's copy. false when
// another caller took the merge, or the fix is not one it knows.
func (r *Restarter) takeSecurityMerge(ctx context.Context, fix secfix.Fix) (secfix.Fix, bool) {
	store := r.fixStore()
	if store == nil {
		return fix, false
	}
	// What the block holds now; once the merge turned the blocked pull requests green the block is gone, and what the fix
	// kept when it became ready stands.
	unblocks := r.securityUnblocks(fix)
	if len(unblocks) == 0 {
		unblocks = fix.Unblocks
	}
	claimed := false
	updated, found, _ := store.Update(fix.Dir, fix.Fingerprint, func(f *secfix.Fix) bool {
		if f.State == secfix.FixMerged {
			return false
		}
		claimed = true
		f.State, f.Reason, f.MergedAt, f.Unblocks = secfix.FixMerged, "", r.env.Now().UnixMilli(), unblocks
		return true
	})
	if !found || !claimed {
		return updated, false
	}
	r.resolveSecurityNotice(ctx, updated, securityNoticeStarted, securityNoticeNeeds, securityNoticeReady)
	if outcomes := r.unblockAfterSecurityFix(ctx, updated); len(outcomes) > 0 {
		updated, _, _ = store.Update(updated.Dir, updated.Fingerprint, func(f *secfix.Fix) bool {
			f.Unblocked, f.UnblockedAt = outcomes, r.env.Now().UnixMilli()
			return true
		})
	}
	r.notify(ctx, securityMerged(updated, updated.Unblocks))
	r.securityCleanup(ctx, updated)
	return updated, true
}

// holdsCommit tells whether a head holds a commit, by GitHub's comparison of the commit with it: the head is identical to
// the commit or ahead of it. known is false when GitHub did not say.
func (r *Restarter) holdsCommit(ctx context.Context, dir string, repo string, ref string, head string) (bool, bool) {
	if ref == "" || !isOid(head) {
		return false, false
	}
	out, err := r.ghAt(ctx, dir, "api", "repos/"+repo+"/compare/"+url.PathEscape(ref)+"..."+head, "--jq", ".status")
	if err != nil {
		return false, false
	}
	switch strings.Trim(strings.TrimSpace(string(out)), `"`) {
	case "identical", "ahead":
		return true, true
	case "behind", "diverged":
		return false, true
	}
	return false, false
}

// SecurityMergedPr is the merge of a pull request seen by the cleanup after a merge (cleanup.go): when it is the pull
// request of a fix, the step after the merge runs, once, and the fix as it is then comes back.
func (r *Restarter) SecurityMergedPr(ctx context.Context, dir string, number int) (secfix.Fix, bool) {
	store := r.fixStore()
	if store == nil {
		return secfix.Fix{}, false
	}
	fix, ok := store.OfPr(dir, number)
	if !ok {
		return secfix.Fix{}, false
	}
	return r.takeSecurityMerge(ctx, fix)
}
