// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package review

import (
	"context"
	"fmt"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agenthandoff"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/molten/secfix"
)

// After a security fix merged (FR-REV-036 AC15, #2590): the pull requests its block held are brought back, each in the way
// that cannot hurt it, and the developer hears of it once. Everything runs on fakes: a fake gh that refuses what MoltenTerm
// may not do (a merge) and records what it did, fake terminals, agents and handoffs.

const (
	unblockFixOid   = "1111111111111111111111111111111111111111"
	unblockHeadNine = "9999999999999999999999999999999999999999"
	unblockHeadTwlv = "1212121212121212121212121212121212121212"
	unblockHeadFrtn = "1414141414141414141414141414141414141414"
	unblockScanRun9 = 7009
	unblockScanRun2 = 7012
)

// blockedFake is a blocked pull request as the fake gh shows it.
type blockedFake struct {
	state, base, branch, head string
	// mergeable and mergeState are GitHub's words; holds is how GitHub's comparison calls the fix's commit against the
	// head ("behind" or "diverged": the head lacks it; "ahead" or "identical": it holds it).
	mergeable, mergeState, holds string
	rollup                       string
	// movedHead: what GitHub shows from the read after moveAfter (a push while MoltenTerm decided).
	movedHead string
	moveAfter int
	reads     int
}

func unblockScanEntry(state string, run int) string {
	conclusion := "FAILURE"
	if state == "success" {
		conclusion = "SUCCESS"
	}
	return fmt.Sprintf(`{"name":"Scan dependencies","workflowName":"Dependency security","status":"COMPLETED","conclusion":%q,`+
		`"detailsUrl":"https://github.com/acme/app/actions/runs/%d/job/%d","startedAt":"2026-11-28T09:00:00Z"}`, conclusion, run, run+1000)
}

func rollupOf(checks ...string) string {
	return "[" + strings.Join(checks, ",") + "]"
}

// blockedPr is the pull request number as the fake gh shows it; #9 is on the branch the restart fixture's agents work on.
func blockedPr(number int, head string, holds string, rollup string) *blockedFake {
	branch := fmt.Sprintf("feature/%d-x", number)
	if number == 9 {
		branch = "feature/9-fix-x"
	}
	return &blockedFake{state: "OPEN", base: securityTrunk, branch: branch, head: head, holds: holds,
		mergeable: "MERGEABLE", mergeState: "UNSTABLE", rollup: rollup}
}

func (p *blockedFake) json(number int) string {
	head := p.head
	if p.moveAfter > 0 && p.reads > p.moveAfter {
		head = p.movedHead
	}
	return fmt.Sprintf(`{"state":%q,"isDraft":true,"headRefName":%q,"headRefOid":%q,"baseRefName":%q,"title":"Work %d","url":"https://github.com/acme/app/pull/%d",`+
		`"mergeable":%q,"mergeStateStatus":%q,"reviewDecision":"","statusCheckRollup":%s}`,
		p.state, p.branch, head, p.base, number, number, p.mergeable, p.mergeState, p.rollup)
}

type unblockFixture struct {
	*followed
	inner func(ctx context.Context, dir string, args ...string) ([]byte, error)

	ulock   sync.Mutex
	prs     map[int]*blockedFake
	linear  bool
	noFixId bool
	seen    []string
	updates []string
	reruns  []string
	pushed  []string
	// What the handoffs did: the requests sent to a lead, and what became of them.
	sent       []agenthandoff.AppRequest
	sendStatus string
	leads      map[string]agenthandoff.LeadFound
}

func readyFix(t *testing.T) *unblockFixture {
	f := &unblockFixture{followed: startFollowed(t), prs: map[int]*blockedFake{}, sendStatus: agenthandoff.StatusQueued, leads: map[string]agenthandoff.LeadFound{}}
	f.inner = f.r.env.Gh
	f.r.env.Gh = f.gh
	f.r.env.PushSeen = func(dir string, branch string, oid string) {
		f.ulock.Lock()
		defer f.ulock.Unlock()
		f.pushed = append(f.pushed, branch)
	}
	f.r.env.FindLead = func(ctx context.Context, q agenthandoff.LeadQuery) (agenthandoff.LeadFound, bool) {
		f.ulock.Lock()
		defer f.ulock.Unlock()
		found, ok := f.leads[q.BlockId]
		return found, ok
	}
	f.r.env.SendLead = func(ctx context.Context, req agenthandoff.AppRequest) (agenthandoff.AppSent, error) {
		f.ulock.Lock()
		defer f.ulock.Unlock()
		f.sent = append(f.sent, req)
		return agenthandoff.AppSent{Status: f.sendStatus, To: req.ToBlockId, BriefPath: "/data/brief.md"}, nil
	}
	f.agent(molten.AgentStateIdle, true)
	f.st.sawWorking = true
	f.outcome("bump: left-pad 1.0.1")
	f.prOpen(true)
	f.set(func() { f.checks = checkPass })
	f.step()
	if fix := f.fix(f.block); fix.State != secfix.FixReady || !reflect.DeepEqual(fix.Unblocks, []int{9, 12, 14}) {
		t.Fatalf("the fix is ready, it unblocks 9, 12 and 14: %+v", fix)
	}
	return f
}

func (f *unblockFixture) gh(ctx context.Context, dir string, args ...string) ([]byte, error) {
	f.ulock.Lock()
	f.seen = append(f.seen, strings.Join(args, " "))
	out, ok, err := f.answer(args)
	f.ulock.Unlock()
	if ok {
		return out, err
	}
	return f.inner(ctx, dir, args...)
}

// answer is the part of GitHub the step after a merge reads and writes; ok is false for every other call.
func (f *unblockFixture) answer(args []string) ([]byte, bool, error) {
	call := strings.Join(args, " ")
	switch {
	case len(args) > 1 && args[0] == "pr" && args[1] == "merge":
		return nil, true, fmt.Errorf("MoltenTerm must never merge: %s", call)
	case len(args) > 2 && args[0] == "pr" && args[1] == "view":
		number, _ := strconv.Atoi(args[2])
		if number == 150 && strings.Contains(call, "mergeCommit") {
			if f.noFixId {
				return []byte(`{"mergeCommit":null}`), true, nil
			}
			return []byte(`{"mergeCommit":{"oid":"` + unblockFixOid + `"}}`), true, nil
		}
		pr, found := f.prs[number]
		if !found {
			return nil, false, nil
		}
		pr.reads++
		return []byte(pr.json(number)), true, nil
	case len(args) > 1 && args[0] == "api" && strings.Contains(args[1], "/rules/branches/"):
		if f.linear {
			return []byte(`[{"type":"required_linear_history"}]`), true, nil
		}
		return []byte(`[]`), true, nil
	case len(args) > 1 && args[0] == "api" && strings.Contains(args[1], "/compare/"):
		_, head, _ := strings.Cut(args[1], "...")
		for _, pr := range f.prs {
			if pr.head == head || pr.movedHead == head {
				return []byte(pr.holds + "\n"), true, nil
			}
		}
		return nil, true, fmt.Errorf("not found")
	case len(args) > 1 && args[0] == "pr" && args[1] == "update-branch":
		f.updates = append(f.updates, call)
		return nil, true, nil
	case len(args) > 1 && args[0] == "run" && args[1] == "rerun":
		f.reruns = append(f.reruns, call)
		return nil, true, nil
	}
	return nil, false, nil
}

// seenCalls are the calls to gh that start with the prefix, those the fake answered as well as those it passed on.
func (f *unblockFixture) seenCalls(prefix string) []string {
	f.ulock.Lock()
	defer f.ulock.Unlock()
	var rtn []string
	for _, call := range f.seen {
		if strings.HasPrefix(call, prefix) {
			rtn = append(rtn, call)
		}
	}
	return rtn
}

func (f *unblockFixture) merge() {
	f.t.Helper()
	f.set(func() {
		f.prView = `{"state":"MERGED","isDraft":false,"mergedAt":"2026-11-28T10:00:00Z"}`
		f.result = secfix.Result{Blocks: []secfix.Block{}}
	})
	f.advance(securityRecheckReady + time.Second)
	if f.step() {
		f.t.Fatal("the follow ends with the merge")
	}
}

func (f *unblockFixture) updatesSeen() []string {
	f.ulock.Lock()
	defer f.ulock.Unlock()
	return append([]string{}, f.updates...)
}

func (f *unblockFixture) rerunsSeen() []string {
	f.ulock.Lock()
	defer f.ulock.Unlock()
	return append([]string{}, f.reruns...)
}

func (f *unblockFixture) sentSeen() []agenthandoff.AppRequest {
	f.ulock.Lock()
	defer f.ulock.Unlock()
	return append([]agenthandoff.AppRequest{}, f.sent...)
}

func (f *unblockFixture) outcomes() map[int]secfix.Unblocked {
	f.t.Helper()
	rtn := map[int]secfix.Unblocked{}
	for _, item := range f.fix(f.block).Unblocked {
		rtn[item.Pr] = item
	}
	return rtn
}

// mergedNotices are the notifications of the merge: the summary is one.
func (f *unblockFixture) mergedNotices() []molten.NotificationInput {
	var rtn []molten.NotificationInput
	for _, n := range f.noticesSnapshot() {
		if strings.HasPrefix(n.Key, securityNoticePrefix+"merged:") {
			rtn = append(rtn, n)
		}
	}
	return rtn
}

// A head that lacks the fix is updated onto the trunk, one that holds it has its failed checks rerun, one whose checks do
// not fail is left alone; the developer is told once, and nothing is merged.
func TestSecurityMergeBringsEachBlockedPullRequestBack(t *testing.T) {
	t.Parallel()
	f := readyFix(t)
	f.index()
	f.ulock.Lock()
	f.prs[9] = blockedPr(9, unblockHeadNine, "behind", rollupOf(unblockScanEntry("failure", unblockScanRun9)))
	f.prs[12] = blockedPr(12, unblockHeadTwlv, "ahead", rollupOf(unblockScanEntry("failure", unblockScanRun2)))
	f.prs[14] = blockedPr(14, unblockHeadFrtn, "behind", rollupOf(unblockScanEntry("success", 7014)))
	f.ulock.Unlock()
	f.merge()

	want := map[int]string{9: secfix.UnblockUpdated, 12: secfix.UnblockRerun, 14: secfix.UnblockLeft}
	got := f.outcomes()
	for pr, outcome := range want {
		if got[pr].Outcome != outcome {
			t.Errorf("#%d: %+v, want %s", pr, got[pr], outcome)
		}
	}
	if updates := f.updatesSeen(); !reflect.DeepEqual(updates, []string{"pr update-branch 9 --repo " + restartRepo}) {
		t.Errorf("only the pull request that lacks the fix and fails is updated, with a merge of the trunk: %v", updates)
	}
	if reruns := f.rerunsSeen(); !reflect.DeepEqual(reruns, []string{"run rerun " + strconv.Itoa(unblockScanRun2) + " --failed --repo " + restartRepo}) {
		t.Errorf("only the pull request that holds the fix has its failed checks rerun: %v", reruns)
	}
	if fix := f.fix(f.block); fix.State != secfix.FixMerged || fix.UnblockedAt != f.now().UnixMilli() {
		t.Errorf("the fix is merged and says when the step ended: %+v", fix)
	}
	merged := f.mergedNotices()
	if len(merged) != 1 {
		t.Fatalf("one summary notification: %+v", merged)
	}
	n := merged[0]
	if n.Title != "Security fix #150 merged, 2 pull request(s) unblocked" || n.TitleText.Code != "notif.secfix.mergedUnblockedTitle" || n.TitleText.Vars["count"] != "2" ||
		n.Kind != "success" || n.Source != "deps" {
		t.Errorf("title: %+v", n)
	}
	for _, part := range []string{"Updated onto develop, checks running again: #9.", "Already holding the fix, failed checks run again: #12.", "Left alone, none of its checks fails: #14."} {
		if !strings.Contains(n.Message, part) {
			t.Errorf("the summary misses %q: %s", part, n.Message)
		}
	}
	if n.MessageText.Code != "notif.secfix.unblock.then" || n.MessageText.Parts["first"].Code != "notif.secfix.unblock.updated" {
		t.Errorf("the summary is worded by codes: %+v", n.MessageText)
	}
	if len(f.seenCalls("pr merge")) != 0 || len(f.calls("pr merge")) != 0 {
		t.Fatal("MoltenTerm never merges")
	}
	f.ulock.Lock()
	pushed := append([]string{}, f.pushed...)
	f.ulock.Unlock()
	if !reflect.DeepEqual(pushed, []string{"feature/9-fix-x", "feature/12-x"}) {
		t.Errorf("the list reads again the pull requests that were updated or rerun: %v", pushed)
	}
}

// AC15: a trunk that needs a linear history gets its branches rebased, not merged.
func TestSecurityMergeRebasesWhenTheTrunkNeedsALinearHistory(t *testing.T) {
	t.Parallel()
	f := readyFix(t)
	f.index()
	f.ulock.Lock()
	f.linear = true
	f.prs[9] = blockedPr(9, unblockHeadNine, "diverged", rollupOf(unblockScanEntry("failure", unblockScanRun9)))
	f.ulock.Unlock()
	f.merge()
	if updates := f.updatesSeen(); !reflect.DeepEqual(updates, []string{"pr update-branch 9 --repo " + restartRepo + " --rebase"}) {
		t.Fatalf("updates: %v", updates)
	}
	if got := f.outcomes()[9]; got.Outcome != secfix.UnblockUpdated {
		t.Fatalf("#9: %+v", got)
	}
}

// AC15: a plain rerun alone cannot work for a scan that reads the head, so a head that lacks the fix is never just rerun,
// even when its failed checks could be.
func TestSecurityMergeNeverReRunsAHeadThatLacksTheFix(t *testing.T) {
	t.Parallel()
	f := readyFix(t)
	f.index()
	f.ulock.Lock()
	f.prs[9] = blockedPr(9, unblockHeadNine, "behind", rollupOf(unblockScanEntry("failure", unblockScanRun9)))
	f.ulock.Unlock()
	f.merge()
	if len(f.rerunsSeen()) != 0 || len(f.updatesSeen()) != 1 {
		t.Fatalf("rerun %v, update %v", f.rerunsSeen(), f.updatesSeen())
	}
}

// AC15: an agent that works on the branch is handed the rebase, queued after its task, and nothing is pushed over it.
func TestSecurityMergeHandsTheRebaseToTheAgentThatWorksOnTheBranch(t *testing.T) {
	t.Parallel()
	f := readyFix(t)
	f.ulock.Lock()
	f.prs[9] = blockedPr(9, unblockHeadNine, "behind", rollupOf(unblockScanEntry("failure", unblockScanRun9)))
	f.leads["work-block"] = agenthandoff.LeadFound{BlockId: "work-block", FirstName: "Bastien", Agent: molten.AgentIdClaude, AgentName: "Claude Code"}
	f.ulock.Unlock()
	f.runs["work-block"] = molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateWorking, FirstName: "Bastien"}
	f.index(panelOn("/tree", "work-block"))
	f.merge()

	if got := f.outcomes()[9]; got.Outcome != secfix.UnblockQueued || got.Agent != "Bastien" {
		t.Fatalf("#9: %+v", got)
	}
	if len(f.updatesSeen()) != 0 || len(f.typed) != 0 {
		t.Fatalf("nothing is pushed or typed over a busy agent: updates %v, typed %v", f.updatesSeen(), f.typed)
	}
	sent := f.sentSeen()
	if len(sent) != 1 || sent[0].ToBlockId != "work-block" {
		t.Fatalf("the request goes through the handoffs, which queue it for the agent's prompt: %+v", sent)
	}
	for _, part := range []string{"security fix PR #150 merged into develop", "PR #9 (feature/9-fix-x)", "When your current task is done", "git push --force-with-lease", "Never merge the pull request"} {
		if !strings.Contains(sent[0].Goal, part) {
			t.Errorf("the goal misses %q: %s", part, sent[0].Goal)
		}
	}
	if !strings.Contains(sent[0].Context, "a rerun alone cannot help") || !strings.Contains(sent[0].Closing, "say so to the developer") {
		t.Errorf("context %q, closing %q", sent[0].Context, sent[0].Closing)
	}
	n := f.mergedNotices()
	if len(n) != 1 || !strings.Contains(n[0].Message, "Rebase waits for Bastien to finish the task in hand: #9.") || n[0].Title != "Security fix #150 merged, 1 pull request(s) unblocked" {
		t.Fatalf("the summary says it: %+v", n)
	}
}

// The queued request keeps applying whatever head the agent pushes meanwhile, until the branch holds the fix: it is not
// dropped as the ordinary rebase's is when the head moves, and it is not typed once the branch holds the fix.
func TestSecurityQueuedRebaseAppliesUntilTheBranchHoldsTheFix(t *testing.T) {
	t.Parallel()
	f := readyFix(t)
	f.ulock.Lock()
	f.prs[9] = blockedPr(9, unblockHeadNine, "behind", rollupOf(unblockScanEntry("failure", unblockScanRun9)))
	f.leads["work-block"] = agenthandoff.LeadFound{BlockId: "work-block", FirstName: "Bastien"}
	f.ulock.Unlock()
	f.runs["work-block"] = molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateWorking}
	f.index(panelOn("/tree", "work-block"))
	f.merge()
	sent := f.sentSeen()
	if len(sent) != 1 || sent[0].Applies == nil || sent[0].Key == "" {
		t.Fatalf("the request can say whether it applies and is keyed: %+v", sent)
	}
	if !sent[0].Applies(context.Background()) {
		t.Error("the branch lacks the fix: it applies")
	}
	pushed := "9191919191919191919191919191919191919191"
	f.ulock.Lock()
	f.prs[9].head, f.prs[9].holds = pushed, "behind"
	f.ulock.Unlock()
	if !sent[0].Applies(context.Background()) {
		t.Error("the agent pushed another head that still lacks the fix: it still applies")
	}
	f.ulock.Lock()
	f.prs[9].holds = "ahead"
	f.ulock.Unlock()
	if sent[0].Applies(context.Background()) {
		t.Error("the branch holds the fix now: the request is dropped")
	}
	f.ulock.Lock()
	f.prs[9].holds, f.prs[9].state = "behind", "MERGED"
	f.ulock.Unlock()
	if sent[0].Applies(context.Background()) {
		t.Error("a pull request that merged needs nothing")
	}
}

// The handoffs type the request when the agent's prompt is idle: that is a hand-off too, with the agent named.
func TestSecurityMergeTypesTheRebaseInTheIdleAgentOfTheBranch(t *testing.T) {
	t.Parallel()
	f := readyFix(t)
	f.ulock.Lock()
	f.prs[9] = blockedPr(9, unblockHeadNine, "behind", rollupOf(unblockScanEntry("failure", unblockScanRun9)))
	f.ulock.Unlock()
	f.runs["idle-block"] = molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateIdle, FirstName: "Rita", BlockId: "idle-block"}
	f.index(panelOn(f.dir, "idle-block"))
	f.merge()
	if got := f.outcomes()[9]; got.Outcome != secfix.UnblockHanded || got.Agent != "Rita" {
		t.Fatalf("#9: %+v", got)
	}
	line := f.typed["idle-block"]
	for _, part := range []string{"security fix PR #150 merged into develop", "PR #9 (feature/9-fix-x) needs it to pass the dependency scan", "git push --force-with-lease"} {
		if !strings.Contains(line, part) {
			t.Errorf("the prompt misses %q: %s", part, line)
		}
	}
	if len(line) > 590 {
		t.Errorf("the prompt must fit the guarded typing path: %d bytes", len(line))
	}
	if len(f.updatesSeen()) != 0 {
		t.Fatalf("nothing is pushed over the agent: %v", f.updatesSeen())
	}
}

// A sub-agent at work is reached through the lead that runs it; when nobody can be reached, or who works there cannot be
// told, the pull request is left alone, never updated.
func TestSecurityMergeLeavesAPullRequestItCannotBeSureNobodyWorksOn(t *testing.T) {
	t.Parallel()
	prs := func(f *unblockFixture) {
		f.ulock.Lock()
		defer f.ulock.Unlock()
		f.prs[9] = blockedPr(9, unblockHeadNine, "behind", rollupOf(unblockScanEntry("failure", unblockScanRun9)))
	}

	// The index cannot be read: it does not say nobody works there.
	f := readyFix(t)
	prs(f)
	f.r.env.BranchAgents = func(ctx context.Context, dir string) ([]mission.BranchAgent, bool) { return nil, false }
	f.merge()
	if got := f.outcomes()[9]; got.Outcome != secfix.UnblockWaits || len(f.updatesSeen()) != 0 {
		t.Errorf("an index that cannot be read: %+v, updates %v", got, f.updatesSeen())
	}

	// No index at all (a build that does not read one) counts the same.
	f = readyFix(t)
	prs(f)
	f.merge()
	if got := f.outcomes()[9]; got.Outcome != secfix.UnblockWaits || len(f.updatesSeen()) != 0 {
		t.Errorf("no index: %+v, updates %v", got, f.updatesSeen())
	}

	// A sub-agent works and its lead cannot be found: nothing is sent, nothing is updated.
	f = readyFix(t)
	prs(f)
	f.index(subagentOn("/tree", "running"))
	f.merge()
	if got := f.outcomes()[9]; got.Outcome != secfix.UnblockWaits || got.Agent == "" || len(f.updatesSeen()) != 0 || len(f.sentSeen()) != 0 {
		t.Errorf("an agent that cannot be reached: %+v, updates %v, sent %v", got, f.updatesSeen(), f.sentSeen())
	}

	// ... and when its lead is found, the request goes to the lead, which has the sub-agent continue.
	f = readyFix(t)
	prs(f)
	f.ulock.Lock()
	f.leads["lead-block"] = agenthandoff.LeadFound{BlockId: "lead-block", FirstName: "Arthur", Agent: molten.AgentIdClaude}
	f.ulock.Unlock()
	f.index(subagentOn("/tree", "running"))
	f.merge()
	sent := f.sentSeen()
	if got := f.outcomes()[9]; got.Outcome != secfix.UnblockQueued || got.Agent != "Arthur" || len(sent) != 1 || sent[0].ToBlockId != "lead-block" || len(f.updatesSeen()) != 0 {
		t.Fatalf("the lead of a working sub-agent has the request: %+v, sent %+v, updates %v", got, sent, f.updatesSeen())
	}
	if !strings.Contains(sent[0].Context, "a1b2c3d4e5f6") {
		t.Errorf("the lead is asked to continue the sub-agent: %s", sent[0].Context)
	}
}

// Nobody works on a branch that conflicts with the trunk: it cannot be updated by GitHub, so it is told to the developer to
// ask for a rebase, and nothing is touched. A head that moves while MoltenTerm decides means someone is at work.
func TestSecurityMergeDoesNotUpdateWhatItCannotUpdateSafely(t *testing.T) {
	t.Parallel()
	f := readyFix(t)
	f.index()
	f.ulock.Lock()
	conflicting := blockedPr(9, unblockHeadNine, "diverged", rollupOf(unblockScanEntry("failure", unblockScanRun9)))
	conflicting.mergeable, conflicting.mergeState = "CONFLICTING", "DIRTY"
	f.prs[9] = conflicting
	moving := blockedPr(12, unblockHeadTwlv, "behind", rollupOf(unblockScanEntry("failure", unblockScanRun2)))
	moving.movedHead, moving.moveAfter = "9292929292929292929292929292929292929292", 1
	f.prs[12] = moving
	f.ulock.Unlock()
	f.merge()
	if got := f.outcomes()[9]; got.Outcome != secfix.UnblockConflicts {
		t.Errorf("#9: %+v", got)
	}
	if got := f.outcomes()[12]; got.Outcome != secfix.UnblockWaits {
		t.Errorf("#12: %+v", got)
	}
	if len(f.updatesSeen()) != 0 {
		t.Fatalf("nothing is updated: %v", f.updatesSeen())
	}
	n := f.mergedNotices()
	if len(n) != 1 || n[0].Kind != "warning" || !strings.Contains(n[0].Message, "Conflicts with develop, ask for a rebase from its card: #9.") ||
		n[0].Title != "Security fix #150 merged" {
		t.Fatalf("a conflict needs the developer: %+v", n)
	}
}

// A pull request that merged or closed meanwhile, or that goes to another branch, is not told; a failed update is.
func TestSecurityMergeReportsWhatGoneAndWhatFailed(t *testing.T) {
	t.Parallel()
	f := readyFix(t)
	f.index()
	f.ulock.Lock()
	gone := blockedPr(9, unblockHeadNine, "behind", rollupOf(unblockScanEntry("failure", unblockScanRun9)))
	gone.state = "MERGED"
	f.prs[9] = gone
	other := blockedPr(12, unblockHeadTwlv, "behind", rollupOf(unblockScanEntry("failure", unblockScanRun2)))
	other.base = "release"
	f.prs[12] = other
	f.prs[14] = blockedPr(14, unblockHeadFrtn, "ahead", `[{"name":"Build","status":"COMPLETED","conclusion":"FAILURE","detailsUrl":"https://example.com/build"}]`)
	f.ulock.Unlock()
	f.merge()
	got := f.outcomes()
	if got[9].Outcome != secfix.UnblockGone {
		t.Errorf("#9: %+v", got[9])
	}
	if _, told := got[12]; told {
		t.Errorf("a pull request of another branch is none of the step's: %+v", got[12])
	}
	if got[14].Outcome != secfix.UnblockFailed || !strings.Contains(got[14].Detail, "not GitHub Actions runs") {
		t.Errorf("#14: %+v", got[14])
	}
	n := f.mergedNotices()
	if len(n) != 1 || n[0].Kind != "warning" || strings.Contains(n[0].Message, "#9") || !strings.Contains(n[0].Message, "Could not be brought back, see its card: #14.") {
		t.Fatalf("summary: %+v", n)
	}
}

// A GitHub that answers nothing is not a verdict: the pull request is told as failed, never updated on a guess.
func TestSecurityMergeDoesNotGuessWhenGitHubDoesNotSay(t *testing.T) {
	t.Parallel()
	f := readyFix(t)
	f.index()
	f.ulock.Lock()
	f.prs[9] = blockedPr(9, unblockHeadNine, "weird", rollupOf(unblockScanEntry("failure", unblockScanRun9)))
	f.ulock.Unlock()
	f.merge()
	if got := f.outcomes()[9]; got.Outcome != secfix.UnblockFailed || len(f.updatesSeen()) != 0 || len(f.rerunsSeen()) != 0 {
		t.Fatalf("#9: %+v, updates %v, reruns %v", got, f.updatesSeen(), f.rerunsSeen())
	}
}

// Without the fix's commit (GitHub did not say) the head is compared with the trunk: a head behind it lacks the fix.
func TestSecurityMergeComparesWithTheTrunkWhenTheFixCommitIsUnknown(t *testing.T) {
	t.Parallel()
	f := readyFix(t)
	f.index()
	f.ulock.Lock()
	f.noFixId = true
	f.prs[9] = blockedPr(9, unblockHeadNine, "behind", rollupOf(unblockScanEntry("failure", unblockScanRun9)))
	f.ulock.Unlock()
	f.merge()
	if got := f.outcomes()[9]; got.Outcome != secfix.UnblockUpdated {
		t.Fatalf("#9: %+v", got)
	}
	for _, call := range f.seenCalls("api repos/") {
		if strings.Contains(call, unblockFixOid) {
			t.Errorf("no commit is known: %s", call)
		}
	}
}

// The step runs once, whichever sees the merge first: the cleanup after a merge made from the Validate sheet, or the follow
// of the fix. One update, one summary.
func TestSecurityMergeRunsOnceWhoeverSeesItFirst(t *testing.T) {
	t.Parallel()
	f := readyFix(t)
	f.index()
	f.ulock.Lock()
	f.prs[9] = blockedPr(9, unblockHeadNine, "behind", rollupOf(unblockScanEntry("failure", unblockScanRun9)))
	f.ulock.Unlock()
	fix, ok := f.r.SecurityMergedPr(context.Background(), f.dir, 150)
	if !ok || fix.State != secfix.FixMerged || len(fix.Unblocked) != 1 || fix.Unblocked[0].Outcome != secfix.UnblockUpdated {
		t.Fatalf("the cleanup takes the merge: %+v %v", fix, ok)
	}
	if again, ok := f.r.SecurityMergedPr(context.Background(), f.dir, 150); ok {
		t.Fatalf("the merge is taken once: %+v", again)
	}
	f.merge()
	if len(f.updatesSeen()) != 1 || len(f.mergedNotices()) != 1 {
		t.Fatalf("one update %v and one summary %d", f.updatesSeen(), len(f.mergedNotices()))
	}
	if _, ok := f.r.SecurityMergedPr(context.Background(), f.dir, 151); ok {
		t.Fatal("a pull request that is no fix's is none of the step's")
	}
}

// Concurrent callers (the cleanup, the follow, another window's refresh) make one run.
func TestSecurityMergeTakesTheMergeOnceUnderConcurrentCallers(t *testing.T) {
	t.Parallel()
	f := readyFix(t)
	f.index()
	f.ulock.Lock()
	f.prs[9] = blockedPr(9, unblockHeadNine, "behind", rollupOf(unblockScanEntry("failure", unblockScanRun9)))
	f.ulock.Unlock()
	var wg sync.WaitGroup
	var took sync.Map
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, ok := f.r.SecurityMergedPr(context.Background(), f.dir, 150); ok {
				took.Store(i, true)
			}
		}()
	}
	wg.Wait()
	count := 0
	took.Range(func(any, any) bool { count++; return true })
	if count != 1 || len(f.updatesSeen()) != 1 || len(f.mergedNotices()) != 1 {
		t.Fatalf("taken by %d callers, updates %v, summaries %d", count, f.updatesSeen(), len(f.mergedNotices()))
	}
}

// Only the pull requests that did not cause the block are the ones the fix unblocks.
func TestSecurityUnblocksAreOnlyThePullRequestsThatDidNotCauseTheBlock(t *testing.T) {
	t.Parallel()
	f := makeSecurityFixture(t)
	block := securityBlock()
	block.Prs[1].Shared, block.Prs[1].Reasons = false, nil
	f.seeBlock(block)
	fix := secfix.Fix{Dir: f.dir, Fingerprint: block.Fingerprint, Ids: secfix.Ids(block.Advisories), Pr: 150}
	if got := f.r.securityUnblocks(fix); !reflect.DeepEqual(got, []int{9, 14}) {
		t.Fatalf("#12 brought its advisory itself: %v", got)
	}
}

// The merge of a pull request that is no fix's, or a project with no store, does nothing.
func TestSecurityMergedPrIgnoresWhatIsNoFix(t *testing.T) {
	t.Parallel()
	f := makeSecurityFixture(t)
	if _, ok := f.r.SecurityMergedPr(context.Background(), f.dir, 77); ok {
		t.Fatal("no fix has this pull request")
	}
	f.r.env.SecurityFix.Store = nil
	if _, ok := f.r.SecurityMergedPr(context.Background(), f.dir, 77); ok {
		t.Fatal("no store, no fix")
	}
}

// The coding agent is whichever the project works with: the request and the prompt are the same text for Claude Code,
// Codex and Kimi Code, which differ only by the agent named.
func TestSecurityRebaseRequestIsTheSameForEveryCodingAgent(t *testing.T) {
	t.Parallel()
	var goals, contexts []string
	for _, agent := range []string{molten.AgentIdClaude, molten.AgentIdCodex, molten.AgentIdKimi} {
		f := readyFix(t)
		f.ulock.Lock()
		f.prs[9] = blockedPr(9, unblockHeadNine, "behind", rollupOf(unblockScanEntry("failure", unblockScanRun9)))
		f.leads["work-block"] = agenthandoff.LeadFound{BlockId: "work-block", FirstName: "Bastien", Agent: agent}
		f.ulock.Unlock()
		f.runs["work-block"] = molten.AgentRunInfo{Agent: agent, Running: true, State: molten.AgentStateWorking, FirstName: "Bastien"}
		work := panelOn("/tree", "work-block")
		work.Agent = agent
		f.index(work)
		f.merge()
		sent := f.sentSeen()
		if len(sent) != 1 || f.outcomes()[9].Outcome != secfix.UnblockQueued {
			t.Fatalf("%s: %+v, %+v", agent, sent, f.outcomes())
		}
		goals, contexts = append(goals, sent[0].Goal), append(contexts, sent[0].Context)
	}
	if goals[0] != goals[1] || goals[1] != goals[2] || contexts[0] != contexts[1] || contexts[1] != contexts[2] {
		t.Fatalf("the request depends on the agent:\n%q\n%q\n%q", goals[0], goals[1], goals[2])
	}
}

// What the fix keeps for the panel: the outcome of each pull request, as data the answer carries.
func TestSecurityUnblockedIsKeptWithTheFix(t *testing.T) {
	t.Parallel()
	f := readyFix(t)
	f.index()
	f.ulock.Lock()
	f.prs[9] = blockedPr(9, unblockHeadNine, "behind", rollupOf(unblockScanEntry("failure", unblockScanRun9)))
	f.ulock.Unlock()
	f.merge()
	kept := f.store.List(f.dir)
	// The two pull requests the fake knows nothing of read as merged: gone.
	if len(kept) != 1 || !reflect.DeepEqual(kept[0].Unblocked, []secfix.Unblocked{{Pr: 9, Outcome: secfix.UnblockUpdated},
		{Pr: 12, Outcome: secfix.UnblockGone}, {Pr: 14, Outcome: secfix.UnblockGone}}) || !reflect.DeepEqual(kept[0].Unblocks, []int{9, 12, 14}) {
		t.Fatalf("kept: %+v", kept)
	}
}

// The step after the merge in the cleanup of the Validate sheet: the PR is a fix's, so the step is in the result with what
// became of each pull request; for any other PR there is no such step.
func TestCleanupUnblockStepOfASecurityFix(t *testing.T) {
	t.Parallel()
	f := makeCleanupFixture(t, false)
	cleaner := f.makeCleaner()
	cleaner.env.SecurityMerged = func(ctx context.Context, dir string, number int) (secfix.Fix, bool) {
		if number != 7 {
			return secfix.Fix{}, false
		}
		return secfix.Fix{Pr: 7, Unblocked: []secfix.Unblocked{
			{Pr: 9, Outcome: secfix.UnblockUpdated},
			{Pr: 12, Outcome: secfix.UnblockRerun},
			{Pr: 14, Outcome: secfix.UnblockHanded, Agent: "Rita"},
			{Pr: 15, Outcome: secfix.UnblockQueued, Agent: "Bastien"},
			{Pr: 16, Outcome: secfix.UnblockWaits, Agent: "Arthur"},
			{Pr: 17, Outcome: secfix.UnblockConflicts},
			{Pr: 18, Outcome: secfix.UnblockLeft},
			{Pr: 19, Outcome: secfix.UnblockGone},
			{Pr: 20, Outcome: secfix.UnblockFailed, Detail: "boom"},
		}}, true
	}
	result, err := cleaner.Run(context.Background(), CleanupRequest{Dir: f.dir, Repo: cleanupRepo, Number: 7, Steps: []string{CleanupStepUnblock}})
	if err != nil {
		t.Fatal(err)
	}
	step := expectStep(t, result, CleanupStepUnblock, CleanupStateFailed)
	if step.Code != CleanupCodeUnblocked || step.Base != "develop" || step.Conflicting != 1 || step.Failed != 1 || step.Unaffected != 1 {
		t.Errorf("step: %+v", step)
	}
	want := map[int]CleanupPr{
		9:  {State: CleanupStateDone, Flag: CleanupFlagUpdated},
		12: {State: CleanupStateDone, Flag: CleanupFlagRerun},
		14: {State: CleanupStateDone, Flag: CleanupFlagRebaseAsked, Agent: "Rita"},
		15: {State: CleanupStateDone, Flag: CleanupFlagRebaseQueued, Agent: "Bastien"},
		16: {State: CleanupStateSkipped, Flag: CleanupFlagAgentBusy, Agent: "Arthur"},
		17: {State: CleanupStateSkipped, Flag: CleanupFlagNeedsAgent},
		18: {State: CleanupStateDone},
		20: {State: CleanupStateFailed, Flag: CleanupFlagNeedsRebase, Error: "boom"},
	}
	if len(step.Prs) != len(want) {
		t.Fatalf("a pull request that went away is not listed: %+v", step.Prs)
	}
	for _, pr := range step.Prs {
		w := want[pr.Number]
		if pr.State != w.State || pr.Flag != w.Flag || pr.Agent != w.Agent || pr.Error != w.Error {
			t.Errorf("#%d: %+v, want %+v", pr.Number, pr, w)
		}
	}

	// The same cleanup of a PR that is no fix's has no such step, and neither does one whose merge another caller took.
	other := f.makeCleaner()
	other.env.SecurityMerged = func(ctx context.Context, dir string, number int) (secfix.Fix, bool) { return secfix.Fix{}, false }
	result, err = other.Run(context.Background(), CleanupRequest{Dir: f.dir, Repo: cleanupRepo, Number: 7, Steps: []string{CleanupStepUnblock}})
	if err != nil || result.Step(CleanupStepUnblock) != nil {
		t.Fatalf("no step for a PR that is no fix's: %+v %v", result.Steps, err)
	}
	none := f.makeCleaner()
	result, err = none.Run(context.Background(), CleanupRequest{Dir: f.dir, Repo: cleanupRepo, Number: 7, Steps: []string{CleanupStepUnblock}})
	if err != nil || result.Step(CleanupStepUnblock) != nil {
		t.Fatalf("a project that keeps no fixes has no such step: %+v %v", result.Steps, err)
	}
}

// The step never joins Validate's plan, so the sheet of an ordinary merge is what it was; it runs after the other PRs'.
func TestCleanupUnblockIsNeverPlannedAndComesLast(t *testing.T) {
	t.Parallel()
	for _, id := range CleanupSteps {
		if id == CleanupStepUnblock {
			t.Fatal("the unblock step is not one of Validate's planned steps")
		}
	}
	f := makeCleanupFixture(t, false)
	cleaner := f.makeCleaner()
	cleaner.env.SecurityMerged = func(ctx context.Context, dir string, number int) (secfix.Fix, bool) {
		return secfix.Fix{Pr: number, Unblocked: []secfix.Unblocked{{Pr: 9, Outcome: secfix.UnblockUpdated}}}, true
	}
	result, err := cleaner.Run(context.Background(), CleanupRequest{Dir: f.dir, Repo: cleanupRepo, Number: 7})
	if err != nil {
		t.Fatal(err)
	}
	if last := result.Steps[len(result.Steps)-1]; last.Id != CleanupStepUnblock {
		t.Fatalf("it comes after the other PRs' step: %+v", result.Steps)
	}
	if planned := cleaner.Plan(context.Background(), MergedPr{Dir: f.dir, Repo: cleanupRepo, Number: 7, HeadRef: "feature/7-thing", BaseRef: "develop"}); len(planned) != len(CleanupSteps) {
		t.Fatalf("the plan is unchanged: %+v", planned)
	}
}
