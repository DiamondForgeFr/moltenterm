// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

const testRepo = "owner/name"

var oidA = strings.Repeat("a", 40)
var oidB = strings.Repeat("b", 40)
var oidC = strings.Repeat("c", 40)

type fakePr struct {
	State      string
	Draft      bool
	Head       string
	Mergeable  string
	MergeState string
	Checks     []map[string]string
	MergeOid   string
}

func (p fakePr) json() []byte {
	data := map[string]any{
		"number":                  7,
		"title":                   "Add a thing",
		"url":                     "https://github.com/owner/name/pull/7",
		"state":                   p.State,
		"isDraft":                 p.Draft,
		"headRefName":             "feature/7-thing",
		"baseRefName":             "develop",
		"headRefOid":              p.Head,
		"mergeable":               p.Mergeable,
		"mergeStateStatus":        p.MergeState,
		"statusCheckRollup":       p.Checks,
		"closingIssuesReferences": []map[string]int{{"number": 590}},
	}
	if p.MergeOid != "" {
		data["mergeCommit"] = map[string]string{"oid": p.MergeOid}
	}
	out, _ := json.Marshal(data)
	return out
}

func green(names ...string) []map[string]string {
	var rtn []map[string]string
	for _, n := range names {
		rtn = append(rtn, map[string]string{"name": n, "status": "COMPLETED", "conclusion": "SUCCESS"})
	}
	return rtn
}

func cleanPr() fakePr {
	return fakePr{State: "OPEN", Head: oidA, Mergeable: "MERGEABLE", MergeState: "CLEAN", Checks: append(green("build"), map[string]string{"context": "local-tests", "state": "SUCCESS"})}
}

// fakeGh answers gh pr view from a script of PR states (the last one repeats) and records the other calls.
type fakeGh struct {
	lock     sync.Mutex
	views    []fakePr
	viewed   int
	calls    [][]string
	mergeErr error
	// onCall changes the views when a write is made (GitHub rebasing the branch).
	onCall func(g *fakeGh, args []string)
}

func (g *fakeGh) run(ctx context.Context, dir string, args ...string) ([]byte, error) {
	g.lock.Lock()
	defer g.lock.Unlock()
	if len(args) < 2 || args[len(args)-2] != "--repo" || args[len(args)-1] != testRepo {
		return nil, fmt.Errorf("gh called without --repo: %v", args)
	}
	if args[0] == "pr" && args[1] == "view" {
		i := g.viewed
		if i >= len(g.views) {
			i = len(g.views) - 1
		}
		g.viewed++
		return g.views[i].json(), nil
	}
	g.calls = append(g.calls, args)
	if g.onCall != nil {
		g.onCall(g, args)
	}
	if args[0] == "pr" && args[1] == "merge" {
		return nil, g.mergeErr
	}
	return nil, nil
}

func (g *fakeGh) writes() [][]string {
	g.lock.Lock()
	defer g.lock.Unlock()
	return append([][]string{}, g.calls...)
}

type fakeHook struct {
	lock    sync.Mutex
	planned int
	runs    []MergedPr
}

func (h *fakeHook) Plan(ctx context.Context, pr MergedPr) []CleanupStep {
	h.lock.Lock()
	defer h.lock.Unlock()
	h.planned++
	return []CleanupStep{{Id: "ticket", Label: fmt.Sprintf("Close #%d", pr.Ticket), State: CleanupPlanned}}
}

func (h *fakeHook) Run(ctx context.Context, pr MergedPr, report func(steps []CleanupStep)) []CleanupStep {
	h.lock.Lock()
	h.runs = append(h.runs, pr)
	h.lock.Unlock()
	report([]CleanupStep{{Id: "ticket", Label: "Close", State: CleanupPlanned}})
	return []CleanupStep{{Id: "ticket", Label: "Close", State: CleanupDone}}
}

func testMerger(t *testing.T, gh *fakeGh) (*Merger, string, *[]State) {
	t.Helper()
	dir := t.TempDir()
	var published []State
	var lock sync.Mutex
	m := MakeMerger(MakeStore(dir), gh.run, func(k PrKey, state State) {
		lock.Lock()
		defer lock.Unlock()
		published = append(published, state)
	})
	m.pollEvery = time.Millisecond
	return m, dir, &published
}

var testKey = PrKey{Repo: testRepo, Number: 7}

func planReq(dir string) MergePlanRequest {
	return MergePlanRequest{PrKey: testKey, Dir: dir}
}

func checkOf(plan MergePlan, id string) MergeCheck {
	for _, c := range plan.Checks {
		if c.Id == id {
			return c
		}
	}
	return MergeCheck{}
}

func TestMergePlanClean(t *testing.T) {
	hook := &fakeHook{}
	SetPostMerge(hook)
	defer SetPostMerge(nil)
	gh := &fakeGh{views: []fakePr{cleanPr()}}
	m, dir, _ := testMerger(t, gh)
	plan, err := m.Plan(context.Background(), planReq(dir))
	if err != nil {
		t.Fatal(err)
	}
	if !plan.CanMerge || plan.Reason != "" || len(plan.Warnings) != 0 {
		t.Fatalf("plan should allow the merge: %+v", plan)
	}
	if plan.HeadOid != oidA || plan.Ticket != 590 || plan.Behind {
		t.Errorf("plan: %+v", plan)
	}
	if ci := checkOf(plan, CheckIdCi); ci.State != CheckOk || !strings.Contains(ci.Detail, "2 passed, 1 of them local") {
		t.Errorf("ci check: %+v", ci)
	}
	if len(plan.Steps) != 1 || plan.Steps[0].Id != StepMerge || !strings.Contains(plan.Steps[0].Detail, "aaaaaaa") {
		t.Errorf("steps: %+v", plan.Steps)
	}
	if len(plan.Cleanup) != 1 || plan.Cleanup[0].Label != "Close #590" {
		t.Errorf("cleanup from the hook: %+v", plan.Cleanup)
	}
	if len(gh.writes()) != 0 {
		t.Errorf("a plan writes nothing: %v", gh.writes())
	}
}

func TestMergePlanBlocks(t *testing.T) {
	cases := []struct {
		name   string
		change func(p *fakePr)
		check  string
		state  string
	}{
		{"failing check", func(p *fakePr) {
			p.Checks = append(p.Checks, map[string]string{"name": "lint", "status": "COMPLETED", "conclusion": "FAILURE"})
			p.MergeState = "UNSTABLE"
		}, CheckIdCi, CheckFail},
		{"pending check", func(p *fakePr) {
			p.Checks = append(p.Checks, map[string]string{"name": "lint", "status": "IN_PROGRESS"})
		}, CheckIdCi, CheckPending},
		{"conflict", func(p *fakePr) { p.Mergeable = "CONFLICTING"; p.MergeState = "DIRTY" }, CheckIdConflict, CheckFail},
		{"blocked", func(p *fakePr) { p.MergeState = "BLOCKED" }, CheckIdBlocked, CheckFail},
		{"draft", func(p *fakePr) { p.Draft = true; p.MergeState = "DRAFT" }, CheckIdOpen, CheckFail},
		{"unknown mergeability", func(p *fakePr) { p.Mergeable = "UNKNOWN"; p.MergeState = "UNKNOWN" }, CheckIdConflict, CheckPending},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pr := cleanPr()
			tc.change(&pr)
			gh := &fakeGh{views: []fakePr{pr}}
			m, dir, _ := testMerger(t, gh)
			plan, err := m.Plan(context.Background(), planReq(dir))
			if err != nil {
				t.Fatal(err)
			}
			if plan.CanMerge || plan.Reason == "" {
				t.Fatalf("merge should be disabled with a reason: %+v", plan)
			}
			if c := checkOf(plan, tc.check); c.State != tc.state {
				t.Errorf("check %s: %+v", tc.check, c)
			}
			if _, err := m.Merge(MergeRequest{PrKey: testKey, PlanId: plan.Id}); err == nil {
				t.Errorf("a blocked plan must not merge")
			}
			if len(gh.writes()) != 0 {
				t.Errorf("nothing written: %v", gh.writes())
			}
		})
	}
}

func writeComments(t *testing.T, dir string, states ...string) {
	t.Helper()
	var comments []map[string]string
	for _, s := range states {
		comments = append(comments, map[string]string{"state": s, "id": s})
	}
	data, _ := json.Marshal(map[string]any{"repo": testRepo, "number": 7, "comments": comments})
	file := filepath.Join(dir, "molten", "reviews", RepoKey(testRepo), "7.json")
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestMergeUnpublishedCommentIsAWarning(t *testing.T) {
	gh := &fakeGh{views: []fakePr{cleanPr()}}
	m, dir, _ := testMerger(t, gh)
	writeComments(t, dir, "staged", "published", "dropped", "draft")
	plan, err := m.Plan(context.Background(), planReq(dir))
	if err != nil {
		t.Fatal(err)
	}
	if !plan.CanMerge || len(plan.Warnings) != 1 || plan.Warnings[0] != CheckIdComments {
		t.Fatalf("warning expected: %+v", plan)
	}
	if c := checkOf(plan, CheckIdComments); !strings.HasPrefix(c.Detail, "2 comment(s)") {
		t.Errorf("comments: %+v", c)
	}
	if _, err := m.Merge(MergeRequest{PrKey: testKey, PlanId: plan.Id}); err == nil || !strings.Contains(err.Error(), "warnings") {
		t.Fatalf("merge without the override must be refused: %v", err)
	}
	rec, err := m.Merge(MergeRequest{PrKey: testKey, PlanId: plan.Id, Override: true})
	if err != nil {
		t.Fatal(err)
	}
	m.wait(testKey)
	state, _ := m.store.Get(testKey)
	if state.Merge == nil || state.Merge.State != MergeMerged || len(state.Merge.Overridden) != 1 || rec.PlanHead != oidA {
		t.Fatalf("merged with the override recorded: %+v", state.Merge)
	}
}

func TestMergeRebaseBoundToHead(t *testing.T) {
	hook := &fakeHook{}
	SetPostMerge(hook)
	defer SetPostMerge(nil)
	merged := cleanPr()
	merged.State = "MERGED"
	merged.MergeOid = oidC
	gh := &fakeGh{views: []fakePr{cleanPr(), cleanPr(), merged}}
	m, dir, published := testMerger(t, gh)
	plan, err := m.Plan(context.Background(), planReq(dir))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Merge(MergeRequest{PrKey: testKey, PlanId: plan.Id}); err != nil {
		t.Fatal(err)
	}
	m.wait(testKey)
	writes := gh.writes()
	if len(writes) != 1 {
		t.Fatalf("one merge call: %v", writes)
	}
	want := "pr merge 7 --rebase --delete-branch --match-head-commit " + oidA + " --repo " + testRepo
	if got := strings.Join(writes[0], " "); got != want {
		t.Errorf("merge call:\n got %s\nwant %s", got, want)
	}
	state, _ := m.store.Get(testKey)
	rec := state.Merge
	if rec == nil || rec.State != MergeMerged || rec.MergedOid != oidC || rec.Head != oidA || rec.EndedAt == 0 {
		t.Fatalf("record: %+v", rec)
	}
	if rec.CleanupRunning || len(rec.Cleanup) != 1 || rec.Cleanup[0].State != CleanupDone {
		t.Errorf("cleanup outcome kept: %+v", rec)
	}
	if len(hook.runs) != 1 || hook.runs[0].Ticket != 590 || hook.runs[0].HeadOid != oidA || hook.runs[0].MergedOid != oidC {
		t.Errorf("hook called once with the merged PR: %+v", hook.runs)
	}
	if len(*published) < 3 {
		t.Errorf("progress published: %d", len(*published))
	}
	if _, err := m.Merge(MergeRequest{PrKey: testKey, PlanId: plan.Id}); err == nil {
		t.Errorf("a plan is used once")
	}
}

func TestMergeRefusedAfterAPush(t *testing.T) {
	hook := &fakeHook{}
	SetPostMerge(hook)
	defer SetPostMerge(nil)
	pushed := cleanPr()
	pushed.Head = oidB
	gh := &fakeGh{views: []fakePr{cleanPr(), pushed}}
	m, dir, _ := testMerger(t, gh)
	plan, err := m.Plan(context.Background(), planReq(dir))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Merge(MergeRequest{PrKey: testKey, PlanId: plan.Id}); err != nil {
		t.Fatal(err)
	}
	m.wait(testKey)
	state, _ := m.store.Get(testKey)
	if state.Merge.State != MergeRefused || state.Merge.Refused != RefusedHeadMoved || !strings.Contains(state.Merge.Message, "review them") {
		t.Fatalf("refused on the push: %+v", state.Merge)
	}
	if len(gh.writes()) != 0 || len(hook.runs) != 0 {
		t.Errorf("nothing merged, no cleanup: %v %v", gh.writes(), hook.runs)
	}
}

func TestMergeGithubRefusalIsNotRetried(t *testing.T) {
	hook := &fakeHook{}
	SetPostMerge(hook)
	defer SetPostMerge(nil)
	gh := &fakeGh{views: []fakePr{cleanPr()}, mergeErr: fmt.Errorf("gh pr merge: GraphQL: Head branch was modified. Review and try the merge again. ghp_abcdefghijklmnopqrstuvwxyz0123456789")}
	m, dir, _ := testMerger(t, gh)
	plan, _ := m.Plan(context.Background(), planReq(dir))
	if _, err := m.Merge(MergeRequest{PrKey: testKey, PlanId: plan.Id}); err != nil {
		t.Fatal(err)
	}
	m.wait(testKey)
	state, _ := m.store.Get(testKey)
	if state.Merge.State != MergeRefused || state.Merge.Refused != RefusedHeadMoved {
		t.Fatalf("refused: %+v", state.Merge)
	}
	if len(gh.writes()) != 1 || len(hook.runs) != 0 {
		t.Errorf("one try, no cleanup: %v", gh.writes())
	}
	gh2 := &fakeGh{views: []fakePr{cleanPr()}, mergeErr: fmt.Errorf("gh pr merge: token ghp_abcdefghijklmnopqrstuvwxyz0123456789 rejected")}
	m2, dir2, _ := testMerger(t, gh2)
	plan2, _ := m2.Plan(context.Background(), planReq(dir2))
	m2.Merge(MergeRequest{PrKey: testKey, PlanId: plan2.Id})
	m2.wait(testKey)
	state2, _ := m2.store.Get(testKey)
	if state2.Merge.State != MergeFailed || strings.Contains(state2.Merge.Message, "ghp_") || !strings.Contains(state2.Merge.Message, "<github-token>") {
		t.Fatalf("failed with the token masked: %+v", state2.Merge)
	}
	if len(gh2.writes()) != 1 {
		t.Errorf("never retried: %v", gh2.writes())
	}
}

func TestMergeBehindUpdatesThenWaitsForCi(t *testing.T) {
	SetPostMerge(nil)
	behind := cleanPr()
	behind.MergeState = "BEHIND"
	rebasedPending := cleanPr()
	rebasedPending.Head = oidB
	rebasedPending.MergeState = "BLOCKED"
	rebasedPending.Checks = []map[string]string{{"name": "build", "status": "IN_PROGRESS"}}
	rebasedGreen := cleanPr()
	rebasedGreen.Head = oidB
	gh := &fakeGh{views: []fakePr{behind, behind, behind}}
	gh.onCall = func(g *fakeGh, args []string) {
		if args[1] == "update-branch" {
			// GitHub rebases: the first read still shows the old head, then CI runs on the new one and passes.
			g.views = append(g.views[:g.viewed], behind, rebasedPending, rebasedPending, rebasedGreen)
		}
	}
	m, dir, _ := testMerger(t, gh)
	plan, err := m.Plan(context.Background(), planReq(dir))
	if err != nil {
		t.Fatal(err)
	}
	if !plan.Behind || !plan.CanMerge || len(plan.Steps) != 3 || plan.Steps[0].Id != StepUpdate || plan.Steps[1].Id != StepWaitCi {
		t.Fatalf("plan says GitHub rebases first: %+v", plan)
	}
	if c := checkOf(plan, CheckIdBehind); c.State != CheckInfo {
		t.Errorf("behind: %+v", c)
	}
	if _, err := m.Merge(MergeRequest{PrKey: testKey, PlanId: plan.Id}); err != nil {
		t.Fatal(err)
	}
	m.wait(testKey)
	writes := gh.writes()
	if len(writes) != 2 || writes[0][1] != "update-branch" || strings.Join(writes[0], " ") != "pr update-branch 7 --rebase --repo "+testRepo {
		t.Fatalf("update then merge: %v", writes)
	}
	if !strings.Contains(strings.Join(writes[1], " "), "--match-head-commit "+oidB) {
		t.Errorf("the merge is bound to the rebased head: %v", writes[1])
	}
	state, _ := m.store.Get(testKey)
	if state.Merge.State != MergeMerged || !state.Merge.Updated || state.Merge.Head != oidB || state.Merge.PlanHead != oidA {
		t.Errorf("record: %+v", state.Merge)
	}
}

func TestMergeBehindRefusesAnotherPush(t *testing.T) {
	SetPostMerge(nil)
	behind := cleanPr()
	behind.MergeState = "BEHIND"
	rebased := cleanPr()
	rebased.Head = oidB
	rebased.Checks = []map[string]string{{"name": "build", "status": "IN_PROGRESS"}}
	pushed := cleanPr()
	pushed.Head = oidC
	gh := &fakeGh{views: []fakePr{behind, behind}}
	gh.onCall = func(g *fakeGh, args []string) {
		if args[1] == "update-branch" {
			g.views = append(g.views[:g.viewed], rebased, pushed)
		}
	}
	m, dir, _ := testMerger(t, gh)
	plan, _ := m.Plan(context.Background(), planReq(dir))
	m.Merge(MergeRequest{PrKey: testKey, PlanId: plan.Id})
	m.wait(testKey)
	state, _ := m.store.Get(testKey)
	if state.Merge.State != MergeRefused || state.Merge.Refused != RefusedHeadMoved {
		t.Fatalf("refused: %+v", state.Merge)
	}
	if len(gh.writes()) != 1 {
		t.Errorf("only the update, no merge: %v", gh.writes())
	}
}

func TestMergeBehindCiFailsOrCancel(t *testing.T) {
	SetPostMerge(nil)
	behind := cleanPr()
	behind.MergeState = "BEHIND"
	failing := cleanPr()
	failing.Head = oidB
	failing.Checks = []map[string]string{{"name": "build", "status": "COMPLETED", "conclusion": "FAILURE"}}
	gh := &fakeGh{views: []fakePr{behind, behind}}
	gh.onCall = func(g *fakeGh, args []string) {
		if args[1] == "update-branch" {
			g.views = append(g.views[:g.viewed], failing)
		}
	}
	m, dir, _ := testMerger(t, gh)
	plan, _ := m.Plan(context.Background(), planReq(dir))
	m.Merge(MergeRequest{PrKey: testKey, PlanId: plan.Id})
	m.wait(testKey)
	state, _ := m.store.Get(testKey)
	if state.Merge.State != MergeFailed || !strings.Contains(state.Merge.Message, "CI failed on the rebased head") {
		t.Fatalf("failed: %+v", state.Merge)
	}

	pending := cleanPr()
	pending.Head = oidB
	pending.Checks = []map[string]string{{"name": "build", "status": "IN_PROGRESS"}}
	gh2 := &fakeGh{views: []fakePr{behind, behind}}
	gh2.onCall = func(g *fakeGh, args []string) {
		if args[1] == "update-branch" {
			g.views = append(g.views[:g.viewed], pending)
		}
	}
	m2, dir2, _ := testMerger(t, gh2)
	m2.pollEvery = 20 * time.Millisecond
	plan2, _ := m2.Plan(context.Background(), planReq(dir2))
	m2.Merge(MergeRequest{PrKey: testKey, PlanId: plan2.Id})
	time.Sleep(60 * time.Millisecond)
	if err := m2.Cancel(testKey); err != nil {
		t.Fatal(err)
	}
	m2.wait(testKey)
	state2, _ := m2.store.Get(testKey)
	if state2.Merge.State != MergeCancelled || len(gh2.writes()) != 1 {
		t.Fatalf("cancelled before the merge: %+v %v", state2.Merge, gh2.writes())
	}
}

func TestMergePlanExpiresAndIsReplaced(t *testing.T) {
	gh := &fakeGh{views: []fakePr{cleanPr()}}
	m, dir, _ := testMerger(t, gh)
	first, _ := m.Plan(context.Background(), planReq(dir))
	second, _ := m.Plan(context.Background(), planReq(dir))
	if _, err := m.Merge(MergeRequest{PrKey: testKey, PlanId: first.Id}); err == nil {
		t.Errorf("an older plan is not current")
	}
	now := time.Now()
	m.now = func() time.Time { return now.Add(planMaxAge + time.Minute) }
	if _, err := m.Merge(MergeRequest{PrKey: testKey, PlanId: second.Id}); err == nil || !strings.Contains(err.Error(), "old") {
		t.Errorf("an old plan is refused: %v", err)
	}
	if len(gh.writes()) != 0 {
		t.Errorf("nothing written: %v", gh.writes())
	}
}

func TestMergeRestartInFlightWarns(t *testing.T) {
	gh := &fakeGh{views: []fakePr{cleanPr()}}
	m, dir, _ := testMerger(t, gh)
	m.store.update(testKey, func(state *State) bool {
		state.Rounds = append(state.Rounds, Round{Id: "r1", HeadOid: oidA, PublishedAt: 1, RestartedAt: 2})
		return true
	})
	plan, _ := m.Plan(context.Background(), planReq(dir))
	if c := checkOf(plan, CheckIdRestart); c.State != CheckWarn || !plan.CanMerge {
		t.Errorf("restart in flight is a warning: %+v", plan)
	}
}

func TestMergeCommandsAreWindowOnly(t *testing.T) {
	gh := &fakeGh{views: []fakePr{cleanPr()}}
	service := MakeService(t.TempDir(), nil, nil)
	service.merger.gh = gh.run
	link := &routeLink{service: service}
	terminal := wshutil.RoutePrefix_Proc + "x"
	for _, command := range []string{MergePlanCommand, MergeCommand, MergeCancelCommand} {
		if _, err := link.handle(context.Background(), command, terminal, map[string]any{"repo": testRepo, "number": 7, "dir": "/tmp"}); err == nil {
			t.Errorf("%s answered a terminal", command)
		}
	}
	window := wshutil.RoutePrefix_Tab + "x"
	data, err := link.handle(context.Background(), MergePlanCommand, window, map[string]any{"repo": testRepo, "number": 7, "dir": "/tmp"})
	if err != nil {
		t.Fatal(err)
	}
	if plan := data.(MergePlan); !plan.CanMerge {
		t.Errorf("plan from a window: %+v", plan)
	}
	if len(gh.writes()) != 0 {
		t.Errorf("nothing written: %v", gh.writes())
	}
}
