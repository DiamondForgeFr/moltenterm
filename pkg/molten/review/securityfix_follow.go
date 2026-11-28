// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package review

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/secfix"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// Following a fix to its end (FR-REV-036 AC12, AC13): the agent works, then its pull request is watched until its checks
// are green and MoltenTerm marks it ready, then until the developer merges it. The agent says what it did in its outcome
// line, as the other flows' agents do (investigate_follow.go). MoltenTerm never merges, and a fix it did not start
// (External) is only watched. The follow lives in memory and is taken up again at start (resumeSecurityFixes): the
// record in the store is what it reads each tick.

const (
	// securityRecheck: how often a stopped agent's pull request is read while its checks run; securityRecheckReady: how
	// often once it waits for the merge, which may take days.
	securityRecheck      = 30 * time.Second
	securityRecheckReady = 2 * time.Minute
	// A claim that waits for a place and whose block is not seen any more is let go after this.
	securityWaitMax = 6 * time.Hour
)

type securityFollowState struct {
	sawRun     bool
	sawWorking bool
	checkedAt  time.Time
	stoppedAt  time.Time
	// lastKey and stoppedRead: what a stopped agent was when its copy and pull request were last read, and when.
	lastKey     string
	stoppedRead time.Time
	failSeen    string
	// noticed: what each kind of notification last said, so the same words are not told twice.
	noticed map[string]string
}

func (st *securityFollowState) said(kind string, text string) bool {
	if st.noticed == nil {
		st.noticed = map[string]string{}
	}
	if st.noticed[kind] == text {
		return true
	}
	st.noticed[kind] = text
	return false
}

func securityFollowKey(dir string, fingerprint string) string {
	return filepath.Clean(dir) + "|" + fingerprint
}

// followSecurityFix follows the fix until it ends; once per fix. Without FollowEvery (the tests) nothing runs on its own.
func (r *Restarter) followSecurityFix(dir string, fingerprint string) {
	if r.env.FollowEvery <= 0 {
		return
	}
	key := securityFollowKey(dir, fingerprint)
	r.lock.Lock()
	if r.secFollows[key] {
		r.lock.Unlock()
		return
	}
	r.secFollows[key] = true
	r.lock.Unlock()
	go func() {
		defer func() { panichandler.PanicHandler("molten:review:securityfix:follow", recover()) }()
		defer func() {
			r.lock.Lock()
			defer r.lock.Unlock()
			delete(r.secFollows, key)
		}()
		st := &securityFollowState{}
		ticker := time.NewTicker(r.env.FollowEvery)
		defer ticker.Stop()
		for range ticker.C {
			more := recoverStep("molten:review:securityfix:step", func() bool {
				ctx, cancel := context.WithTimeout(context.Background(), restartTimeout)
				defer cancel()
				return r.securityFollowStep(ctx, dir, fingerprint, st)
			})
			if !more {
				return
			}
		}
	}()
}

// resumeSecurityFixes takes up again the follow of every fix that was in flight when MoltenTerm last stopped.
func (r *Restarter) resumeSecurityFixes() {
	store := r.fixStore()
	if store == nil {
		return
	}
	for _, dir := range store.Dirs() {
		for _, fix := range store.Active(dir) {
			r.followSecurityFix(dir, fix.Fingerprint)
		}
	}
}

// securityFollowStep reads the fix once; false when the follow ends (the fix merged, was stopped, failed or is gone).
func (r *Restarter) securityFollowStep(ctx context.Context, dir string, fingerprint string, st *securityFollowState) bool {
	store := r.fixStore()
	if store == nil {
		return false
	}
	fix, ok := store.Get(dir, fingerprint)
	if !ok || fix.Ended() {
		return false
	}
	switch {
	case fix.State == secfix.FixWaiting:
		return r.securityFollowWaiting(ctx, fix)
	case fix.External:
		return r.securityFollowPr(ctx, st, fix, true)
	}
	return r.securityFollowAgent(ctx, st, fix)
}

// blockOfFix is the block of the last assessment that the fix stands for.
func blockOfFix(result secfix.Result, fix secfix.Fix) (secfix.Block, bool) {
	if block, ok := findBlock(result, fix.Fingerprint); ok {
		return block, true
	}
	for _, block := range result.Blocks {
		if fix.Covers(secfix.Ids(block.Advisories)) {
			return block, true
		}
	}
	return secfix.Block{}, false
}

// securityFollowWaiting tries a fix that waits for a place again, once its time came; a block that is not seen any more
// is let go after a while.
func (r *Restarter) securityFollowWaiting(ctx context.Context, fix secfix.Fix) bool {
	if !r.retryDue(fix, false) {
		return true
	}
	var result secfix.Result
	var ok bool
	if r.env.SecurityFix.Result != nil {
		result, ok = r.env.SecurityFix.Result(fix.Dir)
	}
	block, found := blockOfFix(result, fix)
	if !ok || !found {
		if r.env.Now().UnixMilli()-fix.StartedAt > securityWaitMax.Milliseconds() {
			r.fixStore().Remove(fix.Dir, fix.Fingerprint)
			return false
		}
		return true
	}
	in := securityLaunch{dir: fix.Dir, repo: fix.Repo, trunk: fix.Trunk, workspaceId: fix.WorkspaceId, agent: fix.Agent, block: block, auto: fix.Auto}
	ctx, cancel := context.WithTimeout(context.Background(), restartTimeout)
	defer cancel()
	r.launchSecurityFix(ctx, in)
	return true
}

// securityPaths are where the fix's outcome line goes.
func (r *Restarter) securityOutcomePath(fix secfix.Fix) string {
	return investigateOutcomePath(r.securityBriefPath(fix.Repo, fix.Fingerprint))
}

// securityFollowOf is the fix as the flows that read an agent's worktree and its pull request know it.
func securityFollowOf(fix secfix.Fix) agentFollow {
	return agentFollow{
		req: RestartRequest{PrKey: PrKey{Repo: fix.Repo, Number: fix.Pr}, Dir: fix.Dir, HeadRef: fix.Branch, BaseRef: fix.Trunk,
			Ticket: fix.Ticket, WorkspaceId: fix.WorkspaceId},
		origin: AgentOrigin{Kind: AgentOriginSecurity, Repo: fix.Repo, Branch: fix.Branch, Base: fix.Trunk, Ticket: fix.Ticket,
			Mode: AgentModeBackground},
		tree: fix.Tree, created: fix.Tree != "", blockId: fix.BlockId, tabId: fix.TabId, agent: fix.Agent,
	}
}

// securityFollowAgent follows the fix's agent, then, once it stopped, what it left: a needs-you line, work left in its copy,
// or its pull request.
func (r *Restarter) securityFollowAgent(ctx context.Context, st *securityFollowState, fix secfix.Fix) bool {
	if r.env.BlockExists != nil && fix.BlockId != "" && !r.env.BlockExists(ctx, fix.BlockId) {
		return r.securityTerminalGone(ctx, st, fix)
	}
	run, ok := r.agentRunOf(fix.BlockId)
	if ok {
		st.sawRun = true
	}
	running := ok && run.Running
	if running && run.State == molten.AgentStateWorking {
		st.sawWorking = true
		r.securityWorking(ctx, fix)
		return true
	}
	if running && (run.State == molten.AgentStateWaiting || run.State == molten.AgentStateError) {
		// Its question is its own notification, with Go to the terminal.
		return true
	}
	if running && len(fix.Extra) > 0 && r.securityTellExtra(ctx, fix) {
		return true
	}
	stopped := (st.sawRun && !running) || st.sawWorking || run.State == molten.AgentStateDone
	if !stopped {
		return true
	}
	if st.stoppedAt.IsZero() {
		st.stoppedAt = r.env.Now()
	}
	// A stopped agent's copy and pull request are read at most this often while nothing about the agent changes: they cost
	// git and gh calls, and the fix may wait days for the developer's merge.
	every := securityRecheck
	if fix.State == secfix.FixReady {
		every = securityRecheckReady
	}
	key := run.State + "/" + strconv.FormatBool(running) + "/" + strconv.FormatInt(run.StateSince, 10)
	if key == st.lastKey && r.env.Now().Sub(st.stoppedRead) < every {
		return true
	}
	st.lastKey, st.stoppedRead = key, r.env.Now()
	return r.securityAgentStopped(ctx, st, fix, run)
}

// securityWorking: the agent works, so what waited for the developer on its account does not any more.
func (r *Restarter) securityWorking(ctx context.Context, fix secfix.Fix) {
	if fix.State != secfix.FixNeedsYou {
		return
	}
	switch fix.Reason {
	case secfix.ReasonAgentOutcome, secfix.ReasonNoPr, secfix.ReasonAgentGone, secfix.ReasonNewAdvisory, secfix.ReasonChecksFailed:
		if updated, _, _ := r.fixStore().Update(fix.Dir, fix.Fingerprint, func(f *secfix.Fix) bool {
			f.State, f.Reason = secfix.FixWorking, ""
			return true
		}); updated.State == secfix.FixWorking {
			r.resolveSecurityNotice(ctx, fix, securityNoticeNeeds)
		}
	}
}

// securityTellExtra types the advisories that joined the set while the agent works into its prompt, when it can take them;
// true when it did (the agent works on them now).
func (r *Restarter) securityTellExtra(ctx context.Context, fix secfix.Fix) bool {
	if r.env.TypePrompt == nil || fix.BlockId == "" {
		return false
	}
	line := fmt.Sprintf("MoltenTerm: more advisories join this security fix: %s. Take them into the same fix and the same pull request, "+
		"then write your outcome line again.", strings.Join(fix.Extra, ", "))
	out := r.env.TypePrompt(ctx, fix.BlockId, line)
	if !out.Sent {
		return false
	}
	r.fixStore().Update(fix.Dir, fix.Fingerprint, func(f *secfix.Fix) bool {
		f.Ids, f.Extra = secfix.NormalizeIds(append(append([]string{}, f.Ids...), f.Extra...)), nil
		f.State, f.Reason = secfix.FixWorking, ""
		return true
	})
	return true
}

// securityTerminalGone: the agent's terminal closed (the developer closed it, or its tab or window went). A fix with a pull
// request goes on without the agent; one without waits for the developer.
func (r *Restarter) securityTerminalGone(ctx context.Context, st *securityFollowState, fix secfix.Fix) bool {
	if fix.Pr == 0 {
		fix = r.securityFindPr(ctx, fix)
	}
	if fix.Pr > 0 {
		return r.securityFollowPr(ctx, st, fix, false)
	}
	if outcome := readOutcome(r.securityOutcomePath(fix)); outcome != "" {
		if reason, needs := outcomeNeedsYou(outcome); needs {
			r.securityNeeds(ctx, st, fix, secfix.ReasonAgentOutcome, reason)
			return true
		}
	}
	r.securityNeeds(ctx, st, fix, secfix.ReasonAgentGone, "Its terminal closed before it opened the pull request.")
	return true
}

// securityNeeds puts the fix in "needs you", with why, and says so once per reason.
func (r *Restarter) securityNeeds(ctx context.Context, st *securityFollowState, fix secfix.Fix, reason string, detail string) {
	detail = secfix.CleanLine(detail, outcomeMaxLength)
	updated, found, _ := r.fixStore().Update(fix.Dir, fix.Fingerprint, func(f *secfix.Fix) bool {
		f.State, f.Reason, f.Outcome = secfix.FixNeedsYou, reason, detail
		return true
	})
	if !found || st.said(securityNoticeNeeds, reason+"/"+detail) {
		return
	}
	if r.env.StopSettled != nil && fix.BlockId != "" && r.env.StopSettled(fix.BlockId) {
		return
	}
	r.notify(ctx, securityNeedsYou(updated, detail))
}

// securityAgentStopped reads what a stopped agent left: its line, its copy, its pull request.
func (r *Restarter) securityAgentStopped(ctx context.Context, st *securityFollowState, fix secfix.Fix, run molten.AgentRunInfo) bool {
	name := agentName(run, fix.Agent)
	outcome := readOutcome(r.securityOutcomePath(fix))
	if reason, needs := outcomeNeedsYou(outcome); needs {
		r.securityNeeds(ctx, st, fix, secfix.ReasonAgentOutcome, reason)
		return true
	}
	if fix.Tree != "" && pathExists(fix.Tree) {
		if facts, err := r.readTree(ctx, securityFollowOf(fix)); err == nil {
			if message, _, needs := treeNeeds(name, fix.Branch, facts); needs {
				r.securityNeeds(ctx, st, fix, secfix.ReasonAgentOutcome, message)
				return true
			}
		}
	}
	if fix.Pr == 0 {
		fix = r.securityFindPr(ctx, fix)
	}
	if fix.Pr == 0 {
		r.securityNeeds(ctx, st, fix, secfix.ReasonNoPr, name+" stopped without opening a pull request.")
		return true
	}
	if outcome != "" {
		if resolution := securityResolutionOf(outcome); resolution != "" || fix.Outcome != outcome {
			updated, _, _ := r.fixStore().Update(fix.Dir, fix.Fingerprint, func(f *secfix.Fix) bool {
				f.Outcome = outcome
				if resolution != "" {
					f.Resolution = resolution
				}
				return true
			})
			fix = updated
		}
	}
	return r.securityFollowPr(ctx, st, fix, false)
}

type ghFoundPr struct {
	Number      int    `json:"number"`
	Url         string `json:"url"`
	State       string `json:"state"`
	IsDraft     bool   `json:"isDraft"`
	HeadRefName string `json:"headRefName"`
	MergedAt    string `json:"mergedAt"`
}

// securityFindPr finds the pull request of the fix's branch (or, for a ticket someone else's agent works on, the one that
// resolves the ticket) and keeps it in the fix; the fix as it is when none is found.
func (r *Restarter) securityFindPr(ctx context.Context, fix secfix.Fix) secfix.Fix {
	args := []string{"pr", "list", "--repo", fix.Repo, "--state", "all", "--json", "number,url,state,isDraft,headRefName,mergedAt", "--limit", "3"}
	switch {
	case fix.Branch != "":
		args = append(args, "--head", fix.Branch)
	case fix.Ticket > 0:
		args = append(args, "--search", fmt.Sprintf("Resolves #%d in:body", fix.Ticket))
	default:
		return fix
	}
	out, err := r.ghAt(ctx, fix.Dir, args...)
	if err != nil {
		return fix
	}
	var prs []ghFoundPr
	if json.Unmarshal(out, &prs) != nil {
		return fix
	}
	for _, pr := range prs {
		if pr.Number <= 0 || strings.EqualFold(pr.State, "CLOSED") {
			continue
		}
		updated, _, _ := r.fixStore().Update(fix.Dir, fix.Fingerprint, func(f *secfix.Fix) bool {
			f.Pr, f.PrUrl = pr.Number, pr.Url
			if f.Branch == "" {
				f.Branch = pr.HeadRefName
			}
			return true
		})
		return updated
	}
	return fix
}

// securityUnblocks are the pull requests the fix's merge unblocks: the ones the block of its advisories holds.
func (r *Restarter) securityUnblocks(fix secfix.Fix) []int {
	if r.env.SecurityFix.Result == nil {
		return nil
	}
	result, ok := r.env.SecurityFix.Result(fix.Dir)
	if !ok {
		return nil
	}
	block, found := blockOfFix(result, fix)
	if !found {
		return nil
	}
	var numbers []int
	for _, pr := range block.Prs {
		if pr.Number != fix.Pr {
			numbers = append(numbers, pr.Number)
		}
	}
	return numbers
}

type ghPrFacts struct {
	State    string `json:"state"`
	IsDraft  bool   `json:"isDraft"`
	MergedAt string `json:"mergedAt"`
}

// securityFollowPr watches the pull request: its checks (and the local CI's status when the project declares it), then
// the merge. fromExternal: it is someone else's, which is only watched. False when the follow ends.
func (r *Restarter) securityFollowPr(ctx context.Context, st *securityFollowState, fix secfix.Fix, external bool) bool {
	if fix.Pr == 0 {
		fix = r.securityFindPr(ctx, fix)
		if fix.Pr == 0 {
			return true
		}
	}
	every := securityRecheck
	if fix.State == secfix.FixReady {
		every = securityRecheckReady
	}
	if !st.checkedAt.IsZero() && r.env.Now().Sub(st.checkedAt) < every {
		return true
	}
	st.checkedAt = r.env.Now()
	out, err := r.ghAt(ctx, fix.Dir, "pr", "view", strconv.Itoa(fix.Pr), "--json", "state,isDraft,mergedAt", "--repo", fix.Repo)
	if err != nil {
		log.Printf("%s security fix %s: the pull request could not be read: %v\n", logPrefix, fix.Fingerprint, err)
		return true
	}
	var pr ghPrFacts
	if json.Unmarshal(out, &pr) != nil {
		return true
	}
	switch {
	case strings.EqualFold(pr.State, "MERGED"):
		r.securityMergedNow(ctx, fix)
		return false
	case !strings.EqualFold(pr.State, "OPEN"):
		r.securityClosedNow(ctx, st, fix)
		return false
	}
	if external {
		r.securityExternalState(ctx, fix, pr)
		return true
	}
	f := securityFollowOf(fix)
	checks, err := r.readChecks(ctx, f)
	if err != nil {
		log.Printf("%s security fix %s: the checks could not be read: %v\n", logPrefix, fix.Fingerprint, err)
		return true
	}
	all := checks
	if raw, err := r.ghAt(ctx, fix.Dir, "pr", "checks", strconv.Itoa(fix.Pr), "--json", "name,bucket", "--repo", fix.Repo); err == nil || len(raw) > 0 {
		var listed []ghCheckBucket
		if json.Unmarshal(raw, &listed) == nil && len(listed) > 0 {
			all = listed
		}
	}
	verdict := judgeChecks(checks, all, publishesLocalStatuses(fix.Dir))
	switch verdict.state {
	case ciPassed:
		st.failSeen = ""
		return r.securityGreen(ctx, st, fix, pr)
	case ciFailed:
		names := strings.Join(verdict.failed, ", ")
		if st.failSeen != names {
			// A failure is told once seen twice: right after a push GitHub may still show the last one.
			st.failSeen = names
			return true
		}
		message, _ := stillFailing(strconv.Itoa(fix.Pr), fix.Branch, verdict.failed)
		r.securityNeeds(ctx, st, fix, secfix.ReasonChecksFailed, message)
		return true
	}
	st.failSeen = ""
	if verdict.localWait && !st.stoppedAt.IsZero() && r.env.Now().Sub(st.stoppedAt) > localCiWait {
		message := "The local CI has not run on the head of #" + strconv.Itoa(fix.Pr) + ": run molten ci run " + fix.Branch + "."
		r.securityNeeds(ctx, st, fix, secfix.ReasonNotReady, message)
		return true
	}
	if fix.State == secfix.FixNeedsYou && (fix.Reason == secfix.ReasonChecksFailed || fix.Reason == secfix.ReasonNotReady) {
		r.securityWorking(ctx, fix)
	}
	return true
}

// securityGreen: the pull request's checks pass. MoltenTerm takes it out of draft, once, and says it is ready. It never
// merges.
func (r *Restarter) securityGreen(ctx context.Context, st *securityFollowState, fix secfix.Fix, pr ghPrFacts) bool {
	// Once is enough: a pull request the developer takes back to draft is not marked ready again behind their back.
	if fix.State == secfix.FixReady {
		return true
	}
	if pr.IsDraft {
		if _, err := r.ghAt(ctx, fix.Dir, "pr", "ready", strconv.Itoa(fix.Pr), "--repo", fix.Repo); err != nil {
			r.securityNeeds(ctx, st, fix, secfix.ReasonNotReady, "The pull request could not be marked ready: "+secfix.CleanLine(err.Error(), 120))
			return true
		}
	}
	updated, _, _ := r.fixStore().Update(fix.Dir, fix.Fingerprint, func(f *secfix.Fix) bool {
		f.State, f.Reason = secfix.FixReady, ""
		return true
	})
	r.resolveSecurityNotice(ctx, updated, securityNoticeNeeds)
	if !st.said(securityNoticeReady, strconv.Itoa(updated.Pr)) {
		r.notify(ctx, securityReady(updated, r.securityUnblocks(updated)))
	}
	return true
}

// securityExternalState keeps a fix someone else made as the pull request shows it.
func (r *Restarter) securityExternalState(ctx context.Context, fix secfix.Fix, pr ghPrFacts) {
	want := secfix.FixWorking
	if !pr.IsDraft {
		want = secfix.FixReady
	}
	if fix.State == want {
		return
	}
	r.fixStore().Update(fix.Dir, fix.Fingerprint, func(f *secfix.Fix) bool {
		f.State, f.Reason = want, ""
		return true
	})
}

// securityMergedNow: the pull request landed. The fix is merged and its notifications are over; the agent's terminal goes,
// and its copy when nothing is left in it.
func (r *Restarter) securityMergedNow(ctx context.Context, fix secfix.Fix) {
	unblocks := r.securityUnblocks(fix)
	updated, _, _ := r.fixStore().Update(fix.Dir, fix.Fingerprint, func(f *secfix.Fix) bool {
		f.State, f.Reason, f.MergedAt = secfix.FixMerged, "", r.env.Now().UnixMilli()
		return true
	})
	r.resolveSecurityNotice(ctx, updated, securityNoticeStarted, securityNoticeNeeds, securityNoticeReady)
	r.notify(ctx, securityMerged(updated, unblocks))
	r.securityCleanup(ctx, updated)
}

// securityClosedNow: the pull request was closed without a merge. The fix did not land, so it is failed: it is not started
// again on its own, and the developer is told.
func (r *Restarter) securityClosedNow(ctx context.Context, st *securityFollowState, fix secfix.Fix) {
	detail := "Its pull request #" + strconv.Itoa(fix.Pr) + " was closed without a merge."
	updated, _, _ := r.fixStore().Update(fix.Dir, fix.Fingerprint, func(f *secfix.Fix) bool {
		f.State, f.Reason, f.Outcome = secfix.FixFailed, secfix.ReasonPrClosed, detail
		return true
	})
	r.resolveSecurityNotice(ctx, updated, securityNoticeStarted, securityNoticeReady)
	r.notify(ctx, securityNeedsYou(updated, detail))
	r.securityCleanup(ctx, updated)
}

// securityCleanup closes the agent's terminal, and removes its copy when nothing is left in it (no change, no commit that
// origin lacks): what was left is the developer's to look at.
func (r *Restarter) securityCleanup(ctx context.Context, fix secfix.Fix) {
	if fix.External || fix.BlockId == "" {
		return
	}
	if r.env.CloseTerminal != nil && (r.env.BlockExists == nil || r.env.BlockExists(ctx, fix.BlockId)) {
		if err := r.env.CloseTerminal(ctx, fix.BlockId); err != nil {
			log.Printf("%s security fix %s: the agent's terminal could not be closed: %v\n", logPrefix, fix.Fingerprint, err)
		}
	}
	if fix.Tree == "" || !pathExists(fix.Tree) {
		return
	}
	f := securityFollowOf(fix)
	facts, err := r.readTree(ctx, f)
	if err != nil || !facts.clean() {
		return
	}
	if _, err := r.git(ctx, fix.Dir, "worktree", "remove", fix.Tree); err != nil {
		log.Printf("%s security fix %s: the worktree %s is kept: %v\n", logPrefix, fix.Fingerprint, fix.Tree, err)
		return
	}
	os.RemoveAll(fix.Tree)
}

// StopSecurityFix is the developer's Stop (from the block, the notification or the card): the agent's session ends, the fix
// is recorded as stopped and is never started again on its own for the same advisories (FR-REV-036 AC11, AC13).
func (r *Restarter) StopSecurityFix(ctx context.Context, req SecurityFixStopRequest) (SecurityFixResult, error) {
	if err := checkDir(req.Dir); err != nil {
		return SecurityFixResult{}, err
	}
	if !fingerprintPattern.MatchString(req.Fingerprint) {
		return SecurityFixResult{}, fmt.Errorf("fingerprint must be the one of the fix's advisories")
	}
	store := r.fixStore()
	if store == nil {
		return SecurityFixResult{}, fmt.Errorf("the security fix is not available")
	}
	dir := filepath.Clean(req.Dir)
	fix, ok := store.Get(dir, req.Fingerprint)
	if !ok || !fix.Active() {
		return SecurityFixResult{RestartResult: RestartResult{Status: RestartFailed, Message: "No security fix is running for these advisories."}}, nil
	}
	if fix.External {
		return SecurityFixResult{RestartResult: RestartResult{Status: RestartFailed, Message: "This fix is not MoltenTerm's: stop it where it runs."}, Fix: &fix}, nil
	}
	stopped, _, err := store.Update(dir, fix.Fingerprint, func(f *secfix.Fix) bool {
		f.State, f.Reason = secfix.FixStopped, ""
		return true
	})
	if err != nil {
		return SecurityFixResult{}, err
	}
	if fix.BlockId != "" && r.env.SecurityFix.StopAgent != nil {
		if _, err := r.env.SecurityFix.StopAgent(ctx, fix.BlockId); err != nil {
			log.Printf("%s security fix %s: the agent's session could not be ended: %v\n", logPrefix, fix.Fingerprint, err)
		}
	}
	r.resolveSecurityNotice(ctx, stopped, securityNoticeStarted, securityNoticeNeeds, securityNoticeReady)
	r.securityCleanup(ctx, stopped)
	return SecurityFixResult{RestartResult: RestartResult{Status: SecurityFixStoppedStatus}, Fix: &stopped}, nil
}
