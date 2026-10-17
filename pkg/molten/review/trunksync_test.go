// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"maps"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// The local working branch after a merge (#909): the cleanup fixture's main checkout is on develop, two commits behind
// origin/develop (the merged PR and another commit), with the agent's worktree on feature/7-thing.

type trunkNotices struct {
	lock     sync.Mutex
	inputs   []molten.NotificationInput
	resolved []string
}

func (n *trunkNotices) notify(ctx context.Context, input molten.NotificationInput) error {
	n.lock.Lock()
	defer n.lock.Unlock()
	n.inputs = append(n.inputs, input)
	return nil
}

func (n *trunkNotices) resolve(ctx context.Context, prefix string) error {
	n.lock.Lock()
	defer n.lock.Unlock()
	n.resolved = append(n.resolved, prefix)
	return nil
}

func (f *cleanupFixture) syncTrunk(notices *trunkNotices) *CleanupStepResult {
	f.t.Helper()
	c := f.cleaner()
	c.env.Notify, c.env.ResolveNotices = notices.notify, notices.resolve
	result, err := c.Run(context.Background(), CleanupRequest{Dir: f.dir, Repo: cleanupRepo, Number: 7, Steps: []string{CleanupStepLocalTrunk}})
	if err != nil {
		f.t.Fatalf("cleanup: %v", err)
	}
	step := result.Step(CleanupStepLocalTrunk)
	if step == nil {
		f.t.Fatalf("the local trunk step did not run: %+v", result.Steps)
	}
	return step
}

// otherRefs are the local branches but develop, with their tips (the cleanup's fetch moves the remote ones).
func (f *cleanupFixture) otherRefs() map[string]string {
	f.t.Helper()
	rtn := map[string]string{}
	for _, line := range strings.Split(f.git(f.dir, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"), "\n") {
		name, oid, _ := strings.Cut(line, " ")
		if name != "refs/heads/develop" {
			rtn[name] = oid
		}
	}
	return rtn
}

// advanceOrigin pushes a commit writing name on origin's develop, as another merge would.
func (f *cleanupFixture) advanceOrigin(name string, text string) {
	other := filepath.Join(f.root, "merger")
	f.git(other, "pull", "--quiet", "--ff-only", "origin", "develop")
	f.write(other, name, text)
	f.git(other, "add", name)
	f.git(other, "commit", "--quiet", "-m", "change "+name)
	f.git(other, "push", "--quiet", "origin", "develop")
}

func (f *cleanupFixture) originDevelop() string {
	f.t.Helper()
	f.git(f.dir, "fetch", "--quiet", "origin")
	return f.git(f.dir, "rev-parse", "refs/remotes/origin/develop")
}

func expectTrunk(t *testing.T, step *CleanupStepResult, state string, code string) {
	t.Helper()
	if step.State != state || step.Code != code {
		t.Fatalf("local trunk: %s %s (%s), want %s %s", step.State, step.Code, step.Error, state, code)
	}
	if step.Branch != "develop" {
		t.Errorf("branch: %q", step.Branch)
	}
}

func expectNotified(t *testing.T, notices *trunkNotices, dir string, parts ...string) molten.NotificationInput {
	t.Helper()
	if len(notices.inputs) != 1 {
		t.Fatalf("notifications: %+v", notices.inputs)
	}
	input := notices.inputs[0]
	if input.Key != trunkNoticeKey(dir) || input.Kind != "warning" || input.TitleText == nil || input.MessageText == nil {
		t.Errorf("notification: %+v", input)
	}
	for _, part := range parts {
		if !strings.Contains(input.Message, part) {
			t.Errorf("the notification misses %q: %s", part, input.Message)
		}
	}
	if len(input.Actions) != 1 || input.Actions[0].Gesture != TerminalGesture || input.Actions[0].LabelText == nil {
		t.Errorf("the notification must offer a terminal there: %+v", input.Actions)
	}
	return input
}

func TestLocalTrunkFastForwardsTheCheckout(t *testing.T) {
	f := makeCleanupFixture(t, true)
	f.write(f.dir, "a.txt", "an unrelated local change\n")
	f.write(f.dir, "notes.txt", "untracked\n")
	before := f.otherRefs()
	notices := &trunkNotices{}

	step := f.syncTrunk(notices)

	expectTrunk(t, step, CleanupStateDone, CleanupCodeTrunkUpdated)
	if step.Count != 2 || step.Ahead != 0 || !samePath(step.Path, f.dir) {
		t.Errorf("step: %+v", step)
	}
	if head, origin := f.git(f.dir, "rev-parse", "develop"), f.originDevelop(); head != origin {
		t.Errorf("develop %s, origin/develop %s", head, origin)
	}
	if f.git(f.dir, "symbolic-ref", "HEAD") != "refs/heads/develop" {
		t.Error("the checkout left develop")
	}
	if !exists(filepath.Join(f.dir, "c.txt")) || readText(t, filepath.Join(f.dir, "a.txt")) != "an unrelated local change\n" ||
		!exists(filepath.Join(f.dir, "notes.txt")) {
		t.Error("the files must be updated and the local changes kept")
	}
	if parents := f.git(f.dir, "log", "--merges", "--oneline", "develop"); parents != "" {
		t.Errorf("a merge commit was made: %s", parents)
	}
	if after := f.otherRefs(); !maps.Equal(before, after) {
		t.Errorf("other refs changed:\n%v\n%v", before, after)
	}
	if len(notices.inputs) != 0 || !slices.Equal(notices.resolved, []string{trunkNoticeKey(f.dir)}) {
		t.Errorf("an update says nothing and clears an earlier refusal: %+v %v", notices.inputs, notices.resolved)
	}
	if stash := f.git(f.dir, "stash", "list"); stash != "" {
		t.Errorf("a stash was made: %s", stash)
	}
}

func TestLocalTrunkMovesTheRefWhenNotCheckedOut(t *testing.T) {
	f := makeCleanupFixture(t, true)
	f.git(f.dir, "checkout", "--quiet", "-b", "spike")
	f.write(f.dir, "a.txt", "work in progress\n")
	spike := f.git(f.dir, "rev-parse", "spike")
	before := f.otherRefs()
	notices := &trunkNotices{}

	step := f.syncTrunk(notices)

	expectTrunk(t, step, CleanupStateDone, CleanupCodeTrunkUpdated)
	if step.Path != "" || step.Count != 2 {
		t.Errorf("step: %+v", step)
	}
	if head, origin := f.git(f.dir, "rev-parse", "develop"), f.originDevelop(); head != origin {
		t.Errorf("develop %s, origin/develop %s", head, origin)
	}
	if f.git(f.dir, "symbolic-ref", "HEAD") != "refs/heads/spike" || f.git(f.dir, "rev-parse", "spike") != spike ||
		exists(filepath.Join(f.dir, "c.txt")) || readText(t, filepath.Join(f.dir, "a.txt")) != "work in progress\n" {
		t.Error("the checkout on another branch must not change")
	}
	if after := f.otherRefs(); !maps.Equal(before, after) {
		t.Errorf("other refs changed:\n%v\n%v", before, after)
	}
}

func TestLocalTrunkAlreadyUpToDate(t *testing.T) {
	f := makeCleanupFixture(t, true)
	f.git(f.dir, "pull", "--quiet", "--ff-only", "origin", "develop")
	notices := &trunkNotices{}

	step := f.syncTrunk(notices)

	expectTrunk(t, step, CleanupStateSkipped, CleanupCodeTrunkUpToDate)
	if len(notices.inputs) != 0 || len(notices.resolved) != 1 {
		t.Errorf("up to date says nothing: %+v %v", notices.inputs, notices.resolved)
	}
}

func TestLocalTrunkRefusesLocalCommits(t *testing.T) {
	f := makeCleanupFixture(t, true)
	f.write(f.dir, "local.txt", "mine\n")
	f.git(f.dir, "add", "local.txt")
	f.git(f.dir, "commit", "--quiet", "-m", "local work")
	tip := f.git(f.dir, "rev-parse", "develop")
	before := f.otherRefs()
	notices := &trunkNotices{}

	step := f.syncTrunk(notices)

	expectTrunk(t, step, CleanupStateSkipped, CleanupCodeTrunkLocalCommits)
	if step.Ahead != 1 || step.Count != 2 {
		t.Errorf("step: %+v", step)
	}
	if f.git(f.dir, "rev-parse", "develop") != tip || f.git(f.dir, "rev-parse", "HEAD") != tip || exists(filepath.Join(f.dir, "c.txt")) {
		t.Error("develop must not change")
	}
	if after := f.otherRefs(); !maps.Equal(before, after) {
		t.Errorf("other refs changed:\n%v\n%v", before, after)
	}
	input := expectNotified(t, notices, f.dir, "Local develop is 2 commits behind origin and was not updated: it has 1 commit origin does not have.")
	if input.MessageText.Code != "notif.review.trunk.notUpdated" || input.MessageText.Parts["reason"].Code != "notif.review.trunk.why.localcommitsOne" {
		t.Errorf("message text: %+v", input.MessageText)
	}
	if input.Actions[0].Args["path"] != f.dir {
		t.Errorf("the terminal opens in the checkout: %+v", input.Actions[0].Args)
	}
}

func TestLocalTrunkRefusesAChangeInTheWay(t *testing.T) {
	f := makeCleanupFixture(t, true)
	f.advanceOrigin("a.txt", "changed on origin\n")
	f.write(f.dir, "a.txt", "changed here\n")
	f.write(f.dir, "c.txt", "untracked, and origin adds it\n")
	tip := f.git(f.dir, "rev-parse", "develop")
	before := f.otherRefs()
	notices := &trunkNotices{}

	step := f.syncTrunk(notices)

	expectTrunk(t, step, CleanupStateSkipped, CleanupCodeTrunkChanges)
	if !slices.Equal(step.Names, []string{"a.txt", "c.txt"}) || step.NameCount != 2 || !samePath(step.Path, f.dir) || step.Count != 3 {
		t.Errorf("step: %+v", step)
	}
	if f.git(f.dir, "rev-parse", "develop") != tip || readText(t, filepath.Join(f.dir, "a.txt")) != "changed here\n" ||
		readText(t, filepath.Join(f.dir, "c.txt")) != "untracked, and origin adds it\n" {
		t.Error("nothing may change")
	}
	if after := f.otherRefs(); !maps.Equal(before, after) {
		t.Errorf("other refs changed:\n%v\n%v", before, after)
	}
	expectNotified(t, notices, f.dir, "Local develop is 3 commits behind origin and was not updated: local changes in", "would be overwritten: a.txt, c.txt")
	if stash := f.git(f.dir, "stash", "list"); stash != "" {
		t.Errorf("a stash was made: %s", stash)
	}
}

func TestLocalTrunkRefusesARebaseInProgress(t *testing.T) {
	f := makeCleanupFixture(t, true)
	tip := f.git(f.dir, "rev-parse", "develop")
	// The rebase stops on its exec line: develop is being rebased, the checkout's HEAD is detached.
	cmd := exec.Command("git", "rebase", "--exec", "false", "--root")
	cmd.Dir, cmd.Env = f.dir, gitEnv()
	cmdOut, _ := cmd.CombinedOutput()
	if !exists(filepath.Join(f.dir, ".git", "rebase-merge")) {
		t.Fatalf("no rebase in progress: %s", cmdOut)
	}
	before := f.otherRefs()
	notices := &trunkNotices{}

	step := f.syncTrunk(notices)

	expectTrunk(t, step, CleanupStateSkipped, CleanupCodeTrunkInProgress)
	if !samePath(step.Path, f.dir) {
		t.Errorf("step: %+v", step)
	}
	if f.git(f.dir, "rev-parse", "refs/heads/develop") != tip || !exists(filepath.Join(f.dir, ".git", "rebase-merge")) {
		t.Error("develop and the rebase must not change")
	}
	if after := f.otherRefs(); !maps.Equal(before, after) {
		t.Errorf("other refs changed:\n%v\n%v", before, after)
	}
	expectNotified(t, notices, f.dir, "is in progress in")
}

func TestLocalTrunkRefusesAMergeInProgress(t *testing.T) {
	f := makeCleanupFixture(t, true)
	f.git(f.dir, "branch", "side", "HEAD")
	f.git(f.dir, "checkout", "--quiet", "side")
	f.write(f.dir, "side.txt", "side\n")
	f.git(f.dir, "add", "side.txt")
	f.git(f.dir, "commit", "--quiet", "-m", "side")
	f.git(f.dir, "checkout", "--quiet", "develop")
	f.git(f.dir, "merge", "--no-ff", "--no-commit", "side")
	tip := f.git(f.dir, "rev-parse", "develop")
	notices := &trunkNotices{}

	step := f.syncTrunk(notices)

	expectTrunk(t, step, CleanupStateSkipped, CleanupCodeTrunkInProgress)
	if f.git(f.dir, "rev-parse", "develop") != tip || !exists(filepath.Join(f.dir, ".git", "MERGE_HEAD")) {
		t.Error("develop and the merge must not change")
	}
	expectNotified(t, notices, f.dir, "is in progress in")
}

func TestLocalTrunkInAnotherWorktree(t *testing.T) {
	f := makeCleanupFixture(t, true)
	f.git(f.dir, "checkout", "--quiet", "-b", "spike")
	tree := filepath.Join(f.root, "app-develop")
	f.git(f.dir, "worktree", "add", "--quiet", tree, "develop")
	notices := &trunkNotices{}

	step := f.syncTrunk(notices)

	expectTrunk(t, step, CleanupStateDone, CleanupCodeTrunkUpdated)
	if !samePath(step.Path, tree) || !exists(filepath.Join(tree, "c.txt")) {
		t.Errorf("the worktree on develop must be fast-forwarded: %+v", step)
	}
	if head, origin := f.git(tree, "rev-parse", "HEAD"), f.originDevelop(); head != origin {
		t.Errorf("develop %s, origin/develop %s", head, origin)
	}
}

func TestLocalTrunkFollowsTheWorkingBranch(t *testing.T) {
	f := makeCleanupFixture(t, false)
	f.write(f.dir, molten.ProjectSaaSFoundryFile, `{"workflow":{"workingBranch":"trunk"}}`)
	if got := trunkOf(f.dir, "develop"); got != "trunk" {
		t.Errorf("trunkOf: %q", got)
	}
	notices := &trunkNotices{}

	step := f.syncTrunk(notices)

	if step.State != CleanupStateSkipped || step.Code != CleanupCodeNoLocalTrunk || step.Branch != "trunk" {
		t.Errorf("step: %+v", step)
	}
	if len(notices.inputs) != 0 {
		t.Errorf("no local trunk says nothing: %+v", notices.inputs)
	}
}

// The batch's last notification sums, in a quiet sentence, what the cleanups after its merges brought to the local
// trunk; a batch that updated nothing says nothing of it.
func TestBatchEndSaysTheLocalTrunkWasUpdated(t *testing.T) {
	f := newBatchFixture(t, nil)
	f.start(1, 4)
	run := f.waitEnd()
	end := f.notices.find(":end:")
	if end == nil || end.MessageText.Vars["trunk"] != "" || end.MessageText.Parts["trunk"] != nil || strings.Contains(end.Message, "Local develop") {
		t.Fatalf("no update, no line: %+v", end)
	}
	for n, count := range map[int]int{1: 2, 4: 1} {
		result := CleanupResult{Repo: testRepo, Number: n, Steps: []CleanupStepResult{{Id: CleanupStepLocalTrunk, State: CleanupStateDone,
			Code: CleanupCodeTrunkUpdated, Branch: "develop", Count: count}}}
		if _, _, err := f.merger.store.SetCleanup(result); err != nil {
			t.Fatal(err)
		}
	}

	f.runner.notifyEnd(run)

	end = f.notices.find(":end:")
	trunk := end.MessageText.Parts["trunk"]
	if trunk == nil || trunk.Code != "notif.review.batch.trunkUpdated" || trunk.Vars["count"] != "3" || trunk.Vars["branch"] != "develop" {
		t.Fatalf("trunk part: %+v", end.MessageText)
	}
	if !strings.HasSuffix(end.Message, " Local develop updated: +3 commits.") {
		t.Errorf("message: %s", end.Message)
	}
}

func TestLocalTrunkPlanned(t *testing.T) {
	f := makeCleanupFixture(t, true)
	steps := f.cleaner().Plan(context.Background(), MergedPr{Dir: f.dir, Repo: cleanupRepo, Number: 7, HeadRef: "feature/7-thing", BaseRef: "develop", HeadOid: f.headOid})
	for _, step := range steps {
		if step.Id == CleanupStepLocalTrunk {
			if step.State != CleanupStatePlanned || step.Branch != "develop" || step.Code != "" {
				t.Errorf("planned step: %+v", step)
			}
			return
		}
	}
	t.Errorf("the plan misses the local trunk: %+v", steps)
}
