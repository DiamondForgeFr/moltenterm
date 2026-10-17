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
		f.runner.Cancel(BatchRequest{Dir: dir})
		f.waitDone()
		f.agent.stop()
	})
	return f
}

func (f *batchFixture) start(numbers ...int) BatchRun {
	f.t.Helper()
	var prs []BatchPr
	for _, n := range numbers {
		prs = append(prs, f.prs[n])
	}
	run, err := f.runner.Start(BatchStartRequest{Dir: f.dir, Repo: testRepo, Base: "develop", Method: "merge", Prs: prs, WorkspaceId: "ws"})
	if err != nil {
		f.t.Fatal(err)
	}
	return run
}

func (f *batchFixture) get() BatchRun {
	f.t.Helper()
	run, err := f.runner.Get(BatchRequest{Dir: f.dir})
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
		f.runner.wait(f.dir)
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

// TC-REV-019: the second PR's checks fail after its rebase; the batch stops on it and the third is not merged.
func TestBatchStopsOnAFailingCheckAndWaitsForTheDecision(t *testing.T) {
	f := newBatchFixture(t, func(prs map[int]*hubPr) { prs[3].failAfterPush = true })
	f.start(2, 3, 1)
	run := f.waitFor("the stop on #3", func(run BatchRun) bool { return run.State == BatchPaused })
	three := itemOf(run, 3)
	if three.State != BatchItemStopped || three.Reason != BatchReasonFailing || !slices.Equal(three.Names, []string{"ci"}) {
		t.Fatalf("#3: %+v", three)
	}
	if got := f.hub.merged(); !slices.Equal(got, []int{2}) {
		t.Fatalf("merged %v while stopped, want only 2", got)
	}
	stop := f.notices.find(":stop:")
	if stop == nil || stop.TitleText.Vars["number"] != "3" || stop.MessageText.Parts["reason"].Vars["names"] != "ci" || stop.BlockId != "block-agent" {
		t.Fatalf("the stop notification should name #3, its failing check and the agent's terminal: %+v", stop)
	}
	if _, err := f.runner.Decide(BatchDecideRequest{Dir: f.dir, Id: run.Id, Decision: BatchDecisionSkip}); err != nil {
		t.Fatal(err)
	}
	run = f.waitEnd()
	if got := f.hub.merged(); !slices.Equal(got, []int{2, 1}) {
		t.Fatalf("merged %v, want 2 then 1 after skipping 3", got)
	}
	// Skipping the PR sets the run going again for the PRs after it.
	if states := f.notices.runStates(); !slices.Equal(states, []string{BatchRunning, BatchPaused, BatchRunning, BatchDone}) {
		t.Fatalf("run states %v", states)
	}
	three = itemOf(run, 3)
	if three.State != BatchItemSkipped || !three.ByYou || three.Reason != BatchReasonFailing || run.State != BatchDone {
		t.Fatalf("run %s, #3 %+v", run.State, three)
	}
	end := f.notices.find(":end:")
	if end == nil || end.Kind != "warning" || end.MessageText.Parts["skipped"].Vars["number"] != "3" {
		t.Fatalf("the end notification should list #3 as skipped: %+v", end)
	}
}

func TestBatchEndDecisionMergesNothingMore(t *testing.T) {
	f := newBatchFixture(t, func(prs map[int]*hubPr) { prs[4].failing = true })
	f.start(4, 1)
	run := f.waitFor("the stop on #4", func(run BatchRun) bool { return run.State == BatchPaused })
	if f.agent.started != 0 {
		t.Fatalf("a failing PR that merges cleanly needs no agent")
	}
	if _, err := f.runner.Decide(BatchDecideRequest{Dir: f.dir, Id: run.Id, Decision: BatchDecisionEnd}); err != nil {
		t.Fatal(err)
	}
	run = f.waitEnd()
	if len(f.hub.merged()) != 0 || run.State != BatchCancelled {
		t.Fatalf("merged %v, state %s", f.hub.merged(), run.State)
	}
	if one := itemOf(run, 1); one.State != BatchItemSkipped || one.Reason != BatchReasonNotReached {
		t.Fatalf("#1: %+v", one)
	}
}

// TC-REV-020: Cancel while the first PR waits for its checks ends the batch; nothing is merged.
func TestBatchCancelWhileWaitingForChecks(t *testing.T) {
	f := newBatchFixture(t, func(prs map[int]*hubPr) { prs[1].pendingForever = true })
	f.start(1, 4)
	run := f.waitFor("#1 waiting for its checks", func(run BatchRun) bool {
		return itemOf(run, 1).State == BatchItemWaitingChecks
	})
	if _, err := f.runner.Cancel(BatchRequest{Dir: f.dir, Id: run.Id}); err != nil {
		t.Fatal(err)
	}
	run = f.waitEnd()
	if run.State != BatchCancelled || len(f.hub.merged()) != 0 {
		t.Fatalf("state %s, merged %v", run.State, f.hub.merged())
	}
	if one := itemOf(run, 1); one.State != BatchItemSkipped || one.Reason != BatchReasonCancelled {
		t.Fatalf("#1: %+v", one)
	}
	if four := itemOf(run, 4); four.State != BatchItemSkipped || four.Reason != BatchReasonNotReached {
		t.Fatalf("#4: %+v", four)
	}
	end := f.notices.find(":end:")
	if end == nil || end.TitleText.Code != "notif.review.batch.cancelledTitle" {
		t.Fatalf("the end notification should say it was cancelled: %+v", end)
	}
}

func TestBatchStopsOnAnAmbiguousConflict(t *testing.T) {
	f := newBatchFixture(t, nil)
	f.agent.ambiguous[5] = true
	f.start(2, 5, 3)
	run := f.waitFor("the stop on #5", func(run BatchRun) bool { return run.State == BatchPaused })
	five := itemOf(run, 5)
	if five.Reason != BatchReasonAmbiguous || !strings.Contains(five.Note, "line 2") {
		t.Fatalf("#5: %+v", five)
	}
	if got := f.hub.merged(); !slices.Equal(got, []int{2}) {
		t.Fatalf("merged %v", got)
	}
	if _, err := f.runner.Cancel(BatchRequest{Dir: f.dir, Id: run.Id}); err != nil {
		t.Fatal(err)
	}
	run = f.waitEnd()
	if run.State != BatchCancelled || !slices.Equal(f.hub.merged(), []int{2}) {
		t.Fatalf("state %s, merged %v", run.State, f.hub.merged())
	}
	// The agent aborted its rebase and pushed nothing: its worktree is clean and goes.
	if !run.Cleaned {
		t.Fatalf("the agent's worktree should go: kept %q", run.Kept)
	}
}

// An agent that does not start stops the run; its empty terminal goes, and Try again starts a new one.
func TestBatchAgentThatDoesNotStartStopsAndRetryStartsAnother(t *testing.T) {
	f := newBatchFixture(t, nil)
	f.agent.failStarts = 1
	f.start(2, 3)
	run := f.waitFor("the stop on #3", func(run BatchRun) bool { return run.State == BatchPaused })
	if three := itemOf(run, 3); three.Reason != BatchReasonAgentStart || run.BlockId != "" {
		t.Fatalf("#3 %+v, block %q", three, run.BlockId)
	}
	f.agent.lock.Lock()
	closed := slices.Contains(f.agent.closed, "block-dead")
	f.agent.lock.Unlock()
	if !closed {
		t.Fatalf("the terminal without an agent should be closed")
	}
	if _, err := f.runner.Decide(BatchDecideRequest{Dir: f.dir, Id: run.Id, Decision: BatchDecisionRetry}); err != nil {
		t.Fatal(err)
	}
	run = f.waitEnd()
	if !slices.Equal(f.hub.merged(), []int{2, 3}) || run.State != BatchDone || f.agent.started != 1 {
		t.Fatalf("state %s, merged %v, started %d", run.State, f.hub.merged(), f.agent.started)
	}
}

func TestBatchRetryAfterTheDeveloperFixedThePr(t *testing.T) {
	f := newBatchFixture(t, func(prs map[int]*hubPr) { prs[4].failing = true })
	f.start(4)
	run := f.waitFor("the stop on #4", func(run BatchRun) bool { return run.State == BatchPaused })
	f.hub.lock.Lock()
	f.hub.prs[4].failing = false
	f.hub.lock.Unlock()
	if _, err := f.runner.Decide(BatchDecideRequest{Dir: f.dir, Id: run.Id, Decision: BatchDecisionRetry}); err != nil {
		t.Fatal(err)
	}
	run = f.waitEnd()
	if !slices.Equal(f.hub.merged(), []int{4}) || run.State != BatchDone {
		t.Fatalf("state %s, merged %v", run.State, f.hub.merged())
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

func TestBatchStartChecks(t *testing.T) {
	f := newBatchFixture(t, func(prs map[int]*hubPr) { prs[1].pendingForever = true })
	if _, err := f.runner.Start(BatchStartRequest{Dir: f.dir, Repo: testRepo, Base: "develop", WorkspaceId: "ws"}); err == nil {
		t.Fatalf("an empty batch should be refused")
	}
	bad := f.prs[1]
	bad.HeadOid = "nope"
	if _, err := f.runner.Start(BatchStartRequest{Dir: f.dir, Repo: testRepo, Base: "develop", WorkspaceId: "ws", Prs: []BatchPr{bad}}); err == nil {
		t.Fatalf("a PR without its head should be refused")
	}
	run := f.start(1)
	if _, err := f.runner.Start(BatchStartRequest{Dir: f.dir, Repo: testRepo, Base: "develop", WorkspaceId: "ws", Prs: []BatchPr{f.prs[4]}}); err == nil {
		t.Fatalf("a second batch in the same project should be refused")
	}
	if _, err := f.runner.Decide(BatchDecideRequest{Dir: f.dir, Id: run.Id, Decision: BatchDecisionSkip}); err == nil {
		t.Fatalf("a decision while nothing stopped should be refused")
	}
}

func TestBatchRunIsKeptAndReadsInterruptedAfterARestart(t *testing.T) {
	f := newBatchFixture(t, nil)
	f.start(1)
	done := f.waitEnd()
	again := MakeBatchRunner(BatchEnv{DataDir: f.data})
	kept, err := again.Get(BatchRequest{Dir: f.dir})
	if err != nil || kept == nil || kept.Id != done.Id || kept.State != BatchDone {
		t.Fatalf("the ended run should be read back: %+v, %v", kept, err)
	}
	if _, err := again.Dismiss(BatchRequest{Dir: f.dir}); err != nil {
		t.Fatal(err)
	}
	if kept, _ := again.Get(BatchRequest{Dir: f.dir}); kept == nil || !kept.Dismissed {
		t.Fatalf("a dismissed run stays dismissed: %+v", kept)
	}
	running := done
	running.Id, running.State, running.Current, running.Dismissed = "interrupted-run", BatchRunning, 0, false
	running.Items = []BatchItem{{BatchPr: f.prs[4], State: BatchItemWaitingChecks}}
	again.save(running)
	kept, _ = again.Get(BatchRequest{Dir: f.dir})
	if kept == nil || kept.State != BatchInterrupted || kept.Items[0].Reason != BatchReasonInterrupted {
		t.Fatalf("a run wavesrv no longer runs reads interrupted: %+v", kept)
	}
}

func TestBatchReasonsAreWorded(t *testing.T) {
	for _, reason := range []string{BatchReasonFailing, BatchReasonAmbiguous, BatchReasonConflict, BatchReasonAgentExited,
		BatchReasonAgentTimeout, BatchReasonNoAgent, BatchReasonAgentStart, BatchReasonBlocked, BatchReasonWarnings,
		BatchReasonCiTimeout, BatchReasonUnknown, BatchReasonMergeFailed, BatchReasonRead, BatchReasonHeadMoved,
		BatchReasonDraft, BatchReasonMergedAway, BatchReasonClosed, BatchReasonCancelled, BatchReasonInterrupted} {
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
