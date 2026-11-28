// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package review

import (
	"context"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/secfix"
)

// Following a fix to its end (FR-REV-036 AC12, AC13): the agent's line, its pull request, the green checks that make
// MoltenTerm mark it ready, and the merge, which is the developer's.

// followed is a fix started by the click, its agent known to the fake agent states, and a follow state of the test.
type followed struct {
	*securityFixture
	block secfix.Block
	st    *securityFollowState
	res   SecurityFixResult
}

func startFollowed(t *testing.T) *followed {
	f := &followed{securityFixture: makeSecurityFixture(t), block: securityBlock(), st: &securityFollowState{}}
	f.res = f.ask(f.block)
	if f.res.Status != RestartStarted {
		t.Fatalf("start: %+v", f.res)
	}
	return f
}

func (f *followed) step() bool {
	f.t.Helper()
	return f.r.securityFollowStep(context.Background(), f.dir, f.block.Fingerprint, f.st)
}

func (f *followed) agent(state string, running bool) {
	f.runs["new-block"] = molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: running, State: state, StateSince: f.now().UnixMilli()}
}

func (f *followed) outcome(line string) {
	f.t.Helper()
	if err := os.WriteFile(f.r.securityOutcomePath(f.fix(f.block)), []byte(line+"\n"), 0600); err != nil {
		f.t.Fatal(err)
	}
}

const (
	checkPending = `[{"name":"Quick checks","bucket":"pending"}]`
	checkPass    = `[{"name":"Quick checks","bucket":"pass"},{"name":"Frontend","bucket":"pass"}]`
	checkFail    = `[{"name":"Quick checks","bucket":"pass"},{"name":"Backend","bucket":"fail"}]`
)

func (f *followed) prOpen(draft bool) {
	branch := f.fix(f.block).Branch
	f.set(func() {
		f.headPrs = `[{"number":150,"url":"https://github.com/acme/app/pull/150","state":"OPEN","isDraft":` + boolText(draft) + `,"headRefName":"` + branch + `","mergedAt":""}]`
		f.prView = `{"state":"OPEN","isDraft":` + boolText(draft) + `,"mergedAt":null}`
	})
}

func boolText(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

func (f *followed) kinds() []string {
	var kinds []string
	for _, n := range f.noticesSnapshot() {
		kinds = append(kinds, strings.TrimPrefix(strings.SplitN(n.Key, ":", 4)[2], ""))
	}
	return kinds
}

func (f *followed) lastNotice() molten.NotificationInput {
	notes := f.noticesSnapshot()
	return notes[len(notes)-1]
}

// AC13: while the agent works nothing is said; its "needs you" line is said once, with the way to its terminal, and is
// withdrawn when the agent works again.
func TestSecurityFollowTellsWhatTheAgentNeedsOnce(t *testing.T) {
	t.Parallel()
	f := startFollowed(t)
	f.agent(molten.AgentStateWorking, true)
	if !f.step() || len(f.noticesSnapshot()) != 1 {
		t.Fatalf("nothing is said while it works: %+v", f.noticesSnapshot())
	}
	f.agent(molten.AgentStateIdle, true)
	f.outcome("needs you: no fixed version exists and the policy asks a human reviewer")
	f.step()
	f.step()
	notes := f.noticesSnapshot()
	if len(notes) != 2 || notes[1].Kind != "warning" || notes[1].Source != "deps" || notes[1].MessageText.Code != "notif.secfix.why.outcome" ||
		!strings.Contains(notes[1].Message, "policy asks a human reviewer") || !strings.HasPrefix(notes[1].Key, securityNoticePrefix+"needs:") {
		t.Fatalf("the line is said once: %+v", notes)
	}
	if notes[1].Actions[0].Id != "terminal" || notes[1].Actions[0].BlockId != "new-block" {
		t.Errorf("it offers the way to the terminal: %+v", notes[1].Actions)
	}
	if fix := f.fix(f.block); fix.State != secfix.FixNeedsYou || fix.Reason != secfix.ReasonAgentOutcome {
		t.Fatalf("fix: %+v", fix)
	}
	f.agent(molten.AgentStateWorking, true)
	f.step()
	if fix := f.fix(f.block); fix.State != secfix.FixWorking {
		t.Fatalf("the agent works again: %+v", fix)
	}
	if last := f.resolvedKey[len(f.resolvedKey)-1]; !strings.HasPrefix(last, securityNoticePrefix+"needs:") {
		t.Errorf("its needs-you notification is resolved: %v", f.resolvedKey)
	}
}

// AC12: once the agent stopped and its pull request is open, MoltenTerm waits for its checks, marks it ready when they are
// green (once), says so naming the pull requests the merge unblocks, and never merges.
func TestSecurityFollowMarksTheFixReadyOnceItsChecksAreGreen(t *testing.T) {
	t.Parallel()
	f := startFollowed(t)
	f.agent(molten.AgentStateWorking, true)
	f.step()
	f.agent(molten.AgentStateIdle, true)
	f.outcome("bump: golang.org/x/crypto 0.58.0 -> 0.58.1")
	f.prOpen(true)
	f.set(func() { f.checks = checkPending })
	if !f.step() {
		t.Fatal("the follow goes on")
	}
	fix := f.fix(f.block)
	if fix.Pr != 150 || fix.Resolution != secfix.ResolutionBump || fix.State != secfix.FixWorking || f.readied != 0 {
		t.Fatalf("the pull request is found, its checks run: %+v, readied %d", fix, f.readied)
	}
	f.set(func() { f.checks = checkPass })
	f.advance(securityRecheck + time.Second)
	f.step()
	fix = f.fix(f.block)
	if fix.State != secfix.FixReady || f.readied != 1 || len(f.calls("pr ready 150")) != 1 {
		t.Fatalf("green checks: %+v, readied %d", fix, f.readied)
	}
	notes := f.noticesSnapshot()
	ready := notes[len(notes)-1]
	if ready.Title != "Merging #150 unblocks #9, #12, #14" || ready.TitleText.Code != "notif.secfix.readyUnblocksTitle" || ready.TitleText.Vars["prs"] != "#9, #12, #14" ||
		ready.Kind != "success" || !strings.HasPrefix(ready.Key, securityNoticePrefix+"ready:") {
		t.Fatalf("ready: %+v", ready)
	}
	if !reflect.DeepEqual(fix.Unblocks, []int{9, 12, 14}) {
		t.Fatalf("the fix keeps the pull requests its merge unblocks: %+v", fix.Unblocks)
	}
	if found, ok := f.store.OfPr(f.dir, 150); !ok || found.Fingerprint != f.block.Fingerprint {
		t.Fatalf("the step after a merge finds the fix of a pull request: %+v %v", found, ok)
	}
	f.advance(securityRecheckReady + time.Second)
	f.step()
	f.advance(securityRecheckReady + time.Second)
	f.step()
	if f.readied != 1 || len(f.noticesSnapshot()) != len(notes) {
		t.Fatalf("it says it once and marks it once: readied %d, notices %d", f.readied, len(f.noticesSnapshot()))
	}
	if len(f.calls("pr merge")) != 0 {
		t.Fatal("MoltenTerm never merges")
	}
}

func TestSecurityFollowLeavesAPullRequestThatIsReadyAlone(t *testing.T) {
	t.Parallel()
	f := startFollowed(t)
	f.agent(molten.AgentStateIdle, true)
	f.st.sawWorking = true
	f.outcome("not applicable: the condition needs an attacker-supplied pattern; recorded in the policy")
	f.prOpen(false)
	f.set(func() { f.checks = checkPass })
	f.step()
	fix := f.fix(f.block)
	if fix.State != secfix.FixReady || fix.Resolution != secfix.ResolutionNotApplicable || f.readied != 0 {
		t.Fatalf("an applicability review, a pull request already ready: %+v, readied %d", fix, f.readied)
	}
}

// AC12: a red check is told once it is seen twice, and the fix goes back to work when it turns green.
func TestSecurityFollowTellsFailingChecksOnceSeenTwice(t *testing.T) {
	t.Parallel()
	f := startFollowed(t)
	f.agent(molten.AgentStateIdle, true)
	f.st.sawWorking = true
	f.outcome("bump: left-pad 1.0.1")
	f.prOpen(true)
	f.set(func() { f.checks = checkFail })
	f.step()
	if len(f.noticesSnapshot()) != 1 {
		t.Fatalf("seen once, not told: %+v", f.noticesSnapshot())
	}
	f.advance(securityRecheck + time.Second)
	f.step()
	last := f.lastNotice()
	if fix := f.fix(f.block); fix.State != secfix.FixNeedsYou || fix.Reason != secfix.ReasonChecksFailed || !strings.Contains(last.Message, "Backend") || last.Kind != "warning" {
		t.Fatalf("seen twice: %+v, %+v", fix, last)
	}
	f.set(func() { f.checks = checkPass })
	f.advance(securityRecheck + time.Second)
	f.step()
	if fix := f.fix(f.block); fix.State != secfix.FixReady {
		t.Fatalf("green again: %+v", fix)
	}
}

// AC12: the merge is the developer's; MoltenTerm sees it, says it, closes the agent's terminal and removes its copy.
func TestSecurityFollowSeesTheMergeAndCleansUp(t *testing.T) {
	t.Parallel()
	f := startFollowed(t)
	tree := f.fix(f.block).Tree
	f.agent(molten.AgentStateIdle, true)
	f.st.sawWorking = true
	f.outcome("bump: left-pad 1.0.1")
	f.prOpen(true)
	f.set(func() { f.checks = checkPass })
	f.step()
	// The merge turns the blocked pull requests green and the block goes before the follow sees it: what the fix kept when it
	// became ready is what the merge unblocked.
	f.set(func() {
		f.prView = `{"state":"MERGED","isDraft":false,"mergedAt":"2026-11-28T10:00:00Z"}`
		f.result = secfix.Result{Blocks: []secfix.Block{}}
	})
	f.advance(securityRecheckReady + time.Second)
	if f.step() {
		t.Fatal("the follow ends with the merge")
	}
	fix := f.fix(f.block)
	if fix.State != secfix.FixMerged || fix.MergedAt != f.now().UnixMilli() || !reflect.DeepEqual(fix.Unblocks, []int{9, 12, 14}) {
		t.Fatalf("fix: %+v", fix)
	}
	merged := f.lastNotice()
	if merged.TitleText.Code != "notif.secfix.mergedTitle" || merged.TitleText.Vars["pr"] != "150" || merged.MessageText.Code != "notif.secfix.mergedUnblocks" {
		t.Fatalf("merged: %+v", merged)
	}
	if len(f.closed) != 1 || f.closed[0] != "new-block" || pathExists(tree) {
		t.Fatalf("the terminal %v and the copy %s are gone", f.closed, tree)
	}
	var resolved []string
	for _, key := range f.resolvedKey {
		resolved = append(resolved, strings.SplitN(strings.TrimPrefix(key, securityNoticePrefix), ":", 2)[0])
	}
	for _, kind := range []string{"started", "needs", "ready"} {
		found := false
		for _, r := range resolved {
			found = found || r == kind
		}
		if !found {
			t.Errorf("the %s notification is not resolved at the merge: %v", kind, f.resolvedKey)
		}
	}
	if len(f.calls("pr merge")) != 0 {
		t.Fatal("MoltenTerm never merges")
	}
}

func TestSecurityFollowTellsAPullRequestClosedWithoutAMerge(t *testing.T) {
	t.Parallel()
	f := startFollowed(t)
	f.agent(molten.AgentStateIdle, true)
	f.st.sawWorking = true
	f.outcome("bump: left-pad 1.0.1")
	f.prOpen(true)
	f.set(func() { f.checks = checkPending })
	f.step()
	f.set(func() { f.prView = `{"state":"CLOSED","isDraft":false,"mergedAt":null}` })
	f.advance(securityRecheck + time.Second)
	if f.step() {
		t.Fatal("the follow ends")
	}
	fix := f.fix(f.block)
	if fix.State != secfix.FixFailed || fix.Reason != secfix.ReasonPrClosed || f.lastNotice().Kind != "warning" {
		t.Fatalf("a closed pull request is a failed fix, never started again on its own: %+v", fix)
	}
	if got, _ := secfix.PlanOf(f.store.List(f.dir), secfix.Ids(f.block.Advisories), f.now().UnixMilli()); got != secfix.PlanHeld {
		t.Fatalf("plan %q", got)
	}
}

func TestSecurityFollowTellsAnAgentThatLeftNoPullRequestOrWorkInItsCopy(t *testing.T) {
	t.Parallel()
	f := startFollowed(t)
	f.agent(molten.AgentStateIdle, true)
	f.st.sawWorking = true
	f.step()
	if fix := f.fix(f.block); fix.State != secfix.FixNeedsYou || fix.Reason != secfix.ReasonNoPr {
		t.Fatalf("it stopped with no pull request: %+v", fix)
	}
	// Work left in its copy is told before anything else.
	f2 := startFollowed(t)
	f2.agent(molten.AgentStateIdle, true)
	f2.st.sawWorking = true
	f2.write(f2.fix(f2.block).Tree, "go.mod", "module x\n")
	f2.step()
	fix := f2.fix(f2.block)
	if fix.State != secfix.FixNeedsYou || !strings.Contains(fix.Outcome, "uncommitted files") {
		t.Fatalf("uncommitted work: %+v", fix)
	}
}

// The terminal closed by the developer: a fix with a pull request goes on without it, one without waits for the developer.
func TestSecurityFollowGoesOnWhenTheTerminalIsClosed(t *testing.T) {
	t.Parallel()
	f := startFollowed(t)
	f.set(func() {})
	f.gone["new-block"] = true
	f.step()
	if fix := f.fix(f.block); fix.State != secfix.FixNeedsYou || fix.Reason != secfix.ReasonAgentGone {
		t.Fatalf("no pull request: %+v", fix)
	}
	f = startFollowed(t)
	f.gone["new-block"] = true
	f.prOpen(true)
	f.set(func() { f.checks = checkPass })
	f.step()
	if fix := f.fix(f.block); fix.State != secfix.FixReady || fix.Pr != 150 {
		t.Fatalf("its pull request goes on without it: %+v", fix)
	}
}

// AC13: Stop ends the agent's session, closes its terminal, is recorded as stopped, and withdraws the fix's notifications.
func TestStopSecurityFix(t *testing.T) {
	t.Parallel()
	f := startFollowed(t)
	tree := f.fix(f.block).Tree
	res, err := f.r.StopSecurityFix(context.Background(), SecurityFixStopRequest{Dir: f.dir, Fingerprint: f.block.Fingerprint})
	if err != nil || res.Status != SecurityFixStoppedStatus || res.Fix.State != secfix.FixStopped {
		t.Fatalf("stop: %+v %v", res, err)
	}
	if len(f.stopped) != 1 || f.stopped[0] != "new-block" || len(f.closed) != 1 || pathExists(tree) {
		t.Fatalf("session ended %v, terminal closed %v, copy %v", f.stopped, f.closed, pathExists(tree))
	}
	if f.step() {
		t.Fatal("the follow of a stopped fix ends")
	}
	again, err := f.r.StopSecurityFix(context.Background(), SecurityFixStopRequest{Dir: f.dir, Fingerprint: f.block.Fingerprint})
	if err != nil || again.Status != RestartFailed {
		t.Fatalf("a fix that is stopped is not stopped twice: %+v %v", again, err)
	}
	for _, bad := range []SecurityFixStopRequest{{Dir: "relative", Fingerprint: f.block.Fingerprint}, {Dir: f.dir, Fingerprint: "nope"}} {
		if _, err := f.r.StopSecurityFix(context.Background(), bad); err == nil {
			t.Errorf("%+v was accepted", bad)
		}
	}
}

func TestStopSecurityFixLeavesWorkThatIsNotMoltenTerms(t *testing.T) {
	t.Parallel()
	f := makeSecurityFixture(t)
	block := securityBlock()
	f.set(func() {
		f.prFound = `[{"number":90,"url":"https://github.com/acme/app/pull/90","title":"Bump","headRefName":"fix/90-x","isDraft":true}]`
	})
	f.ask(block)
	res, err := f.r.StopSecurityFix(context.Background(), SecurityFixStopRequest{Dir: f.dir, Fingerprint: block.Fingerprint})
	if err != nil || res.Status != RestartFailed || len(f.stopped) != 0 || f.fix(block).State != secfix.FixWorking {
		t.Fatalf("someone else's pull request is not MoltenTerm's to stop: %+v %v", res, err)
	}
	// A fix that waits has no agent to stop.
	w := makeSecurityFixture(t)
	w.set(func() { w.loaded = true })
	w.ask(block)
	res, err = w.r.StopSecurityFix(context.Background(), SecurityFixStopRequest{Dir: w.dir, Fingerprint: block.Fingerprint})
	if err != nil || res.Status != SecurityFixStoppedStatus || len(w.stopped) != 0 || w.fix(block).State != secfix.FixStopped {
		t.Fatalf("a waiting fix is stopped without an agent: %+v %v", res, err)
	}
}

// A fix someone else made is watched, never started, readied or stopped.
func TestSecurityFollowWatchesAnExternalFix(t *testing.T) {
	t.Parallel()
	f := makeSecurityFixture(t)
	block := securityBlock()
	f.set(func() {
		f.prFound = `[{"number":90,"url":"https://github.com/acme/app/pull/90","title":"Bump","headRefName":"fix/90-x","isDraft":true}]`
		f.prView = `{"state":"OPEN","isDraft":true,"mergedAt":null}`
		f.checks = checkPass
	})
	f.ask(block)
	st := &securityFollowState{}
	step := func() bool { return f.r.securityFollowStep(context.Background(), f.dir, block.Fingerprint, st) }
	step()
	if fix := f.fix(block); fix.State != secfix.FixWorking || f.readied != 0 {
		t.Fatalf("a draft: %+v", fix)
	}
	f.set(func() { f.prView = `{"state":"OPEN","isDraft":false,"mergedAt":null}` })
	f.advance(securityRecheck + time.Second)
	step()
	if fix := f.fix(block); fix.State != secfix.FixReady || f.readied != 0 {
		t.Fatalf("ready by its own author: %+v readied %d", fix, f.readied)
	}
	f.set(func() { f.prView = `{"state":"MERGED","isDraft":false,"mergedAt":"2026-11-28T10:00:00Z"}` })
	f.advance(securityRecheckReady + time.Second)
	if step() || f.fix(block).State != secfix.FixMerged || len(f.closed) != 0 {
		t.Fatalf("merged, and no terminal of MoltenTerm's to close")
	}
}

// AC9: advisories that join a set while its fix is in flight go to the same ticket as a comment, once, and to the agent
// when it can take them; they do not make a second fix.
func TestSecurityFixTakesInAdvisoriesThatJoinWhileItIsInFlight(t *testing.T) {
	t.Parallel()
	f := startFollowed(t)
	more := f.block
	more.Advisories = append(append([]secfix.Advisory{}, f.block.Advisories...), secfix.Advisory{Id: "GHSA-dddd-eeee-ffff", Package: "tinypool", Version: "1.1.1", Severity: "moderate"})
	more.Fingerprint = secfix.Fingerprint(secfix.Ids(more.Advisories))
	// The first refresh that sees them takes them in; the next finds them part of the set already.
	for i, want := range []string{SecurityFixAddendum, SecurityFixCovered} {
		res := f.r.launchSecurityFix(context.Background(), securityLaunch{dir: f.dir, repo: restartRepo, trunk: securityTrunk, workspaceId: "ws-1", block: more, auto: true})
		if res.Status != want {
			t.Fatalf("refresh %d: %+v, want %s", i, res, want)
		}
	}
	comments := f.calls("issue comment")
	if len(comments) != 1 || !strings.Contains(comments[0], "issue comment 101 --repo "+restartRepo) || !strings.Contains(comments[0], "GHSA-dddd-eeee-ffff") ||
		strings.Contains(comments[0], "GO-2026-1") {
		t.Fatalf("one comment on the same ticket, with the new advisory only: %v", comments)
	}
	if len(f.terminalLines()) != 1 || len(f.calls("issue create")) != 1 || len(f.store.List(f.dir)) != 1 {
		t.Fatalf("no second ticket, agent or fix")
	}
	if fix := f.fix(f.block); len(fix.Extra) != 1 || fix.Extra[0] != "GHSA-dddd-eeee-ffff" {
		t.Fatalf("fix: %+v", fix)
	}
	// Not while the agent works; the line is typed once it is idle.
	f.agent(molten.AgentStateWorking, true)
	f.step()
	if len(f.typed) != 0 {
		t.Fatalf("typed while it works: %v", f.typed)
	}
	f.agent(molten.AgentStateIdle, true)
	f.step()
	if line := f.typed["new-block"]; !strings.Contains(line, "more advisories join this security fix: GHSA-dddd-eeee-ffff") {
		t.Fatalf("typed %q", line)
	}
	fix := f.fix(f.block)
	if len(fix.Extra) != 0 || len(fix.Ids) != 3 {
		t.Fatalf("the agent took them in: %+v", fix)
	}
}

// Once the fix merged, a new advisory starts a new set (AC9); and a set whose fix merged a moment ago is still covered,
// whatever the scan on the trunk shows until its own run is over.
func TestSecurityFixAfterTheMergeStartsANewSetOnlyForNewAdvisories(t *testing.T) {
	t.Parallel()
	f := startFollowed(t)
	f.agent(molten.AgentStateIdle, true)
	f.st.sawWorking = true
	f.outcome("bump: left-pad 1.0.1")
	f.prOpen(true)
	f.set(func() {
		f.checks = checkPass
		f.prView = `{"state":"MERGED","isDraft":false,"mergedAt":"2026-11-28T10:00:00Z"}`
	})
	f.step()
	if fix := f.fix(f.block); fix.State != secfix.FixMerged {
		t.Fatalf("fix: %+v", fix)
	}
	again := f.r.launchSecurityFix(context.Background(), securityLaunch{dir: f.dir, repo: restartRepo, trunk: securityTrunk, workspaceId: "ws-1", block: f.block, auto: true})
	if again.Status != SecurityFixCovered || len(f.terminalLines()) != 1 {
		t.Fatalf("the scan still shows the same advisories a moment after the merge: %+v", again)
	}
	other := securityBlock()
	other.Advisories = []secfix.Advisory{{Id: "CVE-2026-9999", Package: "sharp", Version: "0.32.6"}}
	other.Fingerprint = secfix.Fingerprint(secfix.Ids(other.Advisories))
	f.set(func() { f.milestones = []string{"1.0.0"} })
	fresh := f.r.launchSecurityFix(context.Background(), securityLaunch{dir: f.dir, repo: restartRepo, trunk: securityTrunk, workspaceId: "ws-1", block: other, auto: true})
	if fresh.Status != RestartStarted || len(f.terminalLines()) != 2 || len(f.store.List(f.dir)) != 2 {
		t.Fatalf("a new advisory starts a new set: %+v", fresh)
	}
}

// What was in flight when MoltenTerm stopped is followed again at the next start.
func TestResumeSecurityFixesFollowsWhatWasInFlight(t *testing.T) {
	t.Parallel()
	f := startFollowed(t)
	f.r.env.FollowEvery = time.Hour
	f.r.resumeSecurityFixes()
	f.r.lock.Lock()
	key := securityFollowKey(f.dir, f.block.Fingerprint)
	followed := f.r.secFollows[key]
	f.r.lock.Unlock()
	if !followed {
		t.Fatalf("the fix in flight is not followed again: %v", f.r.secFollows)
	}
	// A second start does not follow it twice.
	f.r.resumeSecurityFixes()
	f.r.lock.Lock()
	count := len(f.r.secFollows)
	f.r.lock.Unlock()
	if count != 1 {
		t.Fatalf("%d follows", count)
	}
}
