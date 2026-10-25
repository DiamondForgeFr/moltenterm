// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func onlyMethod(method string) string {
	return fmt.Sprintf(`{"allow_merge_commit":%t,"allow_squash_merge":%t,"allow_rebase_merge":%t}`,
		method == MergeMethodMerge, method == MergeMethodSquash, method == MergeMethodRebase)
}

const allAllowed = `{"allow_merge_commit":true,"allow_squash_merge":true,"allow_rebase_merge":true}`

func mergeCall(t *testing.T, gh *fakeGh) string {
	t.Helper()
	for _, w := range gh.writes() {
		if w[1] == "merge" {
			return strings.Join(w, " ")
		}
	}
	t.Fatalf("no merge call: %v", gh.writes())
	return ""
}

// AC1: a repository that allows one method gets only that one, and the merge uses it.
func TestMergeUsesTheOnlyAllowedMethod(t *testing.T) {
	SetPostMerge(nil)
	for _, method := range allMergeMethods {
		t.Run(method, func(t *testing.T) {
			gh := &fakeGh{views: []fakePr{cleanPr()}, repo: onlyMethod(method)}
			m, dir, _ := testMerger(t, gh)
			plan, err := m.Plan(context.Background(), planReq(dir))
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(plan.Methods, []string{method}) || plan.Method != method {
				t.Fatalf("methods %v, default %s", plan.Methods, plan.Method)
			}
			if _, err := m.Merge(MergeRequest{PrKey: testKey, PlanId: plan.Id}); err != nil {
				t.Fatal(err)
			}
			m.wait(testKey)
			want := "pr merge 7 --" + method + " --match-head-commit " + oidA + " --repo " + testRepo
			if got := mergeCall(t, gh); got != want {
				t.Errorf("merge call:\n got %s\nwant %s", got, want)
			}
			state, _ := m.store.Get(testKey)
			if state.Merge.State != MergeMerged || state.Merge.Method != method {
				t.Errorf("record: %+v", state.Merge)
			}
		})
	}
}

// AC2: the last method used for the repository is the next default; a method the plan does not offer is refused.
func TestMergeRemembersTheLastMethod(t *testing.T) {
	SetPostMerge(nil)
	gh := &fakeGh{views: []fakePr{cleanPr()}, repo: allAllowed}
	m, dir, _ := testMerger(t, gh)
	plan, err := m.Plan(context.Background(), planReq(dir))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(plan.Methods, allMergeMethods) || plan.Method != MergeMethodMerge {
		t.Fatalf("GitHub's order without a last method: %v %s", plan.Methods, plan.Method)
	}
	if _, err := m.Merge(MergeRequest{PrKey: testKey, PlanId: plan.Id, Method: "octopus"}); err == nil || err.Error() != mergeErrorPrefix+MergeErrMethod {
		t.Fatalf("an unknown method is refused: %v", err)
	}
	if _, err := m.Merge(MergeRequest{PrKey: testKey, PlanId: plan.Id, Method: MergeMethodSquash}); err != nil {
		t.Fatal(err)
	}
	m.wait(testKey)
	if got := mergeCall(t, gh); !strings.Contains(got, " --squash ") {
		t.Errorf("squash merge: %s", got)
	}
	if last, _ := m.store.LastMergeMethod(testRepo); last != MergeMethodSquash {
		t.Errorf("last method kept: %q", last)
	}

	gh2 := &fakeGh{views: []fakePr{cleanPr()}, repo: allAllowed}
	m2 := MakeMerger(m.store, gh2.run, nil)
	again, err := m2.Plan(context.Background(), planReq(dir))
	if err != nil {
		t.Fatal(err)
	}
	if again.Method != MergeMethodSquash {
		t.Errorf("the last method is preselected: %s", again.Method)
	}
	gh3 := &fakeGh{views: []fakePr{cleanPr()}, repo: onlyMethod(MergeMethodRebase)}
	m3 := MakeMerger(m.store, gh3.run, nil)
	rebaseOnly, _ := m3.Plan(context.Background(), planReq(dir))
	if rebaseOnly.Method != MergeMethodRebase {
		t.Errorf("a last method no longer allowed is not offered: %s", rebaseOnly.Method)
	}
	if _, err := m3.Merge(MergeRequest{PrKey: testKey, PlanId: rebaseOnly.Id, Method: MergeMethodSquash}); err == nil {
		t.Errorf("a method the repository does not allow is refused")
	}
}

// AC2: a branch behind its base is rebased for a rebase merge and takes a merge of the base otherwise.
func TestMergeUpdateFollowsTheMethod(t *testing.T) {
	SetPostMerge(nil)
	for method, want := range map[string]string{
		MergeMethodRebase: "pr update-branch 7 --rebase --repo " + testRepo,
		MergeMethodSquash: "pr update-branch 7 --repo " + testRepo,
		MergeMethodMerge:  "pr update-branch 7 --repo " + testRepo,
	} {
		t.Run(method, func(t *testing.T) {
			behind := cleanPr()
			behind.MergeState = "BEHIND"
			updated := cleanPr()
			updated.Head = oidB
			gh := &fakeGh{views: []fakePr{behind, behind}, repo: allAllowed}
			gh.onCall = func(g *fakeGh, args []string) {
				if args[1] == "update-branch" {
					g.views = append(g.views[:g.viewed], updated)
				}
			}
			m, dir, _ := testMerger(t, gh)
			plan, _ := m.Plan(context.Background(), planReq(dir))
			if _, err := m.Merge(MergeRequest{PrKey: testKey, PlanId: plan.Id, Method: method}); err != nil {
				t.Fatal(err)
			}
			m.wait(testKey)
			writes := gh.writes()
			if len(writes) != 2 || strings.Join(writes[0], " ") != want {
				t.Fatalf("update call: %v", writes)
			}
			if !strings.Contains(strings.Join(writes[1], " "), "--"+method+" --match-head-commit "+oidB) {
				t.Errorf("merge call: %v", writes[1])
			}
		})
	}
}

func TestChooseMethods(t *testing.T) {
	all := repoMethods{methods: allMergeMethods}
	cases := []struct {
		name    string
		repo    repoMethods
		rules   branchRules
		last    string
		methods []string
		method  string
		rule    string
	}{
		{"github order", all, branchRules{}, "", allMergeMethods, MergeMethodMerge, ""},
		{"last used", all, branchRules{}, MergeMethodRebase, allMergeMethods, MergeMethodRebase, ""},
		{"ruleset", all, branchRules{allowed: []string{MergeMethodSquash}}, MergeMethodRebase, []string{MergeMethodSquash}, MergeMethodSquash, MethodRuleRuleset},
		{"linear history", all, branchRules{linear: true}, MergeMethodMerge, []string{MergeMethodSquash, MergeMethodRebase}, MergeMethodSquash, MethodRuleLinear},
		{"queue", all, branchRules{queue: MergeMethodRebase}, MergeMethodMerge, []string{MergeMethodRebase}, MergeMethodRebase, MethodRuleQueue},
	}
	for _, c := range cases {
		got := chooseMethods(c.repo, c.rules, c.last)
		if !reflect.DeepEqual(got.methods, c.methods) || got.method != c.method || got.rule != c.rule {
			t.Errorf("%s: %+v", c.name, got)
		}
	}
	rules, err := parseBranchRules([]byte(`[{"type":"pull_request","parameters":{"allowed_merge_methods":["squash","rebase"]}},{"type":"required_linear_history"},{"type":"merge_queue","parameters":{"merge_method":"SQUASH"}}]`))
	if err != nil || !rules.linear || rules.queue != MergeMethodSquash || !reflect.DeepEqual(rules.allowed, []string{MergeMethodSquash, MergeMethodRebase}) {
		t.Errorf("rules: %+v %v", rules, err)
	}
	repo, err := parseRepoMethods([]byte(`{"allow_merge_commit":false,"allow_squash_merge":true}`))
	if err != nil || !reflect.DeepEqual(repo.methods, []string{MergeMethodSquash, MergeMethodRebase}) {
		t.Errorf("a field GitHub leaves out counts as allowed: %+v %v", repo, err)
	}
}

// What GitHub said is kept for the session; a failed read is not, and a refused merge drops it.
func TestMergeMethodsAreCached(t *testing.T) {
	SetPostMerge(nil)
	gh := &fakeGh{views: []fakePr{cleanPr()}, repoErr: errors.New("HTTP 404")}
	m, dir, _ := testMerger(t, gh)
	plan, err := m.Plan(context.Background(), planReq(dir))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(plan.Methods, allMergeMethods) {
		t.Errorf("an unreadable repository offers every method: %v", plan.Methods)
	}
	gh.repoErr = nil
	gh.repo = onlyMethod(MergeMethodSquash)
	plan, _ = m.Plan(context.Background(), planReq(dir))
	m.Plan(context.Background(), planReq(dir))
	if !reflect.DeepEqual(plan.Methods, []string{MergeMethodSquash}) {
		t.Errorf("read again after a failure: %v", plan.Methods)
	}
	repoReads := 0
	for _, call := range gh.apiCalls {
		if call == "repos/"+testRepo {
			repoReads++
		}
	}
	if repoReads != 2 {
		t.Errorf("one failed read, then one kept: %v", gh.apiCalls)
	}
	if !strings.HasSuffix(gh.apiCalls[1], "/rules/branches/develop") {
		t.Errorf("the base's rules are read: %v", gh.apiCalls)
	}
	gh.mergeErr = errors.New("Merge method squash merging is not allowed on this repository")
	plan, _ = m.Plan(context.Background(), planReq(dir))
	m.Merge(MergeRequest{PrKey: testKey, PlanId: plan.Id})
	m.wait(testKey)
	if _, ok := m.cachedRepo(testRepo); ok {
		t.Errorf("a refused merge drops what GitHub said")
	}
}

// A merge queue sets the method and brings the branch up to date itself; Validate waits until it merged.
func TestMergeQueue(t *testing.T) {
	SetPostMerge(nil)
	behind := cleanPr()
	behind.MergeState = "BEHIND"
	merged := cleanPr()
	merged.State = "MERGED"
	merged.MergeOid = oidC
	gh := &fakeGh{views: []fakePr{behind, behind, behind, behind, merged}, repo: allAllowed, queue: true,
		rules: `[{"type":"merge_queue","parameters":{"merge_method":"SQUASH"}}]`}
	m, dir, published := testMerger(t, gh)
	plan, err := m.Plan(context.Background(), planReq(dir))
	if err != nil {
		t.Fatal(err)
	}
	if !plan.Queue || plan.MethodRule != MethodRuleQueue || !reflect.DeepEqual(plan.Methods, []string{MergeMethodSquash}) || len(plan.Steps) != 1 {
		t.Fatalf("queue plan: %+v", plan)
	}
	if _, err := m.Merge(MergeRequest{PrKey: testKey, PlanId: plan.Id}); err != nil {
		t.Fatal(err)
	}
	m.wait(testKey)
	writes := gh.writes()
	want := "pr merge 7 --squash --match-head-commit " + oidA + " --repo " + testRepo
	if len(writes) != 1 || strings.Join(writes[0], " ") != want {
		t.Fatalf("one merge call, no update: %v", writes)
	}
	state, _ := m.store.Get(testKey)
	if state.Merge.State != MergeMerged || state.Merge.MergedOid != oidC {
		t.Errorf("record: %+v", state.Merge)
	}
	queued := false
	for _, s := range *published {
		if s.Merge != nil && s.Merge.State == MergeQueued {
			queued = true
		}
	}
	if !queued {
		t.Errorf("the queued state was published")
	}
}

// A PR that leaves the queue closed, or with new commits, ends the wait.
func TestMergeQueueEnds(t *testing.T) {
	SetPostMerge(nil)
	closed := cleanPr()
	closed.State = "CLOSED"
	pushed := cleanPr()
	pushed.Head = oidB
	for name, view := range map[string]fakePr{"closed": closed, "pushed": pushed} {
		t.Run(name, func(t *testing.T) {
			gh := &fakeGh{views: []fakePr{cleanPr(), cleanPr(), cleanPr(), view}, queue: true}
			m, dir, _ := testMerger(t, gh)
			plan, _ := m.Plan(context.Background(), planReq(dir))
			m.Merge(MergeRequest{PrKey: testKey, PlanId: plan.Id})
			m.wait(testKey)
			state, _ := m.store.Get(testKey)
			if name == "closed" && (state.Merge.State != MergeFailed || state.Merge.Code != MergeCodeQueueClosed) {
				t.Errorf("closed: %+v", state.Merge)
			}
			if name == "pushed" && (state.Merge.State != MergeRefused || state.Merge.Refused != RefusedHeadMoved) {
				t.Errorf("pushed: %+v", state.Merge)
			}
		})
	}
}
