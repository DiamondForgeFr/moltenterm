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
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// The batch merge runs here against a simulated GitHub: a local bare origin holding develop and crafted PR branches,
// a fake gh that reads the PRs' states from it, runs their checks (a pushed head's checks run for a few reads before
// they pass, or fail when the test says so) and merges them there with a merge commit, and a fake agent that rebases a
// PR in its worktree with real git, resolving a conflict with the PR's side or giving up as on an ambiguous one.

const batchTestWait = time.Minute

const (
	hubCheckSuccess = "SUCCESS"
	hubCheckFailure = "FAILURE"
	hubCheckPending = "PENDING"
)

type hubPr struct {
	number int
	branch string
	state  string
	merged string
	// failing: the checks of its first head fail; failAfterPush: those of a pushed head fail; pendingForever: they
	// never end.
	failing        bool
	failAfterPush  bool
	pendingForever bool
	// syncReview: its first head also shows sync-review, a pull_request_target check a push never reruns (#887).
	// lateGate: its CI workflow has a second job, gate, created on a pushed head only after a few reads. slowStart: a
	// pushed head shows no check at all for its first reads, as before GitHub registered the push's workflows.
	syncReview bool
	lateGate   bool
	slowStart  bool
}

type fakeHub struct {
	t      *testing.T
	origin string

	lock sync.Mutex
	prs  map[int]*hubPr
	// initial: the heads the PRs had at the start; reads counts the reads of a pushed head (its CI runs meanwhile).
	initial map[string]bool
	reads   map[string]int
	merges  []int
	// checksAtMerge: the checks' state of the head each PR was merged at; gateAtMerge: its gate job's ("" when absent).
	checksAtMerge map[int]string
	gateAtMerge   map[int]string
	pushedHeads   map[string]bool
}

func (h *fakeHub) git(args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), batchTestWait)
	defer cancel()
	out, err := forecastTestGit(ctx, nil, nil, append([]string{"--git-dir", h.origin}, args...)...)
	return strings.TrimSpace(string(out)), err
}

func (h *fakeHub) mustGit(args ...string) string {
	out, err := h.git(args...)
	if err != nil {
		h.t.Error(err)
	}
	return out
}

func (h *fakeHub) checkState(pr *hubPr, head string) string {
	if h.initial[head] {
		if pr.failing {
			return hubCheckFailure
		}
		if pr.pendingForever {
			return hubCheckPending
		}
		return hubCheckSuccess
	}
	h.pushedHeads[head] = true
	ready := 3
	if pr.slowStart {
		ready = 7
	}
	if pr.pendingForever || h.reads[head] < ready {
		return hubCheckPending
	}
	if pr.failAfterPush {
		return hubCheckFailure
	}
	return hubCheckSuccess
}

func (h *fakeHub) gateState(pr *hubPr, head string) string {
	switch {
	case !pr.lateGate:
		return ""
	case h.initial[head]:
		return hubCheckSuccess
	case h.reads[head] < 6:
		return ""
	case h.reads[head] < 9:
		return hubCheckPending
	}
	return hubCheckSuccess
}

func hubCheck(name string, workflow string, state string) map[string]string {
	if state == hubCheckPending {
		return map[string]string{"name": name, "workflowName": workflow, "status": "IN_PROGRESS", "conclusion": ""}
	}
	return map[string]string{"name": name, "workflowName": workflow, "status": "COMPLETED", "conclusion": state}
}

func (h *fakeHub) rollup(pr *hubPr, head string) []any {
	if pr.slowStart && !h.initial[head] && h.reads[head] < 4 {
		return []any{}
	}
	rtn := []any{hubCheck("ci", "CI", h.checkState(pr, head))}
	if gate := h.gateState(pr, head); gate != "" {
		rtn = append(rtn, hubCheck("gate", "CI", gate))
	}
	if pr.syncReview && h.initial[head] {
		rtn = append(rtn, hubCheck("sync-review", "PR review sync", hubCheckSuccess))
	}
	return rtn
}

func (h *fakeHub) conflicts(base string, head string) bool {
	_, err := h.git("merge-tree", "--write-tree", "--name-only", "--no-messages", base, head)
	return err != nil
}

func (h *fakeHub) view(number int) ([]byte, error) {
	pr := h.prs[number]
	if pr == nil {
		return nil, fmt.Errorf("no pull request #%d", number)
	}
	base := h.mustGit("rev-parse", "refs/heads/develop")
	data := map[string]any{"number": number, "title": "PR " + strconv.Itoa(number), "url": "https://github.com/owner/name/pull/" + strconv.Itoa(number),
		"isDraft": false, "headRefName": pr.branch, "baseRefName": "develop", "closingIssuesReferences": []any{}}
	if pr.state != "OPEN" {
		data["state"], data["headRefOid"], data["mergeable"], data["mergeStateStatus"] = pr.state, strings.Repeat("0", 40), "UNKNOWN", "UNKNOWN"
		data["statusCheckRollup"] = []any{}
		if pr.merged != "" {
			data["mergeCommit"] = map[string]string{"oid": pr.merged}
		}
		out, err := json.Marshal(data)
		return out, err
	}
	head := h.mustGit("rev-parse", "refs/heads/"+pr.branch)
	h.reads[head]++
	mergeable, mergeState := "MERGEABLE", "CLEAN"
	if h.conflicts(base, head) {
		mergeable, mergeState = "CONFLICTING", "DIRTY"
	}
	data["state"], data["headRefOid"], data["mergeable"], data["mergeStateStatus"] = "OPEN", head, mergeable, mergeState
	data["statusCheckRollup"] = h.rollup(pr, head)
	return json.Marshal(data)
}

func (h *fakeHub) merge(number int, args []string) error {
	pr := h.prs[number]
	if pr == nil || pr.state != "OPEN" {
		return fmt.Errorf("pull request #%d is not open", number)
	}
	if !slices.Contains(args, "--merge") {
		return fmt.Errorf("the repository allows merge commits only: %v", args)
	}
	head := h.mustGit("rev-parse", "refs/heads/"+pr.branch)
	i := slices.Index(args, "--match-head-commit")
	if i < 0 || i+1 >= len(args) || args[i+1] != head {
		return errors.New("Head branch was modified. Review and try the merge again.")
	}
	base := h.mustGit("rev-parse", "refs/heads/develop")
	tree, err := h.git("merge-tree", "--write-tree", base, head)
	if err != nil {
		return errors.New("Pull request is not mergeable")
	}
	tree = strings.SplitN(tree, "\n", 2)[0]
	merged := h.mustGit("commit-tree", tree, "-p", base, "-p", head, "-m", "Merge pull request #"+strconv.Itoa(number))
	h.mustGit("update-ref", "refs/heads/develop", merged, base)
	h.mustGit("update-ref", "-d", "refs/heads/"+pr.branch)
	h.checksAtMerge[number] = h.checkState(pr, head)
	h.gateAtMerge[number] = h.gateState(pr, head)
	pr.state, pr.merged = "MERGED", merged
	h.merges = append(h.merges, number)
	return nil
}

func (h *fakeHub) run(ctx context.Context, dir string, args ...string) ([]byte, error) {
	h.lock.Lock()
	defer h.lock.Unlock()
	if len(args) == 2 && args[0] == "api" {
		if strings.Contains(args[1], "/rules/branches/") {
			return []byte("[]"), nil
		}
		return []byte(`{"allow_merge_commit":true,"allow_squash_merge":false,"allow_rebase_merge":false}`), nil
	}
	if len(args) < 3 || args[len(args)-2] != "--repo" || args[len(args)-1] != testRepo {
		return nil, fmt.Errorf("gh called without --repo: %v", args)
	}
	number, _ := strconv.Atoi(args[2])
	switch {
	case args[0] == "pr" && args[1] == "view":
		return h.view(number)
	case args[0] == "pr" && args[1] == "merge":
		return nil, h.merge(number, args)
	}
	return nil, fmt.Errorf("fake gh: unsupported %v", args)
}

func (h *fakeHub) merged() []int {
	h.lock.Lock()
	defer h.lock.Unlock()
	return append([]int(nil), h.merges...)
}

// batchFixture: develop has f (three lines); PR 1 adds one.txt, PR 2 changes f's line 2, PR 3 changes the same line
// (it conflicts once PR 2 is merged), PR 4 adds four.txt, PR 5 changes f's line 2 too.
type batchFixture struct {
	t       *testing.T
	dir     string
	data    string
	hub     *fakeHub
	prs     map[int]BatchPr
	runner  *BatchRunner
	merger  *Merger
	agent   *fakeBatchAgent
	notices *noticeLog
}

type noticeLog struct {
	lock     sync.Mutex
	inputs   []molten.NotificationInput
	resolved []string
	states   []string
}

func (n *noticeLog) notify(ctx context.Context, input molten.NotificationInput) error {
	n.lock.Lock()
	defer n.lock.Unlock()
	n.inputs = append(n.inputs, input)
	return nil
}

// published keeps the run states the windows were sent, without repeats.
func (n *noticeLog) published(run BatchRun) {
	n.lock.Lock()
	defer n.lock.Unlock()
	if len(n.states) == 0 || n.states[len(n.states)-1] != run.State {
		n.states = append(n.states, run.State)
	}
}

func (n *noticeLog) runStates() []string {
	n.lock.Lock()
	defer n.lock.Unlock()
	return append([]string(nil), n.states...)
}

func (n *noticeLog) resolve(ctx context.Context, prefix string) error {
	n.lock.Lock()
	defer n.lock.Unlock()
	n.resolved = append(n.resolved, prefix)
	return nil
}

func (n *noticeLog) find(keyPart string) *molten.NotificationInput {
	n.lock.Lock()
	defer n.lock.Unlock()
	for i := len(n.inputs) - 1; i >= 0; i-- {
		if strings.Contains(n.inputs[i].Key, keyPart) {
			input := n.inputs[i]
			return &input
		}
	}
	return nil
}

var batchLinePattern = regexp.MustCompile(`rebase PR #(\d+) \(([^)]+)\) on origin/(\S+) in (\S+), .* Follow the brief (\S+)\.md: `)

// fakeBatchAgent stands for the developer's agent: it rebases a PR in its worktree with real git and writes the
// result line. ambiguous: the PRs whose conflicts it leaves to the developer.
type fakeBatchAgent struct {
	t         *testing.T
	ambiguous map[int]bool
	// failStarts: how many starts open a terminal where the agent does not start.
	failStarts int

	lock    sync.Mutex
	state   string
	started int
	lines   []string
	closed  []string
	queue   chan string
	wg      sync.WaitGroup
}

func (a *fakeBatchAgent) git(dir string, args ...string) error {
	ctx, cancel := context.WithTimeout(context.Background(), batchTestWait)
	defer cancel()
	_, err := forecastTestGit(ctx, nil, nil, append([]string{"-C", dir}, args...)...)
	return err
}

func (a *fakeBatchAgent) setState(state string) {
	a.lock.Lock()
	defer a.lock.Unlock()
	a.state = state
}

func (a *fakeBatchAgent) handle(line string) {
	a.setState(molten.AgentStateWorking)
	defer a.setState(molten.AgentStateDone)
	m := batchLinePattern.FindStringSubmatch(line)
	if m == nil {
		a.t.Errorf("the agent's prompt names no PR: %s", line)
		return
	}
	number, _ := strconv.Atoi(m[1])
	branch, base, tree, result := m[2], m[3], m[4], m[5]+".result"
	if len(line) > 600 {
		a.t.Errorf("the prompt does not fit the typing path: %d characters", len(line))
	}
	write := func(text string) {
		if err := os.WriteFile(result, []byte(text+"\n"), 0600); err != nil {
			a.t.Error(err)
		}
	}
	if err := a.git(tree, "fetch", "--quiet", "origin"); err != nil {
		write("stopped fetch failed: " + err.Error())
		return
	}
	old, err := forecastTestGit(context.Background(), nil, nil, "-C", tree, "rev-parse", "refs/remotes/origin/"+branch)
	if err != nil {
		write("stopped no branch")
		return
	}
	oldHead := strings.TrimSpace(string(old))
	if err := a.git(tree, "checkout", "--quiet", "--detach", oldHead); err != nil {
		write("stopped checkout failed")
		return
	}
	if err := a.git(tree, "rebase", "--quiet", "origin/"+base); err != nil {
		if a.ambiguous[number] {
			a.git(tree, "rebase", "--abort")
			write("stopped f: both sides rewrite line 2, which one wins?")
			return
		}
		if err := a.git(tree, "checkout", "--theirs", "--", "."); err != nil {
			write("stopped could not resolve")
			return
		}
		a.git(tree, "add", "-A")
		if err := a.git(tree, "-c", "core.editor=true", "rebase", "--continue"); err != nil {
			write("stopped rebase --continue failed")
			return
		}
	}
	if err := a.git(tree, "push", "--quiet", "--force-with-lease=refs/heads/"+branch+":"+oldHead, "origin", "HEAD:refs/heads/"+branch); err != nil {
		write("stopped push failed")
		return
	}
	head, _ := forecastTestGit(context.Background(), nil, nil, "-C", tree, "rev-parse", "HEAD")
	write("pushed " + strings.TrimSpace(string(head)))
}

func (a *fakeBatchAgent) openTerminal(ctx context.Context, tabId string, after string, meta waveobj.MetaMapType, command string) (string, error) {
	a.lock.Lock()
	if a.failStarts > 0 {
		a.failStarts--
		a.lock.Unlock()
		return "block-dead", errors.New("the terminal showed no prompt")
	}
	a.started++
	a.state = molten.AgentStateWorking
	a.queue = make(chan string, 4)
	queue := a.queue
	a.lock.Unlock()
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		for line := range queue {
			a.handle(line)
		}
	}()
	queue <- command
	return "block-agent", nil
}

func (a *fakeBatchAgent) typePrompt(ctx context.Context, blockId string, line string) RestartTypeOutcome {
	a.lock.Lock()
	defer a.lock.Unlock()
	if a.state == molten.AgentStateWorking {
		return RestartTypeOutcome{Retry: true, Message: "working"}
	}
	a.state = molten.AgentStateWorking
	a.lines = append(a.lines, line)
	a.queue <- line
	return RestartTypeOutcome{Sent: true, Submitted: true}
}

func (a *fakeBatchAgent) run(blockId string) (molten.AgentRunInfo, bool) {
	a.lock.Lock()
	defer a.lock.Unlock()
	if a.started == 0 {
		return molten.AgentRunInfo{}, false
	}
	return molten.AgentRunInfo{Running: true, State: a.state, Agent: molten.AgentIdClaude}, true
}

func (a *fakeBatchAgent) closeTerminal(ctx context.Context, blockId string) error {
	a.lock.Lock()
	defer a.lock.Unlock()
	a.closed = append(a.closed, blockId)
	if a.queue != nil {
		close(a.queue)
		a.queue = nil
	}
	return nil
}

func (a *fakeBatchAgent) stop() {
	a.lock.Lock()
	if a.queue != nil {
		close(a.queue)
		a.queue = nil
	}
	a.lock.Unlock()
	a.wg.Wait()
}

func batchTestGit(ctx context.Context, dir string, args ...string) ([]byte, error) {
	return forecastTestGit(ctx, nil, nil, append([]string{"-C", dir}, args...)...)
}

func newBatchFixture(t *testing.T, setup func(prs map[int]*hubPr)) *batchFixture {
	t.Helper()
	root := t.TempDir()
	origin := filepath.Join(root, "origin.git")
	work := filepath.Join(root, "seed")
	dir := filepath.Join(root, "project")
	data := filepath.Join(root, "data")
	fgit(t, root, "init", "-q", "--bare", "-b", "develop", origin)
	if err := os.MkdirAll(work, 0755); err != nil {
		t.Fatal(err)
	}
	fgit(t, work, "init", "-q", "-b", "develop")
	if err := os.WriteFile(filepath.Join(work, "f"), []byte("a\nb\nc\n"), 0644); err != nil {
		t.Fatal(err)
	}
	fgit(t, work, "add", "-A")
	fgit(t, work, "commit", "-q", "-m", "base")
	base := fgit(t, work, "rev-parse", "HEAD")
	branches := map[int]string{1: "feature/1-one", 2: "feature/2-two", 3: "feature/3-three", 4: "feature/4-four", 5: "feature/5-five"}
	heads := map[int]string{
		1: fcommit(t, work, branches[1], base, "one.txt", "one\n"),
		2: fcommit(t, work, branches[2], base, "f", "a\ntwo\nc\n"),
		3: fcommit(t, work, branches[3], base, "f", "a\nthree\nc\n"),
		4: fcommit(t, work, branches[4], base, "four.txt", "four\n"),
		5: fcommit(t, work, branches[5], base, "f", "a\nfive\nc\n"),
	}
	fgit(t, work, "checkout", "-q", "develop")
	fgit(t, work, "push", "-q", origin, "develop", branches[1], branches[2], branches[3], branches[4], branches[5])
	fgit(t, root, "clone", "-q", "-b", "develop", origin, dir)
	hub := &fakeHub{t: t, origin: origin, prs: map[int]*hubPr{}, initial: map[string]bool{}, reads: map[string]int{},
		checksAtMerge: map[int]string{}, gateAtMerge: map[int]string{}, pushedHeads: map[string]bool{}}
	prs := map[int]BatchPr{}
	for n, head := range heads {
		branch := branches[n]
		hub.prs[n] = &hubPr{number: n, branch: branch, state: "OPEN"}
		hub.initial[head] = true
		prs[n] = BatchPr{Number: n, HeadRef: branch, HeadOid: head, Title: "PR " + strconv.Itoa(n)}
	}
	if setup != nil {
		setup(hub.prs)
	}
	store := MakeStore(data)
	merger := MakeMerger(store, hub.run, nil)
	merger.pollEvery = 10 * time.Millisecond
	merger.ciTimeout = batchTestWait
	agent := &fakeBatchAgent{t: t, ambiguous: map[int]bool{}}
	notices := &noticeLog{}
	restarter := MakeRestarter(store, RestartEnv{
		Git:            batchTestGit,
		DataDir:        data,
		AgentRun:       agent.run,
		TypePrompt:     agent.typePrompt,
		OpenTerminal:   agent.openTerminal,
		AgentInstalled: func(id string) bool { return id == molten.AgentIdClaude },
		AgentOrder:     []string{molten.AgentIdClaude},
		AgentTab: func(ctx context.Context, workspaceId string, name string, meta waveobj.MetaMapType, hidden bool) (string, error) {
			if !hidden {
				t.Errorf("the batch's agent tab must be hidden")
			}
			return "tab-agent", nil
		},
		BlockExists:    func(ctx context.Context, blockId string) bool { return true },
		CloseTerminal:  agent.closeTerminal,
		Notify:         notices.notify,
		ResolveNotices: notices.resolve,
	})
	runner := MakeBatchRunner(BatchEnv{
		Publish:      notices.published,
		Gh:           hub.run,
		Merger:       merger,
		Agents:       restarter,
		DataDir:      data,
		Every:        10 * time.Millisecond,
		AgentEvery:   10 * time.Millisecond,
		AgentLimit:   batchTestWait,
		ComputeLimit: batchTestWait,
		ChecksSettle: time.Millisecond,
	})
	f := &batchFixture{t: t, dir: dir, data: data, hub: hub, prs: prs, runner: runner, merger: merger, agent: agent, notices: notices}
	// Registered after the temp folders: cleanups run in reverse order, so the run and the agent end first.
	t.Cleanup(func() {
		f.runner.Cancel(BatchRequest{Dir: dir, Base: "develop"})
		f.waitDone()
		f.agent.stop()
	})
	return f
}

// start is a batch from the Reviews list: the PRs in the order shown, bound to their listed heads.
func (f *batchFixture) start(numbers ...int) BatchRun {
	f.t.Helper()
	var prs []BatchPr
	for _, n := range numbers {
		prs = append(prs, f.prs[n])
	}
	run, err := f.runner.Add(QueueAddRequest{Dir: f.dir, Repo: testRepo, Base: "develop", Method: "merge", Prs: prs, Source: BatchSourceBatch,
		Order: numbers, WorkspaceId: "ws"})
	if err != nil {
		f.t.Fatal(err)
	}
	return run
}

// validate is Validate on one PR from its sheet: a fresh plan, then the queue, with the suggested order of the window.
func (f *batchFixture) validate(number int, order ...int) (BatchRun, error) {
	f.t.Helper()
	plan, err := f.merger.Plan(context.Background(), MergePlanRequest{PrKey: PrKey{Repo: testRepo, Number: number}, Dir: f.dir})
	if err != nil {
		f.t.Fatal(err)
	}
	pr := f.prs[number]
	pr.PlanId = plan.Id
	return f.runner.Add(QueueAddRequest{Dir: f.dir, Repo: testRepo, Base: "develop", Prs: []BatchPr{pr}, Order: order, WorkspaceId: "ws"})
}

func (f *batchFixture) setPr(number int, fn func(pr *hubPr)) {
	f.hub.lock.Lock()
	defer f.hub.lock.Unlock()
	fn(f.hub.prs[number])
}

// push is someone else's commit on the PR's branch on origin.
func (f *batchFixture) push(number int) string {
	f.t.Helper()
	f.hub.lock.Lock()
	defer f.hub.lock.Unlock()
	branch := "refs/heads/" + f.hub.prs[number].branch
	head := f.hub.mustGit("rev-parse", branch)
	tree := f.hub.mustGit("rev-parse", head+"^{tree}")
	next := f.hub.mustGit("commit-tree", tree, "-p", head, "-m", "a push after the validation")
	f.hub.mustGit("update-ref", branch, next, head)
	return next
}

func (f *batchFixture) get() BatchRun {
	f.t.Helper()
	run, err := f.runner.Get(BatchRequest{Dir: f.dir, Base: "develop"})
	if err != nil || run == nil {
		f.t.Fatalf("no run: %v", err)
	}
	return *run
}

func (f *batchFixture) waitFor(what string, cond func(run BatchRun) bool) BatchRun {
	f.t.Helper()
	deadline := time.Now().Add(batchTestWait)
	for {
		run := f.get()
		if cond(run) {
			return run
		}
		if time.Now().After(deadline) {
			f.t.Fatalf("timed out waiting for %s: %+v", what, run)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (f *batchFixture) waitEnd() BatchRun {
	f.t.Helper()
	f.waitDone()
	return f.get()
}

func (f *batchFixture) waitDone() {
	f.t.Helper()
	done := make(chan struct{})
	go func() {
		f.runner.wait(f.dir, "develop")
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(batchTestWait):
		f.t.Fatalf("the run did not end")
	}
}

func itemOf(run BatchRun, number int) BatchItem {
	for _, it := range run.Items {
		if it.Number == number {
			return it
		}
	}
	return BatchItem{}
}

func TestBatchMergesCleanPrsWithoutARebase(t *testing.T) {
	f := newBatchFixture(t, nil)
	f.start(1, 2, 4)
	run := f.waitEnd()
	if run.State != BatchDone {
		t.Fatalf("state %s, want done: %+v", run.State, run)
	}
	if got := f.hub.merged(); !slices.Equal(got, []int{1, 2, 4}) {
		t.Fatalf("merged %v, want 1, 2, 4 in the modal's order", got)
	}
	if run.CiRuns != 0 || f.agent.started != 0 || len(f.hub.pushedHeads) != 0 {
		t.Fatalf("a clean batch reran CI: %d runs, agent started %d times, pushes %v", run.CiRuns, f.agent.started, f.hub.pushedHeads)
	}
	end := f.notices.find(":end:")
	if end == nil || end.Kind != "success" || end.TitleText.Code != "notif.review.batch.doneTitle" || end.TitleText.Vars["merged"] != "3" {
		t.Fatalf("end notification %+v", end)
	}
}

func TestBatchRebasesAConflictingPrAndMergesItOnceItsChecksPass(t *testing.T) {
	f := newBatchFixture(t, nil)
	f.start(2, 3)
	run := f.waitEnd()
	if run.State != BatchDone {
		t.Fatalf("state %s, want done: %+v", run.State, run)
	}
	if got := f.hub.merged(); !slices.Equal(got, []int{2, 3}) {
		t.Fatalf("merged %v, want 2 then 3", got)
	}
	three := itemOf(run, 3)
	if three.Rebases != 1 || run.CiRuns != 1 || f.agent.started != 1 {
		t.Fatalf("#3 rebased %d times, %d CI runs, agent started %d times", three.Rebases, run.CiRuns, f.agent.started)
	}
	if f.hub.checksAtMerge[3] != hubCheckSuccess {
		t.Fatalf("#3 was merged while its checks were %s", f.hub.checksAtMerge[3])
	}
	if itemOf(run, 2).Rebases != 0 || f.hub.checksAtMerge[2] != hubCheckSuccess {
		t.Fatalf("#2 should merge as it was: %+v", itemOf(run, 2))
	}
	content := fgit(t, f.dir, "--git-dir", f.hub.origin, "show", "develop:f")
	if !strings.Contains(content, "three") {
		t.Fatalf("develop's f after the batch: %q", content)
	}
	if !run.Cleaned || pathExists(run.Worktree) || !slices.Contains(f.agent.closed, "block-agent") {
		t.Fatalf("the agent's terminal and worktree should go: cleaned %v, worktree %s, closed %v", run.Cleaned, run.Worktree, f.agent.closed)
	}
	if status := fgit(t, f.dir, "status", "--porcelain"); status != "" || fgit(t, f.dir, "rev-parse", "--abbrev-ref", "HEAD") != "develop" {
		t.Fatalf("the main checkout was touched: %q", status)
	}
	end := f.notices.find(":end:")
	if end == nil || end.MessageText.Vars["ciruns"] != "1" {
		t.Fatalf("the end notification should count one CI run: %+v", end)
	}
}

// #887 AC1: sync-review ran on #3's first head only; its rebased head never shows it, and #3 still merges.
func TestBatchDoesNotWaitForACheckThePushNeverReruns(t *testing.T) {
	f := newBatchFixture(t, func(prs map[int]*hubPr) { prs[3].syncReview = true })
	f.start(2, 3)
	run := f.waitEnd()
	if run.State != BatchDone || !slices.Equal(f.hub.merged(), []int{2, 3}) {
		t.Fatalf("state %s, merged %v, want done with 2 and 3: %+v", run.State, f.hub.merged(), run)
	}
	if itemOf(run, 3).Rebases != 1 || f.hub.checksAtMerge[3] != hubCheckSuccess {
		t.Fatalf("#3 should merge after its rebase with green checks: %+v, checks %s", itemOf(run, 3), f.hub.checksAtMerge[3])
	}
}

// #887 AC2: the gate job of #3's CI workflow is created on the rebased head after its other job passed; the batch waits
// for it, though the settle time after the rebase is long over.
func TestBatchWaitsForAJobOfAWorkflowRunningOnTheNewHead(t *testing.T) {
	f := newBatchFixture(t, func(prs map[int]*hubPr) {
		prs[3].lateGate = true
		prs[3].syncReview = true
	})
	f.start(2, 3)
	run := f.waitEnd()
	if run.State != BatchDone || !slices.Equal(f.hub.merged(), []int{2, 3}) {
		t.Fatalf("state %s, merged %v, want done with 2 and 3: %+v", run.State, f.hub.merged(), run)
	}
	if f.hub.gateAtMerge[3] != hubCheckSuccess {
		t.Fatalf("#3 was merged while its gate job was %q", f.hub.gateAtMerge[3])
	}
}

// #887: right after the rebase GitHub shows no check on the new head yet; within the settle time every check of the old
// head is expected, so #3 is not merged before its CI ran.
func TestBatchExpectsTheOldChecksWhileThePushSettles(t *testing.T) {
	f := newBatchFixture(t, func(prs map[int]*hubPr) { prs[3].slowStart = true })
	f.runner.env.ChecksSettle = time.Hour
	f.start(2, 3)
	run := f.waitEnd()
	if run.State != BatchDone || !slices.Equal(f.hub.merged(), []int{2, 3}) {
		t.Fatalf("state %s, merged %v, want done with 2 and 3: %+v", run.State, f.hub.merged(), run)
	}
	if f.hub.checksAtMerge[3] != hubCheckSuccess {
		t.Fatalf("#3 was merged while its checks were %s", f.hub.checksAtMerge[3])
	}
}

func TestMissingChecks(t *testing.T) {
	ci := mission.ReviewCheck{Name: "Backend", Workflow: "CI", State: mission.ReviewCheckSuccess}
	gate := mission.ReviewCheck{Name: "Required gate", Workflow: "CI", State: mission.ReviewCheckSuccess}
	sync := mission.ReviewCheck{Name: "sync-review", Workflow: "PR review sync", State: mission.ReviewCheckSuccess}
	status := mission.ReviewCheck{Name: "deploy/preview", State: mission.ReviewCheckSuccess}
	old := []mission.ReviewCheck{ci, gate, sync, status}
	if got := missingChecks(old, nil, false); !slices.Equal(got, []string{"Backend", "Required gate", "sync-review", "deploy/preview"}) {
		t.Fatalf("before the push settled every old check is expected: %v", got)
	}
	if got := missingChecks(old, []mission.ReviewCheck{ci}, false); !slices.Equal(got, []string{"Required gate", "sync-review", "deploy/preview"}) {
		t.Fatalf("unsettled: %v", got)
	}
	if got := missingChecks(old, []mission.ReviewCheck{ci}, true); !slices.Equal(got, []string{"Required gate"}) {
		t.Fatalf("settled: only the job of a workflow running on the new head is waited for: %v", got)
	}
	if got := missingChecks(old, []mission.ReviewCheck{ci, gate}, true); len(got) != 0 {
		t.Fatalf("settled with CI complete: %v", got)
	}
	if got := missingChecks(nil, nil, true); len(got) != 0 {
		t.Fatalf("no rebase, nothing expected: %v", got)
	}
}

// TC-REV-019, FR-REV-026 AC4: #3's checks fail after its rebase; it is set aside with its notification and #1 after it
// is merged all the same. Nothing red is merged.
func TestQueueFailingCheckStopsOnlyThatPr(t *testing.T) {
	f := newBatchFixture(t, func(prs map[int]*hubPr) { prs[3].failAfterPush = true })
	f.start(2, 3, 1)
	run := f.waitFor("#1 merged after #3 failed", func(run BatchRun) bool { return itemOf(run, 1).State == BatchItemMerged })
	three := itemOf(run, 3)
	if three.State != BatchItemFailed || three.Reason != BatchReasonFailing || !slices.Equal(three.Names, []string{"ci"}) {
		t.Fatalf("#3: %+v", three)
	}
	if got := f.hub.merged(); !slices.Equal(got, []int{2, 1}) {
		t.Fatalf("merged %v, want 2 then 1", got)
	}
	failed := f.notices.find(":stop:")
	if failed == nil || failed.TitleText.Code != "notif.review.queue.failedTitle" || failed.TitleText.Vars["number"] != "3" ||
		failed.TitleText.Vars["names"] != "ci" || len(failed.Actions) == 0 || failed.Actions[0].Gesture != InvestigateGesture {
		t.Fatalf("the notification should say #3 failed on ci and offer Investigate and fix: %+v", failed)
	}
	if run.State != BatchRunning {
		t.Fatalf("the queue keeps watching #3: %s", run.State)
	}
	if _, err := f.runner.Withdraw(QueueWithdrawRequest{Dir: f.dir, Base: "develop", Number: 3}); err != nil {
		t.Fatal(err)
	}
	run = f.waitEnd()
	if three := itemOf(run, 3); three.State != BatchItemWithdrawn || !three.ByYou || run.State != BatchDone {
		t.Fatalf("run %s, #3 %+v", run.State, three)
	}
	end := f.notices.find(":end:")
	if end == nil || end.Kind != "warning" || end.MessageText.Parts["skipped"].Vars["number"] != "3" {
		t.Fatalf("the end notification should list #3 as not merged: %+v", end)
	}
	merged := f.notices.find(":merged")
	if merged == nil || merged.TitleText.Code != "notif.review.queue.mergedTitle" || merged.TitleText.Vars["time"] == "" {
		t.Fatalf("each merge says when the PR was validated: %+v", merged)
	}
}

// A failed PR whose checks are rerun green on the same head (a flaky job rerun by the agent, #896) merges without a new
// validation.
func TestQueueFailedPrComesBackWhenItsChecksPassAgain(t *testing.T) {
	f := newBatchFixture(t, func(prs map[int]*hubPr) { prs[4].failing = true })
	f.start(4)
	f.waitFor("#4 failed", func(run BatchRun) bool { return itemOf(run, 4).State == BatchItemFailed })
	if len(f.hub.merged()) != 0 {
		t.Fatalf("a red PR was merged: %v", f.hub.merged())
	}
	f.setPr(4, func(pr *hubPr) { pr.failing = false })
	run := f.waitEnd()
	if !slices.Equal(f.hub.merged(), []int{4}) || run.State != BatchDone || f.hub.checksAtMerge[4] != hubCheckSuccess {
		t.Fatalf("state %s, merged %v, checks at merge %s", run.State, f.hub.merged(), f.hub.checksAtMerge[4])
	}
}

// FR-REV-026 AC1, AC3: Validate on a PR whose checks run queues it; it merges once they pass, with no time limit.
func TestQueueValidateWhileCiRunsMergesOnceGreen(t *testing.T) {
	f := newBatchFixture(t, func(prs map[int]*hubPr) { prs[1].pendingForever = true })
	plan, err := f.merger.Plan(context.Background(), MergePlanRequest{PrKey: PrKey{Repo: testRepo, Number: 1}, Dir: f.dir})
	if err != nil {
		t.Fatal(err)
	}
	if plan.CanMerge || !plan.CanQueue || plan.GreenOnly {
		t.Fatalf("a plan whose only wait is the CI can be validated now: canmerge %v, canqueue %v", plan.CanMerge, plan.CanQueue)
	}
	if _, err := f.validate(1); err != nil {
		t.Fatal(err)
	}
	run := f.waitFor("#1 waiting for its checks", func(run BatchRun) bool { return itemOf(run, 1).State == BatchItemWaitingChecks })
	if one := itemOf(run, 1); one.Valid != f.prs[1].HeadOid || one.Source != BatchSourceValidate || one.Method != "merge" {
		t.Fatalf("the validation is bound to the reviewed head: %+v", one)
	}
	if len(f.hub.merged()) != 0 {
		t.Fatalf("merged while its checks run: %v", f.hub.merged())
	}
	f.setPr(1, func(pr *hubPr) { pr.pendingForever = false })
	run = f.waitEnd()
	if !slices.Equal(f.hub.merged(), []int{1}) || f.hub.checksAtMerge[1] != hubCheckSuccess || run.State != BatchDone {
		t.Fatalf("state %s, merged %v at %s", run.State, f.hub.merged(), f.hub.checksAtMerge[1])
	}
}

// Developer decision 2026-10-17 (AC10): with review:validategreenonly on, Validate stays blocked while checks run.
func TestQueueGreenOnlySettingKeepsValidateBlocked(t *testing.T) {
	f := newBatchFixture(t, func(prs map[int]*hubPr) { prs[1].pendingForever = true })
	f.merger.greenOnly = func() bool { return true }
	plan, err := f.merger.Plan(context.Background(), MergePlanRequest{PrKey: PrKey{Repo: testRepo, Number: 1}, Dir: f.dir})
	if err != nil {
		t.Fatal(err)
	}
	if plan.CanQueue || !plan.GreenOnly || plan.CanMerge {
		t.Fatalf("the setting keeps it blocked and says so: canqueue %v, greenonly %v", plan.CanQueue, plan.GreenOnly)
	}
	pr := f.prs[1]
	pr.PlanId = plan.Id
	if _, err := f.runner.Add(QueueAddRequest{Dir: f.dir, Repo: testRepo, Base: "develop", Prs: []BatchPr{pr}, WorkspaceId: "ws"}); err == nil ||
		!strings.Contains(err.Error(), mergeErrorPrefix+MergeErrBlocked) {
		t.Fatalf("the queue refuses a plan the setting blocks: %v", err)
	}
	failing := newBatchFixture(t, func(prs map[int]*hubPr) { prs[4].failing = true })
	plan, _ = failing.merger.Plan(context.Background(), MergePlanRequest{PrKey: PrKey{Repo: testRepo, Number: 4}, Dir: failing.dir})
	if plan.CanQueue {
		t.Fatalf("a failing check blocks Validate either way")
	}
}

// FR-REV-026 AC2: two PRs validated in the reverse of the suggested order merge in the suggested order; the first one
// validated only waited for its checks and gives its turn back.
func TestQueueMergesInTheSuggestedOrder(t *testing.T) {
	f := newBatchFixture(t, func(prs map[int]*hubPr) {
		prs[4].pendingForever = true
		prs[1].pendingForever = true
	})
	if _, err := f.validate(4, 1, 4); err != nil {
		t.Fatal(err)
	}
	f.waitFor("#4 waiting for its checks", func(run BatchRun) bool { return itemOf(run, 4).State == BatchItemWaitingChecks })
	if _, err := f.validate(1, 1, 4); err != nil {
		t.Fatal(err)
	}
	run := f.waitFor("#1 first", func(run BatchRun) bool {
		return len(run.Items) == 2 && run.Items[0].Number == 1 && itemOf(run, 1).State == BatchItemWaitingChecks
	})
	if four := itemOf(run, 4); four.State != BatchItemQueued {
		t.Fatalf("#4 waits its turn again: %+v", four)
	}
	f.setPr(4, func(pr *hubPr) { pr.pendingForever = false })
	f.setPr(1, func(pr *hubPr) { pr.pendingForever = false })
	f.waitEnd()
	if got := f.hub.merged(); !slices.Equal(got, []int{1, 4}) {
		t.Fatalf("merged %v, want the suggested order 1 then 4", got)
	}
}

// FR-REV-026 AC5: a push the queue did not make voids the validation: the PR leaves the queue, never merged.
func TestQueuePushBySomeoneElseVoidsTheValidation(t *testing.T) {
	f := newBatchFixture(t, func(prs map[int]*hubPr) { prs[1].pendingForever = true })
	if _, err := f.validate(1); err != nil {
		t.Fatal(err)
	}
	f.waitFor("#1 waiting for its checks", func(run BatchRun) bool { return itemOf(run, 1).State == BatchItemWaitingChecks })
	pushed := f.push(1)
	run := f.waitEnd()
	one := itemOf(run, 1)
	if one.State != BatchItemVoided || one.Reason != BatchReasonPushed || one.Head != pushed || len(f.hub.merged()) != 0 {
		t.Fatalf("#1 %+v, merged %v", one, f.hub.merged())
	}
	voided := f.notices.find(":voided:")
	if voided == nil || voided.TitleText.Code != "notif.review.queue.voidedTitle" || voided.MessageText.Vars["head"] != shortHead(pushed) {
		t.Fatalf("the notification should say #1 changed after the validation: %+v", voided)
	}
}

// FR-REV-026 AC7: Cancel validation withdraws a PR before its merge; the others go on.
func TestQueueCancelValidationBeforeTheMerge(t *testing.T) {
	f := newBatchFixture(t, func(prs map[int]*hubPr) { prs[1].pendingForever = true })
	f.start(1, 4)
	f.waitFor("#1 waiting for its checks", func(run BatchRun) bool { return itemOf(run, 1).State == BatchItemWaitingChecks })
	if _, err := f.runner.Withdraw(QueueWithdrawRequest{Dir: f.dir, Base: "develop", Number: 1}); err != nil {
		t.Fatal(err)
	}
	run := f.waitEnd()
	if one := itemOf(run, 1); one.State != BatchItemWithdrawn || one.Reason != BatchReasonWithdrawn || !one.ByYou {
		t.Fatalf("#1: %+v", one)
	}
	if !slices.Equal(f.hub.merged(), []int{4}) || run.State != BatchDone {
		t.Fatalf("state %s, merged %v", run.State, f.hub.merged())
	}
	if _, err := f.runner.Withdraw(QueueWithdrawRequest{Dir: f.dir, Base: "develop", Number: 4}); err == nil {
		t.Fatalf("a merged PR cannot be withdrawn")
	}
}

// TC-REV-020: Cancel while the first PR waits for its checks ends the queue; nothing is merged.
func TestBatchCancelWhileWaitingForChecks(t *testing.T) {
	f := newBatchFixture(t, func(prs map[int]*hubPr) { prs[1].pendingForever = true })
	f.start(1, 4)
	run := f.waitFor("#1 waiting for its checks", func(run BatchRun) bool {
		return itemOf(run, 1).State == BatchItemWaitingChecks
	})
	if _, err := f.runner.Cancel(BatchRequest{Dir: f.dir, Base: "develop", Id: run.Id}); err != nil {
		t.Fatal(err)
	}
	run = f.waitEnd()
	if run.State != BatchCancelled || len(f.hub.merged()) != 0 {
		t.Fatalf("state %s, merged %v", run.State, f.hub.merged())
	}
	for _, n := range []int{1, 4} {
		if it := itemOf(run, n); it.State != BatchItemWithdrawn || it.Reason != BatchReasonCancelled {
			t.Fatalf("#%d: %+v", n, it)
		}
	}
	end := f.notices.find(":end:")
	if end == nil || end.TitleText.Code != "notif.review.batch.cancelledTitle" {
		t.Fatalf("the end notification should say it was cancelled: %+v", end)
	}
}

// An ambiguous conflict takes its PR out of the queue for the developer; the PR after it is still rebased and merged.
func TestBatchStopsOnAnAmbiguousConflict(t *testing.T) {
	f := newBatchFixture(t, nil)
	f.agent.ambiguous[5] = true
	f.start(2, 5, 3)
	run := f.waitEnd()
	five := itemOf(run, 5)
	if five.State != BatchItemStopped || five.Reason != BatchReasonAmbiguous || !strings.Contains(five.Note, "line 2") {
		t.Fatalf("#5: %+v", five)
	}
	if got := f.hub.merged(); !slices.Equal(got, []int{2, 3}) {
		t.Fatalf("merged %v, want 2 then 3", got)
	}
	stop := f.notices.find(":stop:")
	if stop == nil || stop.TitleText.Code != "notif.review.queue.stoppedTitle" || stop.TitleText.Vars["number"] != "5" ||
		stop.MessageText.Parts["reason"].Code != "notif.review.batch.why.ambiguousNote" {
		t.Fatalf("one needs-you notification on #5: %+v", stop)
	}
	if !run.Cleaned {
		t.Fatalf("the agent's worktree should go: kept %q", run.Kept)
	}
}

// An agent that does not start stops its PR; its empty terminal goes, and validating it again starts a new one.
func TestQueueAgentStartFails(t *testing.T) {
	f := newBatchFixture(t, nil)
	f.agent.failStarts = 1
	f.start(2, 3)
	run := f.waitEnd()
	if three := itemOf(run, 3); three.State != BatchItemStopped || three.Reason != BatchReasonAgentStart || run.BlockId != "" {
		t.Fatalf("#3 %+v, block %q", three, run.BlockId)
	}
	f.agent.lock.Lock()
	closed := slices.Contains(f.agent.closed, "block-dead")
	f.agent.lock.Unlock()
	if !closed {
		t.Fatalf("the terminal without an agent should be closed")
	}
	f.start(3)
	run = f.waitEnd()
	if !slices.Equal(f.hub.merged(), []int{2, 3}) || run.State != BatchDone || f.agent.started != 1 {
		t.Fatalf("state %s, merged %v, started %d", run.State, f.hub.merged(), f.agent.started)
	}
}

func TestBatchSkipsAPrMergedElsewhere(t *testing.T) {
	f := newBatchFixture(t, func(prs map[int]*hubPr) { prs[1].state = "MERGED" })
	f.start(1, 4)
	run := f.waitEnd()
	if one := itemOf(run, 1); one.State != BatchItemSkipped || one.Reason != BatchReasonMergedAway {
		t.Fatalf("#1: %+v", one)
	}
	if !slices.Equal(f.hub.merged(), []int{4}) {
		t.Fatalf("merged %v", f.hub.merged())
	}
}

func TestQueueAddChecks(t *testing.T) {
	f := newBatchFixture(t, func(prs map[int]*hubPr) { prs[1].pendingForever = true })
	if _, err := f.runner.Add(QueueAddRequest{Dir: f.dir, Repo: testRepo, Base: "develop", WorkspaceId: "ws"}); err == nil {
		t.Fatalf("an empty batch should be refused")
	}
	bad := f.prs[1]
	bad.HeadOid = "nope"
	if _, err := f.runner.Add(QueueAddRequest{Dir: f.dir, Repo: testRepo, Base: "develop", WorkspaceId: "ws", Prs: []BatchPr{bad}}); err == nil {
		t.Fatalf("a PR without its head should be refused")
	}
	stale := f.prs[4]
	stale.PlanId = "no-such-plan"
	if _, err := f.runner.Add(QueueAddRequest{Dir: f.dir, Repo: testRepo, Base: "develop", WorkspaceId: "ws", Prs: []BatchPr{stale}}); err == nil {
		t.Fatalf("a plan wavesrv does not hold should be refused")
	}
	run := f.start(1)
	more, err := f.runner.Add(QueueAddRequest{Dir: f.dir, Repo: testRepo, Base: "develop", WorkspaceId: "ws", Prs: []BatchPr{f.prs[4]}})
	if err != nil || more.Id != run.Id || len(more.Items) != 2 {
		t.Fatalf("a PR validated later joins the same queue: %+v, %v", more, err)
	}
}

// FR-REV-026 AC2: a queue kept as running when wavesrv stopped resumes when it starts again, and says so.
func TestQueueResumesAfterARestart(t *testing.T) {
	f := newBatchFixture(t, nil)
	f.start(1)
	done := f.waitEnd()
	if done.State != BatchDone {
		t.Fatalf("state %s", done.State)
	}
	kept := done
	kept.Id, kept.State, kept.Current, kept.Dismissed, kept.EndedAt = "kept-queue", BatchRunning, 0, false, 0
	four := BatchItem{BatchPr: f.prs[4], State: BatchItemWaitingChecks, Valid: f.prs[4].HeadOid, ValidatedAt: 1}
	kept.Items = []BatchItem{four}
	f.runner.save(kept)
	restarted := MakeBatchRunner(f.runner.env)
	f.runner = restarted
	restarted.Resume()
	run := f.waitEnd()
	if run.Id != "kept-queue" || run.ResumedAt == 0 || run.State != BatchDone || !slices.Equal(f.hub.merged(), []int{1, 4}) {
		t.Fatalf("the kept queue should resume and merge #4: %+v, merged %v", run, f.hub.merged())
	}
	resumed := f.notices.find(":resumed:")
	if resumed == nil || resumed.TitleText.Code != "notif.review.queue.resumedTitle" || resumed.TitleText.Vars["count"] != "1" {
		t.Fatalf("the queue should say it resumed: %+v", resumed)
	}
	again := MakeBatchRunner(BatchEnv{DataDir: f.data})
	if _, err := again.Dismiss(BatchRequest{Dir: f.dir, Base: "develop"}); err != nil {
		t.Fatal(err)
	}
	if read, _ := again.Get(BatchRequest{Dir: f.dir, Base: "develop"}); read == nil || !read.Dismissed || read.Id != "kept-queue" {
		t.Fatalf("a dismissed queue stays dismissed: %+v", read)
	}
}

func TestReorderKeepsStartedPrsInPlace(t *testing.T) {
	items := []BatchItem{
		{BatchPr: BatchPr{Number: 1}, State: BatchItemMerged},
		{BatchPr: BatchPr{Number: 2}, State: BatchItemWaitingChecks},
		{BatchPr: BatchPr{Number: 3}, State: BatchItemQueued},
		{BatchPr: BatchPr{Number: 4}, State: BatchItemQueued},
		{BatchPr: BatchPr{Number: 5}, State: BatchItemQueued},
	}
	reorder(items, 1, []int{4, 2, 3})
	var got []int
	for _, it := range items {
		got = append(got, it.Number)
	}
	if !slices.Equal(got, []int{1, 2, 4, 3, 5}) {
		t.Fatalf("order %v", got)
	}
}

func TestQueueableWaitsOnlyForTheCi(t *testing.T) {
	pending := MergeCheck{Id: CheckIdCi, State: CheckPending}
	cases := []struct {
		checks []MergeCheck
		want   bool
	}{
		{[]MergeCheck{pending, {Id: CheckIdConflict, State: CheckOk}}, true},
		{[]MergeCheck{pending, {Id: CheckIdBlocked, State: CheckPending, Code: checkCodeWaitsCi}}, true},
		{[]MergeCheck{pending, {Id: CheckIdComments, State: CheckWarn}}, true},
		{[]MergeCheck{{Id: CheckIdCi, State: CheckOk}}, false},
		{[]MergeCheck{pending, {Id: CheckIdBlocked, State: CheckFail}}, false},
		{[]MergeCheck{pending, {Id: CheckIdConflict, State: CheckPending}}, false},
		{[]MergeCheck{{Id: CheckIdCi, State: CheckFail}}, false},
	}
	for i, c := range cases {
		if got := queueable(c.checks); got != c.want {
			t.Errorf("case %d: queueable %v, want %v", i, got, c.want)
		}
	}
}

func TestBatchReasonsAreWorded(t *testing.T) {
	for _, reason := range []string{BatchReasonFailing, BatchReasonAmbiguous, BatchReasonConflict, BatchReasonAgentExited,
		BatchReasonAgentTimeout, BatchReasonNoAgent, BatchReasonAgentStart, BatchReasonBlocked, BatchReasonWarnings,
		BatchReasonCiTimeout, BatchReasonUnknown, BatchReasonMergeFailed, BatchReasonRead, BatchReasonHeadMoved,
		BatchReasonDraft, BatchReasonMergedAway, BatchReasonClosed, BatchReasonCancelled, BatchReasonInterrupted,
		BatchReasonPushed, BatchReasonWithdrawn} {
		_, text := batchReasonText(BatchItem{Reason: reason, Names: []string{"ci"}}, "develop")
		if text.Code == "notif.review.batch.why.notreached" {
			t.Errorf("reason %s has no sentence", reason)
		}
	}
	_, list := batchSkippedList([]BatchItem{{BatchPr: BatchPr{Number: 3}, Reason: BatchReasonFailing}, {BatchPr: BatchPr{Number: 4}}}, "develop")
	if list.Code != "notif.review.batch.skippedFirst" || list.Parts["rest"].Vars["number"] != "4" || list.Parts["rest"].Vars["rest"] != "" {
		t.Fatalf("skipped list: %+v", list)
	}
}
