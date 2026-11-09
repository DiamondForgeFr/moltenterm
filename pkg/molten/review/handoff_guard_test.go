// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package review

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agenthandoff"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
)

// The hand-off guard (#2145, FR-REV-022 AC22): a card sent its agent after a state the PR no longer had.

const (
	guardNewHead = "02d4ec6760000000000000000000000000000bbb"
	guardRedRoll = `[{"name":"build","workflowName":"CI","status":"COMPLETED","conclusion":"FAILURE","startedAt":"2026-11-09T16:00:00Z"}]`
	guardOkRoll  = `[{"name":"build","workflowName":"CI","status":"COMPLETED","conclusion":"SUCCESS","startedAt":"2026-11-09T16:00:00Z"}]`
)

// guardState is the PR as GitHub has it in a test.
type guardState struct {
	state      string
	head       string
	mergeable  string
	mergeState string
	draft      bool
	decision   string
	rollup     string
}

func (s guardState) json() string {
	return fmt.Sprintf(`{"state":%q,"isDraft":%v,"headRefOid":%q,"mergeable":%q,"mergeStateStatus":%q,"reviewDecision":%q,"statusCheckRollup":%s}`,
		s.state, s.draft, s.head, s.mergeable, s.mergeState, s.decision, s.rollup)
}

// conflicting: the PR as the card saw it, on the head the card knows.
func conflicting() guardState {
	return guardState{state: "OPEN", head: rebaseHead, mergeable: "CONFLICTING", mergeState: "DIRTY", rollup: guardRedRoll}
}

// guardGh answers `gh pr view` with the PR's state; the other calls fail.
type guardGh struct {
	lock  sync.Mutex
	pr    guardState
	err   error
	views []string
}

func (g *guardGh) run(ctx context.Context, dir string, args ...string) ([]byte, error) {
	g.lock.Lock()
	defer g.lock.Unlock()
	if len(args) < 3 || args[0] != "pr" || args[1] != "view" {
		return nil, errors.New("unexpected gh call: " + strings.Join(args, " "))
	}
	g.views = append(g.views, strings.Join(args, " "))
	if g.err != nil {
		return nil, g.err
	}
	return []byte(g.pr.json()), nil
}

func (g *guardGh) set(pr guardState) {
	g.lock.Lock()
	defer g.lock.Unlock()
	g.pr = pr
}

func (g *guardGh) reads() int {
	g.lock.Lock()
	defer g.lock.Unlock()
	return len(g.views)
}

type pushNote struct{ dir, branch, oid string }

// later moves the fixture's clock past the window in which the same hand-off is not sent twice, for a test that asks
// the same task for the same head again to read what the second ask writes.
func (f *restartFixture) later() {
	f.r.env.Now = func() time.Time { return time.UnixMilli(5000).Add(handedWindow + time.Minute) }
}

// guardFixture: a restart fixture whose agent on the branch is idle (so an unguarded hand-off would be typed), GitHub
// faked, the pushes told to the list recorded, and a clock the test moves.
type guardFixture struct {
	*leadFixture
	gh     *guardGh
	clock  time.Time
	pushes []pushNote
}

func makeGuardFixture(t *testing.T, pr guardState) *guardFixture {
	f := &guardFixture{leadFixture: makeLeadFixture(t), gh: &guardGh{pr: pr}, clock: time.UnixMilli(1_000_000)}
	f.r.env.Gh = f.gh.run
	f.r.env.Now = func() time.Time {
		f.lock.Lock()
		defer f.lock.Unlock()
		return f.clock
	}
	f.r.env.PushSeen = func(dir string, branch string, oid string) {
		f.lock.Lock()
		defer f.lock.Unlock()
		f.pushes = append(f.pushes, pushNote{dir, branch, oid})
	}
	tree := f.agentTreeOnBranch()
	f.terms[realOf(tree)] = []mission.WorktreeTerminal{{BlockId: "agent-term"}}
	f.lock.Lock()
	f.runs["agent-term"] = molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateIdle, FirstName: "Bruno"}
	f.lock.Unlock()
	return f
}

func (f *guardFixture) advance(d time.Duration) {
	f.lock.Lock()
	defer f.lock.Unlock()
	f.clock = f.clock.Add(d)
}

func (f *guardFixture) setRun(blockId string, run molten.AgentRunInfo) {
	f.lock.Lock()
	defer f.lock.Unlock()
	f.runs[blockId] = run
}

func (f *guardFixture) pushNotes() []pushNote {
	f.lock.Lock()
	defer f.lock.Unlock()
	return append([]pushNote(nil), f.pushes...)
}

func (f *guardFixture) typedLines() map[string]string {
	f.lock.Lock()
	defer f.lock.Unlock()
	rtn := map[string]string{}
	for k, v := range f.typed {
		rtn[k] = v
	}
	return rtn
}

func (f *guardFixture) briefsIn(dir string) []string {
	f.t.Helper()
	files, err := filepath.Glob(filepath.Join(f.dataDir, "molten", "reviews", "*", dir, "*"))
	if err != nil {
		f.t.Fatal(err)
	}
	return files
}

// AC2: the PR was rebased and pushed after the card was drawn: the head is not the card's, so nothing is typed, no
// brief is written, and the answer carries the head GitHub has; the list is told to read the PR again.
func TestRebaseForAHeadThatMovedIsNotSent(t *testing.T) {
	t.Parallel()
	moved := conflicting()
	moved.head, moved.mergeable, moved.mergeState = guardNewHead, "MERGEABLE", "CLEAN"
	f := makeGuardFixture(t, moved)
	res := f.askRebase(false)
	if res.Status != RestartStale || res.Reason != RestartReasonHeadMoved || res.Head != guardNewHead || res.Message == "" {
		t.Fatalf("result: %+v", res)
	}
	if len(f.typedLines()) != 0 || len(f.opened) != 0 || len(f.briefsIn("rebase")) != 0 {
		t.Errorf("nothing is sent: typed %v opened %v briefs %v", f.typedLines(), f.opened, f.briefsIn("rebase"))
	}
	if pushes := f.pushNotes(); len(pushes) != 1 || pushes[0] != (pushNote{f.dir, "feature/9-fix-x", guardNewHead}) {
		t.Errorf("the list reads the PR again: %+v", pushes)
	}
}

// AC2: the head is the card's but the conflict is gone (GitHub finished computing, or the base moved back).
func TestRebaseForAConflictThatIsGoneIsNotSent(t *testing.T) {
	t.Parallel()
	clean := conflicting()
	clean.mergeable, clean.mergeState = "MERGEABLE", "CLEAN"
	f := makeGuardFixture(t, clean)
	res := f.askRebase(false)
	if res.Status != RestartStale || res.Reason != RestartReasonProblemGone || res.Head != rebaseHead {
		t.Fatalf("result: %+v", res)
	}
	if len(f.typedLines()) != 0 || len(f.briefsIn("rebase")) != 0 {
		t.Errorf("nothing is sent: typed %v", f.typedLines())
	}
}

// A PR that is behind its base still needs the rebase the card asked for.
func TestRebaseOfABehindPrIsSent(t *testing.T) {
	t.Parallel()
	behind := conflicting()
	behind.mergeable, behind.mergeState = "MERGEABLE", "BEHIND"
	f := makeGuardFixture(t, behind)
	if res := f.askRebase(false); res.Status != RestartSent {
		t.Fatalf("result: %+v", res)
	}
}

func TestRebaseOfAClosedPrIsNotSent(t *testing.T) {
	t.Parallel()
	closed := conflicting()
	closed.state = "MERGED"
	f := makeGuardFixture(t, closed)
	res := f.askRebase(false)
	if res.Status != RestartStale || res.Reason != RestartReasonPrClosed || len(f.typedLines()) != 0 {
		t.Fatalf("result: %+v typed %v", res, f.typedLines())
	}
}

// The conflict remains: it goes, with the head GitHub has when the card did not know one.
func TestRebaseStillNeededIsSentWithTheCurrentHead(t *testing.T) {
	t.Parallel()
	f := makeGuardFixture(t, conflicting())
	req := f.rebaseRequest(false)
	req.HeadOid = ""
	res, err := f.r.AskRebase(context.Background(), req)
	if err != nil || res.Status != RestartSent || res.BlockId != "agent-term" {
		t.Fatalf("result: %+v %v", res, err)
	}
	if !strings.HasSuffix(res.BriefPath, "9-01234567.md") || !strings.Contains(readText(t, res.BriefPath), "Head when asked: "+rebaseHead) {
		t.Errorf("the brief names the current head: %s", res.BriefPath)
	}
	if len(f.pushNotes()) != 0 {
		t.Errorf("a PR that is as the card said needs no new read: %+v", f.pushNotes())
	}
}

// GitHub still computing the mergeability is no proof that the conflict is gone.
func TestRebaseWhileGitHubComputesIsSent(t *testing.T) {
	t.Parallel()
	computing := conflicting()
	computing.mergeable, computing.mergeState = "UNKNOWN", "UNKNOWN"
	f := makeGuardFixture(t, computing)
	if res := f.askRebase(false); res.Status != RestartSent {
		t.Fatalf("result: %+v", res)
	}
}

// GitHub not answering is no verdict on the PR: the hand-off goes as the card asked.
func TestHandOffGoesAsAskedWhenGitHubDoesNotAnswer(t *testing.T) {
	t.Parallel()
	f := makeGuardFixture(t, conflicting())
	f.gh.err = errors.New("HTTP 502")
	res := f.askRebase(false)
	if res.Status != RestartSent || f.gh.reads() != 1 {
		t.Fatalf("result: %+v reads %d", res, f.gh.reads())
	}
}

// Resume (the lead's hand-off) of a PR whose every problem is gone sends the lead nothing.
func TestResumeWithEveryProblemGoneSendsNothing(t *testing.T) {
	t.Parallel()
	fixed := guardState{state: "OPEN", head: rebaseHead, mergeable: "MERGEABLE", mergeState: "CLEAN", rollup: guardOkRoll}
	f := makeGuardFixture(t, fixed)
	f.arthurRuns()
	req := f.leadRequest()
	req.FailedChecks = []string{"build"}
	req.MarkReady = false
	res := f.askFinish(req)
	if res.Status != RestartStale || res.Reason != RestartReasonProblemGone || len(f.sentRequests()) != 0 {
		t.Fatalf("result: %+v sent %v", res, f.sentRequests())
	}
}

// What remains goes, and only that: the conflict is gone, the red check is not.
func TestResumeNamesOnlyTheProblemsThatRemain(t *testing.T) {
	t.Parallel()
	rebased := guardState{state: "OPEN", head: rebaseHead, mergeable: "MERGEABLE", mergeState: "UNSTABLE", rollup: guardRedRoll}
	f := makeGuardFixture(t, rebased)
	f.arthurRuns()
	req := f.leadRequest()
	req.FailedChecks = []string{"build"}
	req.ChangesRequested = true
	req.MarkReady = false
	res := f.askFinish(req)
	sent := f.sentRequests()
	if res.Status != RestartSent || len(sent) != 1 {
		t.Fatalf("result: %+v sent %v", res, sent)
	}
	brief := sent[0].Context
	if !strings.Contains(brief, "Failed checks: build") || strings.Contains(brief, "conflicts with develop") || strings.Contains(brief, "requested changes") {
		t.Errorf("the brief names the red check only:\n%s", brief)
	}
	if !strings.Contains(sent[0].Goal, "Left: red CI.") {
		t.Errorf("the typed goal: %s", sent[0].Goal)
	}
}

// A draft still waiting for its agent's last step stays a task of the agent.
func TestResumeOfADraftStillToMarkReadyIsSent(t *testing.T) {
	t.Parallel()
	draft := guardState{state: "OPEN", head: rebaseHead, mergeable: "MERGEABLE", mergeState: "DRAFT", draft: true, rollup: guardOkRoll}
	f := makeGuardFixture(t, draft)
	f.arthurRuns()
	req := f.leadRequest()
	req.Conflicts, req.FailedChecks, req.ChangesRequested = false, nil, false
	if res := f.askFinish(req); res.Status != RestartSent {
		t.Fatalf("result: %+v", res)
	}
}

func TestInvestigateWithEveryBlockerGoneIsNotSent(t *testing.T) {
	t.Parallel()
	fixed := guardState{state: "OPEN", head: rebaseHead, mergeable: "MERGEABLE", mergeState: "CLEAN", rollup: `[{"name":"Backend","status":"COMPLETED","conclusion":"SUCCESS"}]`}
	f := makeGuardFixture(t, fixed)
	res, err := f.r.AskInvestigate(context.Background(), f.investigateRequest(false))
	if err != nil || res.Status != RestartStale || res.Reason != RestartReasonProblemGone || len(f.typedLines()) != 0 {
		t.Fatalf("result: %+v %v typed %v", res, err, f.typedLines())
	}
}

// The rebase the card asked for is the one the PR needs now: a branch that was behind and now conflicts is a conflict.
func TestInvestigateSendsTheBlockersThatRemain(t *testing.T) {
	t.Parallel()
	now := guardState{state: "OPEN", head: rebaseHead, mergeable: "CONFLICTING", mergeState: "DIRTY", rollup: `[{"name":"Backend","status":"COMPLETED","conclusion":"SUCCESS"}]`}
	f := makeGuardFixture(t, now)
	req := f.investigateRequest(false)
	req.Merge = InvestigateMergeBehind
	res, err := f.r.AskInvestigate(context.Background(), req)
	if err != nil || res.Status != RestartSent {
		t.Fatalf("result: %+v %v", res, err)
	}
	line := f.typedLines()["agent-term"]
	if !strings.Contains(line, "conflicts with develop") || strings.Contains(line, "CI failed") {
		t.Errorf("the prompt names the conflict, not the check that passes now: %s", line)
	}
}

// Without anything the card named, the old error stays: there is nothing to hand over.
func TestInvestigateWithNothingNamedStillRefuses(t *testing.T) {
	t.Parallel()
	f := makeGuardFixture(t, conflicting())
	req := f.investigateRequest(false)
	req.Checks = nil
	if _, err := f.r.AskInvestigate(context.Background(), req); err == nil || !strings.Contains(err.Error(), "nothing blocks") {
		t.Fatalf("error: %v", err)
	}
}

// AC3: a second click on Resume for the same PR and head, while the first hand-off is handled, sends nothing and says
// who has it.
func TestARepeatedResumeForTheSameHeadSendsNothingMore(t *testing.T) {
	t.Parallel()
	f := makeGuardFixture(t, conflicting())
	f.arthurRuns()
	first := f.askFinish(f.leadRequest())
	if first.Status != RestartSent || len(f.sentRequests()) != 1 {
		t.Fatalf("first: %+v", first)
	}
	reads := f.gh.reads()
	for i := 0; i < 3; i++ {
		f.advance(20 * time.Second)
		again := f.askFinish(f.leadRequest())
		if again.Status != RestartBusy || again.Reason != RestartReasonAlreadyHanded || again.FirstName != "Arthur" || again.BlockId != "lead-block" ||
			again.Head != rebaseHead || again.HandedAt == 0 {
			t.Fatalf("click %d: %+v", i+2, again)
		}
	}
	if len(f.sentRequests()) != 1 || f.gh.reads() != reads {
		t.Errorf("one hand-off, and the held clicks do not even read GitHub: sent %d, reads %d then %d", len(f.sentRequests()), reads, f.gh.reads())
	}
}

// The same holds for the rebase asked straight after Resume, whose brief already asks for it.
func TestARebaseAfterResumeIsCoveredByIt(t *testing.T) {
	t.Parallel()
	f := makeGuardFixture(t, conflicting())
	f.arthurRuns()
	if first := f.askFinish(f.leadRequest()); first.Status != RestartSent {
		t.Fatalf("first: %+v", first)
	}
	res := f.askRebase(false)
	if res.Status != RestartBusy || res.Reason != RestartReasonAlreadyHanded || res.FirstName != "Arthur" || len(f.typedLines()) != 0 {
		t.Fatalf("result: %+v typed %v", res, f.typedLines())
	}
}

// ... but not the other way round: a rebase does not cover Resume's other tasks.
func TestResumeAfterARebaseIsAnotherTask(t *testing.T) {
	t.Parallel()
	f := makeGuardFixture(t, conflicting())
	if first := f.askRebase(false); first.Status != RestartSent {
		t.Fatalf("first: %+v", first)
	}
	f.setRun("agent-term", molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateIdle, FirstName: "Bruno"})
	if res := f.askFinish(f.finishRequest(false)); res.Reason == RestartReasonAlreadyHanded {
		t.Fatalf("result: %+v", res)
	}
}

// After the window, a hand-off whose agent stopped without pushing is asked again; one whose agent still works is not.
func TestAHandOffIsHeldWhileItsAgentWorksOnIt(t *testing.T) {
	t.Parallel()
	f := makeGuardFixture(t, conflicting())
	f.arthurRuns()
	f.setRun("lead-block", molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateWorking, FirstName: "Arthur"})
	if first := f.askFinish(f.leadRequest()); first.Status != RestartSent {
		t.Fatalf("first: %+v", first)
	}
	f.advance(handedWindow + time.Minute)
	if held := f.askFinish(f.leadRequest()); held.Reason != RestartReasonAlreadyHanded {
		t.Fatalf("its agent still works on it: %+v", held)
	}
	f.setRun("lead-block", molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateIdle, FirstName: "Arthur"})
	if again := f.askFinish(f.leadRequest()); again.Status != RestartSent || len(f.sentRequests()) != 2 {
		t.Fatalf("its agent stopped without pushing, the developer asks again: %+v sent %d", again, len(f.sentRequests()))
	}
}

// A new head is a new hand-off: the first one was about the old state.
func TestANewHeadIsANewHandOff(t *testing.T) {
	t.Parallel()
	f := makeGuardFixture(t, conflicting())
	f.arthurRuns()
	if first := f.askFinish(f.leadRequest()); first.Status != RestartSent {
		t.Fatalf("first: %+v", first)
	}
	next := conflicting()
	next.head = guardNewHead
	f.gh.set(next)
	req := f.leadRequest()
	req.HeadOid = guardNewHead
	res := f.askFinish(req)
	if res.Status != RestartSent || len(f.sentRequests()) != 2 {
		t.Fatalf("result: %+v sent %d", res, len(f.sentRequests()))
	}
}

// A hand-off that did not reach an agent (an offer to start one, a busy agent) is not remembered as handled.
func TestAnOfferIsNotAHandOff(t *testing.T) {
	t.Parallel()
	f := makeGuardFixture(t, conflicting())
	f.setRun("agent-term", molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateWorking, FirstName: "Bruno"})
	if res := f.askRebase(false); res.Status != RestartBusy || res.Reason != RestartReasonAgentBusy {
		t.Fatalf("busy: %+v", res)
	}
	f.setRun("agent-term", molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateIdle, FirstName: "Bruno"})
	if res := f.askRebase(false); res.Status != RestartSent {
		t.Fatalf("the agent is free now: %+v", res)
	}
}

// A request that waits for the lead's prompt carries what keeps it honest (#2145): one request per task, PR and head;
// asked again before it is typed or said to have expired, it applies only while the PR is open at that head with a
// problem left; and the action that sends it again.
func TestTheRequestToTheLeadCarriesWhatKeepsItHonest(t *testing.T) {
	t.Parallel()
	draft := conflicting()
	draft.draft = true
	f := makeGuardFixture(t, draft)
	f.arthurRuns()
	req := f.leadRequest()
	req.FailedChecks = []string{"build"}
	if res := f.askFinish(req); res.Status != RestartSent {
		t.Fatalf("result: %+v", res)
	}
	sent := f.sentRequests()
	if len(sent) != 1 {
		t.Fatalf("sent: %+v", sent)
	}
	app := sent[0]
	if app.Key != "finish|"+strings.ToLower(f.k.Repo)+"#9|"+rebaseHead {
		t.Errorf("key: %q", app.Key)
	}
	if app.Resend == nil || app.Resend.Gesture != ResendGesture || app.Resend.Args["task"] != HandoffFinish || app.Resend.Args["number"] != 9 ||
		app.Resend.Args["dir"] != f.dir || app.Resend.Args["markready"] != true || app.Resend.Args["leadname"] != "Arthur" ||
		app.Resend.LabelText == nil || app.Resend.LabelText.Code != "notif.review.resend" {
		t.Errorf("resend: %+v", app.Resend)
	}
	applies := func() bool { return app.Applies(context.Background()) }
	if !applies() {
		t.Error("the PR is as the request said")
	}
	merged := conflicting()
	merged.state = "MERGED"
	f.gh.set(merged)
	if applies() {
		t.Error("a merged PR needs nothing")
	}
	moved := conflicting()
	moved.head = guardNewHead
	f.gh.set(moved)
	if applies() {
		t.Error("a head that moved is another state")
	}
	fixed := guardState{state: "OPEN", head: rebaseHead, mergeable: "MERGEABLE", mergeState: "CLEAN", rollup: guardOkRoll}
	f.gh.set(fixed)
	if applies() {
		t.Error("every problem is gone")
	}
	f.gh.set(conflicting())
	f.gh.err = errors.New("HTTP 502")
	if !applies() {
		t.Error("GitHub not answering proves nothing")
	}
}

// A request queued for a busy lead stays handled until it leaves the handoffs' queue, however long that takes: the
// repeated clicks of the two minutes after it were what queued eight requests for one lead.
func TestAQueuedHandOffIsHandledUntilItLeavesTheQueue(t *testing.T) {
	t.Parallel()
	f := makeGuardFixture(t, conflicting())
	f.arthurRuns()
	f.sendOut.Status = agenthandoff.StatusQueued
	var queued atomic.Bool
	queued.Store(true)
	f.r.env.HandoffQueued = func(blockId string) bool { return blockId == "lead-block" && queued.Load() }
	if first := f.askFinish(f.leadRequest()); first.Status != RestartQueued {
		t.Fatalf("first: %+v", first)
	}
	f.advance(handedWindow + 10*time.Minute)
	if held := f.askFinish(f.leadRequest()); held.Reason != RestartReasonAlreadyHanded {
		t.Fatalf("it still waits in the queue: %+v", held)
	}
	queued.Store(false)
	if again := f.askFinish(f.leadRequest()); again.Status != RestartQueued || len(f.sentRequests()) != 2 {
		t.Fatalf("it left the queue without being delivered: %+v sent %d", again, len(f.sentRequests()))
	}
}

// The agent MoltenTerm follows pushed: the list is told once per pushed head, so it reads the PR at once.
func TestAFollowedAgentsPushIsToldToTheList(t *testing.T) {
	t.Parallel()
	f, follow, st := followFixture(t)
	var mu sync.Mutex
	var told []pushNote
	f.r.env.PushSeen = func(dir string, branch string, oid string) {
		mu.Lock()
		defer mu.Unlock()
		told = append(told, pushNote{dir, branch, oid})
	}
	f.r.followStep(context.Background(), follow, st)
	f.commitIn(follow.tree, "c.txt")
	f.git(follow.tree, "push", "--quiet", "origin", "feature/9-fix-x")
	head := f.git(follow.tree, "rev-parse", "HEAD")
	f.write(follow.tree, "draft.txt", "unsaved\n")
	for i := 0; i < 3; i++ {
		f.setAgent(molten.AgentStateDone, int64(10+i))
		f.r.followStep(context.Background(), follow, st)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(told) != 1 || told[0] != (pushNote{f.dir, "feature/9-fix-x", head}) {
		t.Fatalf("the push is told once: %+v", told)
	}
}
