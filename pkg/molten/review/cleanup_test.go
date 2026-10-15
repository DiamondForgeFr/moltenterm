// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/molten/reviewsession"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const cleanupRepo = "acme/app"

// cleanupFixture: a project cloned from a local bare remote, whose PR #7 (feature/7-thing, ticket #7) was merged by
// rebase into develop and its remote branch deleted, with the agent's worktree still on the branch. gh is a fake; the
// workflow CLI is a script that logs.
type cleanupFixture struct {
	t       *testing.T
	root    string
	remote  string
	dir     string
	agent   string
	dataDir string
	headOid string
	// prHead: the head gh says it merged; headOid when empty.
	prHead string

	lock      sync.Mutex
	ghCalls   [][]string
	prState   string
	issue     string
	openPrs   string
	// openPrsSeq: the answers of the first gh pr list calls, in order, before openPrs (GitHub computing mergeability).
	openPrsSeq []string
	ghFail     map[string]error
	terminals  map[string][]mission.WorktreeTerminal
	states     map[string]string
	ended      []int
	// The other PRs' agents, reached through Ask for a rebase's routing: runs by block, what was typed in each.
	runs          map[string]molten.AgentRunInfo
	typed         map[string]string
	opened        int
	mergeableWait time.Duration
}

func gitEnv() []string {
	return append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
		"GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null")
}

func (f *cleanupFixture) git(dir string, args ...string) string {
	f.t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = gitEnv()
	out, err := cmd.CombinedOutput()
	if err != nil {
		f.t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

func (f *cleanupFixture) write(dir string, name string, text string) {
	f.t.Helper()
	path := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		f.t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0700); err != nil {
		f.t.Fatal(err)
	}
}

func realOf(path string) string {
	if real, err := filepath.EvalSymlinks(path); err == nil {
		return real
	}
	return filepath.Clean(path)
}

func makeCleanupFixture(t *testing.T, sfWorkflow bool) *cleanupFixture {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := realOf(t.TempDir())
	f := &cleanupFixture{t: t, root: root, remote: filepath.Join(root, "remote.git"), dir: filepath.Join(root, "app"),
		agent: filepath.Join(root, "app-7"), dataDir: filepath.Join(root, "data"), prState: "MERGED", issue: "OPEN",
		openPrs: "[]", ghFail: map[string]error{}, terminals: map[string][]mission.WorktreeTerminal{}, states: map[string]string{},
		runs: map[string]molten.AgentRunInfo{}, typed: map[string]string{}, mergeableWait: time.Minute}
	f.git(root, "init", "--quiet", "--bare", "-b", "develop", f.remote)
	f.git(root, "clone", "--quiet", f.remote, f.dir)
	f.git(f.dir, "checkout", "--quiet", "-b", "develop")
	f.write(f.dir, ".gitignore", "")
	f.write(f.dir, "a.txt", "one\n")
	if sfWorkflow {
		f.write(f.dir, molten.ProjectSaaSFoundryFile, `{"workflow":{"branchNaming":{"feature":"feature/{N}-{description}"}}}`)
		f.write(f.dir, CleanupWorkflowCliPath, "#!/bin/sh\necho \"$@\" >> \"$(dirname \"$0\")/calls.log\"\n"+
			"if [ \"$1\" = status ]; then echo \"Ticket #$2 is currently in status: In Review\"; fi\n")
		f.write(f.dir, ".gitignore", ".claude/skills/sf-workflow/calls.log\n")
	}
	f.git(f.dir, "add", "-A")
	f.git(f.dir, "commit", "--quiet", "-m", "init")
	f.git(f.dir, "push", "--quiet", "origin", "develop")
	f.git(f.dir, "worktree", "add", "--quiet", "-b", "feature/7-thing", f.agent)
	f.write(f.agent, "b.txt", "feature\n")
	f.git(f.agent, "add", "b.txt")
	f.git(f.agent, "commit", "--quiet", "-m", "feat(#7): thing")
	f.git(f.agent, "push", "--quiet", "origin", "feature/7-thing")
	f.headOid = f.git(f.agent, "rev-parse", "HEAD")
	// The rebase merge: the commit lands on develop under a new id, and the merge deletes the remote branch.
	other := filepath.Join(root, "merger")
	f.git(root, "clone", "--quiet", "-b", "develop", f.remote, other)
	f.write(other, "c.txt", "other change\n")
	f.git(other, "add", "c.txt")
	f.git(other, "commit", "--quiet", "-m", "other")
	f.git(other, "cherry-pick", f.headOid)
	f.git(other, "push", "--quiet", "origin", "develop", ":feature/7-thing")
	return f
}

func (f *cleanupFixture) gh(args []string) ([]byte, error) {
	f.lock.Lock()
	defer f.lock.Unlock()
	f.ghCalls = append(f.ghCalls, args)
	key := strings.Join(args[:min(2, len(args))], " ")
	if err := f.ghFail[key]; err != nil {
		return nil, err
	}
	switch key {
	case "pr view":
		return []byte(fmt.Sprintf(`{"state":%q,"headRefName":"feature/7-thing","headRefOid":%q,"baseRefName":"develop","closingIssuesReferences":[]}`,
			f.prState, cmp.Or(f.prHead, f.headOid))), nil
	case "issue view":
		return []byte(fmt.Sprintf(`{"state":%q}`, f.issue)), nil
	case "pr list":
		if len(f.openPrsSeq) > 0 {
			answer := f.openPrsSeq[0]
			f.openPrsSeq = f.openPrsSeq[1:]
			return []byte(answer), nil
		}
		return []byte(f.openPrs), nil
	}
	return []byte{}, nil
}

func (f *cleanupFixture) run(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
	if name == "gh" {
		return f.gh(args)
	}
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	cmd.Env = gitEnv()
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return out, fmt.Errorf("%s %s: %s", name, strings.Join(args, " "), strings.TrimSpace(stderr.String()))
	}
	return out, nil
}

func (f *cleanupFixture) worktreeTerminals(ctx context.Context, path string) []mission.WorktreeTerminal {
	f.lock.Lock()
	defer f.lock.Unlock()
	return f.terminals[realOf(path)]
}

// restarter is the real Ask for a rebase routing (rebase.go), on fake terminals, agents and typing.
func (f *cleanupFixture) restarter() *Restarter {
	return MakeRestarter(nil, RestartEnv{
		Git: func(ctx context.Context, dir string, args ...string) ([]byte, error) {
			return f.run(ctx, dir, "git", args...)
		},
		DataDir:   f.dataDir,
		Terminals: f.worktreeTerminals,
		AgentRun: func(blockId string) (molten.AgentRunInfo, bool) {
			f.lock.Lock()
			defer f.lock.Unlock()
			run, ok := f.runs[blockId]
			return run, ok
		},
		TypePrompt: func(ctx context.Context, blockId string, line string) RestartTypeOutcome {
			f.lock.Lock()
			defer f.lock.Unlock()
			f.typed[blockId] = line
			return RestartTypeOutcome{Sent: true, Submitted: true}
		},
		OpenTerminal: func(ctx context.Context, tabId string, afterBlockId string, meta waveobj.MetaMapType, line string) (string, error) {
			f.lock.Lock()
			defer f.lock.Unlock()
			f.opened++
			return "new-block", nil
		},
		AgentInstalled: func(agent string) bool { return true },
		AgentOrder:     []string{molten.AgentIdClaude},
	})
}

func (f *cleanupFixture) cleaner() *Cleaner {
	return MakeCleaner(CleanupEnv{
		Run:           f.run,
		Terminals:     f.worktreeTerminals,
		AskRebase:     f.restarter().AskRebase,
		MergeablePoll: time.Millisecond,
		MergeableWait: f.mergeableWait,
		AgentState: func(blockId string) string {
			f.lock.Lock()
			defer f.lock.Unlock()
			return f.states[blockId]
		},
		EndSession: func(ctx context.Context, repo string, number int) error {
			f.lock.Lock()
			defer f.lock.Unlock()
			f.ended = append(f.ended, number)
			return nil
		},
		DataDir: f.dataDir,
	})
}

func (f *cleanupFixture) cleanup(req CleanupRequest) CleanupResult {
	f.t.Helper()
	req.Dir, req.Repo, req.Number = f.dir, cleanupRepo, 7
	result, err := f.cleaner().Run(context.Background(), req)
	if err != nil {
		f.t.Fatalf("cleanup: %v", err)
	}
	return result
}

func (f *cleanupFixture) ghWrites() []string {
	f.lock.Lock()
	defer f.lock.Unlock()
	var rtn []string
	for _, call := range f.ghCalls {
		line := strings.Join(call, " ")
		if strings.HasPrefix(line, "issue close") || strings.HasPrefix(line, "pr update-branch") {
			rtn = append(rtn, line)
		}
	}
	return rtn
}

func (f *cleanupFixture) workflowCalls() string {
	data, _ := os.ReadFile(filepath.Join(f.dir, ".claude/skills/sf-workflow/calls.log"))
	return string(data)
}

func expectStep(t *testing.T, result CleanupResult, id string, state string) *CleanupStepResult {
	t.Helper()
	step := result.Step(id)
	if step == nil {
		t.Fatalf("step %s did not run: %+v", id, result.Steps)
	}
	if step.State != state {
		t.Errorf("step %s: %s (%s%s), want %s", id, step.State, step.Code, step.Error, state)
	}
	return step
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// addOtherPr checks the PR's branch out in its worktree, with an agent in state (and first name) in one terminal.
func (f *cleanupFixture) addOtherPr(number int, branch string, state string, firstName string) string {
	tree := filepath.Join(f.root, fmt.Sprintf("app-%d", number))
	f.git(f.dir, "worktree", "add", "--quiet", "-b", branch, tree, "origin/develop")
	blockId := fmt.Sprintf("block-%d", number)
	f.terminals[realOf(tree)] = []mission.WorktreeTerminal{{BlockId: blockId, Linked: true}}
	f.states[blockId] = state
	f.runs[blockId] = molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: true, State: state, FirstName: firstName}
	return tree
}

func (f *cleanupFixture) ghCount(prefix string) int {
	f.lock.Lock()
	defer f.lock.Unlock()
	count := 0
	for _, call := range f.ghCalls {
		if strings.HasPrefix(strings.Join(call, " "), prefix) {
			count++
		}
	}
	return count
}

func otherPrsByNumber(step *CleanupStepResult) map[int]CleanupPr {
	rtn := map[int]CleanupPr{}
	for _, pr := range step.Prs {
		rtn[pr.Number] = pr
	}
	return rtn
}

func TestCleanupAfterMerge(t *testing.T) {
	f := makeCleanupFixture(t, true)
	review := reviewsession.ReviewTreeDir(f.dataDir, f.dir, 7)
	f.git(f.dir, "worktree", "add", "--quiet", "--detach", review, f.headOid)
	f.addOtherPr(8, "feature/8-busy", molten.AgentStateWorking, "Rita")
	f.addOtherPr(9, "feature/9-idle", molten.AgentStateIdle, "Jérôme")
	f.addOtherPr(12, "feature/12-clean", molten.AgentStateIdle, "Paul")
	// Right after the merge GitHub has not computed the other PRs' mergeability yet.
	f.openPrsSeq = []string{`[{"number":7,"headRefName":"feature/7-thing","mergeable":"MERGEABLE"},
		{"number":8,"headRefName":"feature/8-busy","mergeable":"UNKNOWN","mergeStateStatus":"UNKNOWN"},
		{"number":9,"headRefName":"feature/9-idle","mergeable":"UNKNOWN","mergeStateStatus":"UNKNOWN"},
		{"number":10,"headRefName":"feature/10-none","mergeable":"UNKNOWN","mergeStateStatus":"UNKNOWN"},
		{"number":11,"headRefName":"feature/11-behind","mergeable":"UNKNOWN","mergeStateStatus":"UNKNOWN"},
		{"number":12,"headRefName":"feature/12-clean","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}]`}
	f.openPrs = `[{"number":8,"headRefName":"feature/8-busy","mergeable":"CONFLICTING","mergeStateStatus":"DIRTY","url":"https://x/8"},
		{"number":9,"headRefName":"feature/9-idle","headRefOid":"0123456789abcdef0123456789abcdef01234567","title":"Fix idle","mergeable":"CONFLICTING","mergeStateStatus":"DIRTY","url":"https://x/9"},
		{"number":10,"headRefName":"feature/10-none","mergeable":"UNKNOWN","mergeStateStatus":"DIRTY","url":"https://x/10"},
		{"number":11,"headRefName":"feature/11-behind","mergeable":"MERGEABLE","mergeStateStatus":"BEHIND"},
		{"number":12,"headRefName":"feature/12-clean","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}]`

	result := f.cleanup(CleanupRequest{})

	if result.Ticket != 7 || result.Branch != "feature/7-thing" || result.Base != "develop" {
		t.Errorf("facts: %+v", result)
	}
	expectStep(t, result, CleanupStepPr, CleanupStateDone)
	expectStep(t, result, CleanupStepTicketClose, CleanupStateDone)
	expectStep(t, result, CleanupStepTicketDone, CleanupStateDone)
	expectStep(t, result, CleanupStepReviewTree, CleanupStateDone)
	expectStep(t, result, CleanupStepAgentTree, CleanupStateDone)
	expectStep(t, result, CleanupStepLocalBranch, CleanupStateDone)
	expectStep(t, result, CleanupStepRemoteBranch, CleanupStateDone)
	others := expectStep(t, result, CleanupStepOtherPrs, CleanupStateDone)
	if exists(review) || exists(f.agent) {
		t.Errorf("worktrees left: review %v, agent %v", exists(review), exists(f.agent))
	}
	if out := f.git(f.dir, "branch", "--list", "feature/7-thing"); out != "" {
		t.Errorf("local branch kept: %q", out)
	}
	if !slices.Equal(f.ended, []int{7}) {
		t.Errorf("review session not ended: %v", f.ended)
	}
	if calls := f.workflowCalls(); calls != "status 7\nupdate-status 7 Done\n" {
		t.Errorf("workflow calls: %q", calls)
	}
	// AC1: the PRs that still merge cleanly are left alone, never rebased by GitHub.
	if writes := f.ghWrites(); !slices.Equal(writes, []string{"issue close 7 --repo acme/app"}) {
		t.Errorf("gh writes: %q", writes)
	}
	if n := f.ghCount("pr list"); n != 2 {
		t.Errorf("the other PRs must be read again once GitHub computed them: %d reads", n)
	}
	byNumber := otherPrsByNumber(others)
	if len(others.Prs) != 5 || others.Unaffected != 2 || others.Conflicting != 3 || others.Checking != 0 || others.Failed != 0 {
		t.Errorf("other PRs: %+v", others)
	}
	// AC2: the idle agent on a conflicting PR's branch gets the rebase brief, by its first name.
	idle := byNumber[9]
	if idle.State != CleanupStateDone || idle.Flag != CleanupFlagRebaseAsked || idle.Agent != "Jérôme" || idle.Url != "https://x/9" {
		t.Errorf("idle PR: %+v", idle)
	}
	line := f.typed["block-9"]
	for _, part := range []string{"PR #9", "conflicts with develop", "Rebase it on origin/develop", "never merge develop into the branch", "--force-with-lease"} {
		if !strings.Contains(line, part) {
			t.Errorf("the prompt misses %q: %s", part, line)
		}
	}
	briefs, _ := filepath.Glob(filepath.Join(f.dataDir, "molten", "reviews", "*", "rebase", "9-01234567.md"))
	if len(briefs) != 1 || !strings.Contains(readText(t, briefs[0]), "after the developer merged PR #7 into develop") {
		t.Errorf("the brief must name the merge: %v", briefs)
	}
	// A busy agent is not interrupted; with no agent on the branch nothing starts.
	if pr := byNumber[8]; pr.State != CleanupStateSkipped || pr.Flag != CleanupFlagAgentBusy || pr.Agent != "Rita" {
		t.Errorf("busy PR: %+v", pr)
	}
	if pr := byNumber[10]; pr.State != CleanupStateSkipped || pr.Flag != CleanupFlagNeedsAgent {
		t.Errorf("PR without an agent: %+v", pr)
	}
	for _, n := range []int{11, 12} {
		if pr := byNumber[n]; pr.State != CleanupStateDone || pr.Flag != "" {
			t.Errorf("unaffected PR %d: %+v", n, pr)
		}
	}
	if len(f.typed) != 1 || f.opened != 0 {
		t.Errorf("only the idle agent is reached, nothing is started: typed %v opened %d", f.typed, f.opened)
	}
}

// A PR GitHub has not computed by the bound is reported still checking, and nothing is asked for it.
func TestCleanupOtherPrStillChecking(t *testing.T) {
	f := makeCleanupFixture(t, true)
	f.addOtherPr(9, "feature/9-idle", molten.AgentStateIdle, "Jérôme")
	f.mergeableWait = 20 * time.Millisecond
	f.openPrs = `[{"number":9,"headRefName":"feature/9-idle","mergeable":"UNKNOWN","mergeStateStatus":"UNKNOWN"},
		{"number":11,"headRefName":"feature/11-clean","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}]`

	result := f.cleanup(CleanupRequest{})

	others := expectStep(t, result, CleanupStepOtherPrs, CleanupStateDone)
	if pr := otherPrsByNumber(others)[9]; pr.State != CleanupStateSkipped || pr.Flag != CleanupFlagChecking {
		t.Errorf("PR still computed: %+v", pr)
	}
	if others.Checking != 1 || others.Unaffected != 1 || others.Conflicting != 0 {
		t.Errorf("counts: %+v", others)
	}
	if n := f.ghCount("pr list"); n < 2 {
		t.Errorf("the PRs must be read again until the bound: %d reads", n)
	}
	if len(f.typed) != 0 || len(f.ghWrites()) != 1 {
		t.Errorf("nothing is asked for a PR still computed: typed %v writes %v", f.typed, f.ghWrites())
	}
}

// Once every PR is known the step reads them no more.
func TestCleanupOtherPrsReadOnceWhenKnown(t *testing.T) {
	f := makeCleanupFixture(t, true)
	f.openPrs = `[{"number":11,"headRefName":"feature/11-clean","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}]`

	result := f.cleanup(CleanupRequest{})

	others := expectStep(t, result, CleanupStepOtherPrs, CleanupStateDone)
	if n := f.ghCount("pr list"); n != 1 || others.Unaffected != 1 {
		t.Errorf("reads %d, step %+v", n, others)
	}
}

// Asking for the rebase fails (the branch is in the main checkout's way, a brief that cannot be written…): the PR is
// flagged with the reason and the step fails.
func TestCleanupOtherPrRebaseNotAsked(t *testing.T) {
	f := makeCleanupFixture(t, true)
	f.openPrs = `[{"number":9,"headRefName":"feature/9-x","mergeable":"CONFLICTING","mergeStateStatus":"DIRTY"}]`
	cleaner := f.cleaner()
	cleaner.env.AskRebase = func(ctx context.Context, req RebaseRequest) (RestartResult, error) {
		if req.Number != 9 || req.HeadRef != "feature/9-x" || req.BaseRef != "develop" || req.MergedPr != 7 || req.Start {
			t.Errorf("request: %+v", req)
		}
		return RestartResult{Status: RestartFailed, Reason: RestartReasonBrief, Message: "the brief could not be written"}, nil
	}

	result, err := cleaner.Run(context.Background(), CleanupRequest{Dir: f.dir, Repo: cleanupRepo, Number: 7})
	if err != nil {
		t.Fatal(err)
	}

	others := expectStep(t, result, CleanupStepOtherPrs, CleanupStateFailed)
	if pr := others.Prs[0]; pr.State != CleanupStateFailed || pr.Flag != CleanupFlagNeedsRebase || pr.Error != "the brief could not be written" {
		t.Errorf("PR: %+v", pr)
	}
}

func TestCleanupKeepsDirtyAgentWorktree(t *testing.T) {
	f := makeCleanupFixture(t, true)
	f.write(f.agent, "b.txt", "unsaved edit\n")

	result := f.cleanup(CleanupRequest{})

	agent := expectStep(t, result, CleanupStepAgentTree, CleanupStateSkipped)
	if agent.Confirm == nil || agent.Confirm.ChangeCount != 1 || agent.Code != CleanupCodeKept || agent.Loss == nil || agent.Loss.ChangeCount != 1 || !slices.Equal(agent.Loss.Changes, []string{"b.txt"}) || agent.Loss.CommitCount != 0 {
		t.Fatalf("agent worktree step: %+v", agent)
	}
	branch := expectStep(t, result, CleanupStepLocalBranch, CleanupStateSkipped)
	if branch.Code != CleanupCodeInKeptTree {
		t.Errorf("branch code: %q", branch.Code)
	}
	// The rest is done all the same.
	expectStep(t, result, CleanupStepTicketClose, CleanupStateDone)
	expectStep(t, result, CleanupStepTicketDone, CleanupStateDone)
	expectStep(t, result, CleanupStepReviewTree, CleanupStateSkipped)
	if !exists(f.agent) {
		t.Fatalf("the dirty worktree was removed")
	}

	// The worktree changed after the plan was shown: still kept.
	stale := *agent.Confirm
	f.write(f.agent, "d.txt", "more\n")
	again := f.cleanup(CleanupRequest{Steps: []string{CleanupStepAgentTree, CleanupStepLocalBranch}, WorktreeConfirmed: &stale})
	expectStep(t, again, CleanupStepAgentTree, CleanupStateFailed)
	expectStep(t, again, CleanupStepLocalBranch, CleanupStateSkipped)
	if !exists(f.agent) {
		t.Fatalf("a worktree that grew since the confirmation was removed")
	}

	// The second confirmation of the plan as it is now.
	confirmed := again.Step(CleanupStepAgentTree).Confirm
	final := f.cleanup(CleanupRequest{Steps: []string{CleanupStepAgentTree, CleanupStepLocalBranch}, WorktreeConfirmed: confirmed})
	if len(final.Steps) != 2 {
		t.Errorf("only the asked steps run: %+v", final.Steps)
	}
	expectStep(t, final, CleanupStepAgentTree, CleanupStateDone)
	expectStep(t, final, CleanupStepLocalBranch, CleanupStateDone)
	if exists(f.agent) {
		t.Errorf("the confirmed worktree is still there")
	}
}

func TestCleanupKeepsUnmergedWork(t *testing.T) {
	f := makeCleanupFixture(t, false)
	// A commit made after the merge, never pushed: the branch holds work that is not in the merged PR.
	f.write(f.agent, "e.txt", "late work\n")
	f.git(f.agent, "add", "e.txt")
	f.git(f.agent, "commit", "--quiet", "-m", "late")
	late := f.git(f.agent, "rev-parse", "HEAD")

	result := f.cleanup(CleanupRequest{})

	agent := expectStep(t, result, CleanupStepAgentTree, CleanupStateSkipped)
	if agent.Confirm == nil || agent.Code != CleanupCodeKept || agent.Loss == nil || agent.Loss.ChangeCount != 0 ||
		agent.Loss.CommitCount != 1 || agent.Loss.Commits[0].Sha != late || agent.Loss.Commits[0].Subject != "late" {
		t.Fatalf("agent worktree step: %+v %+v", agent, agent.Loss)
	}
	if step := expectStep(t, result, CleanupStepTicketDone, CleanupStateSkipped); step.Code != CleanupCodeNoSfWorkflow {
		t.Errorf("ticket done code: %q", step.Code)
	}
	if !exists(f.agent) {
		t.Fatalf("the worktree with a late commit was removed")
	}

	// The developer chooses to lose it: the worktree and its branch go, the tip being the one they saw.
	final := f.cleanup(CleanupRequest{Steps: []string{CleanupStepAgentTree, CleanupStepLocalBranch}, WorktreeConfirmed: agent.Confirm})
	expectStep(t, final, CleanupStepAgentTree, CleanupStateDone)
	expectStep(t, final, CleanupStepLocalBranch, CleanupStateDone)
	if exists(f.agent) || f.git(f.dir, "branch", "--list", "feature/7-thing") != "" {
		t.Errorf("the confirmed worktree or its branch is still there")
	}
}

// The three cases of #672: only git-ignored files, uncommitted work, and a rebase merge whose commits have new ids.
func TestCleanupRemovesIgnoredOnlyWorktree(t *testing.T) {
	f := makeCleanupFixture(t, true)
	f.write(f.dir, ".git/info/exclude", "node_modules/\ndist/\n.task/\ntest-results.xml\n.env\n")
	f.write(f.agent, "node_modules/x/index.js", "x\n")
	f.write(f.agent, "dist/app.js", "x\n")
	f.write(f.agent, ".task/checksum", "x\n")
	f.write(f.agent, "test-results.xml", "<x/>\n")
	f.write(f.agent, ".env", "TOKEN=1\n")

	result := f.cleanup(CleanupRequest{})

	agent := expectStep(t, result, CleanupStepAgentTree, CleanupStateDone)
	if agent.Code != CleanupCodeRemoved || agent.Loss == nil || agent.Loss.IgnoredCount != 5 || !agent.Loss.Nothing() {
		t.Fatalf("agent worktree step: %+v %+v", agent, agent.Loss)
	}
	expectStep(t, result, CleanupStepLocalBranch, CleanupStateDone)
	if exists(f.agent) || f.git(f.dir, "branch", "--list", "feature/7-thing") != "" {
		t.Errorf("an agent worktree holding only ignored files was kept")
	}
}

// A panel still working in the worktree keeps it, even with nothing to lose and after the developer chose to remove
// it; once the panel is closed, the same step removes it.
func TestCleanupKeepsAWorktreeAPanelWorksIn(t *testing.T) {
	f := makeCleanupFixture(t, true)
	f.terminals[realOf(f.agent)] = []mission.WorktreeTerminal{{BlockId: "agent-block", Tab: "Agent 7", Workspace: "app", Linked: true}}
	f.states["agent-block"] = molten.AgentStateWorking

	result := f.cleanup(CleanupRequest{})

	agent := expectStep(t, result, CleanupStepAgentTree, CleanupStateSkipped)
	if agent.Code != CleanupCodeInUse || len(agent.Panels) != 1 || agent.Confirm == nil {
		t.Fatalf("agent worktree step: %+v", agent)
	}
	if p := agent.Panels[0]; p.BlockId != "agent-block" || p.Tab != "Agent 7" || p.Agent != molten.AgentStateWorking {
		t.Errorf("panel: %+v", p)
	}
	expectStep(t, result, CleanupStepLocalBranch, CleanupStateSkipped)
	if !exists(f.agent) {
		t.Fatalf("a worktree an agent works in was removed")
	}
	steps := []string{CleanupStepAgentTree, CleanupStepLocalBranch}
	again := f.cleanup(CleanupRequest{Steps: steps, WorktreeConfirmed: agent.Confirm})
	expectStep(t, again, CleanupStepAgentTree, CleanupStateSkipped)
	if !exists(f.agent) {
		t.Fatalf("a confirmed removal pulled the folder from under an open panel")
	}

	f.lock.Lock()
	delete(f.terminals, realOf(f.agent))
	f.lock.Unlock()
	final := f.cleanup(CleanupRequest{Steps: steps})
	expectStep(t, final, CleanupStepAgentTree, CleanupStateDone)
	expectStep(t, final, CleanupStepLocalBranch, CleanupStateDone)
	if exists(f.agent) {
		t.Errorf("the worktree is still there once its panel closed")
	}
}

func TestCleanupKeepsUntrackedWork(t *testing.T) {
	f := makeCleanupFixture(t, true)
	f.write(f.agent, "notes.md", "draft\n")
	f.write(f.agent, "src/new.ts", "x\n")

	result := f.cleanup(CleanupRequest{})

	agent := expectStep(t, result, CleanupStepAgentTree, CleanupStateSkipped)
	if agent.Loss == nil || agent.Loss.ChangeCount != 2 || !slices.Equal(agent.Loss.Changes, []string{"notes.md", "src/"}) {
		t.Fatalf("agent worktree loss: %+v", agent.Loss)
	}
	expectStep(t, result, CleanupStepLocalBranch, CleanupStateSkipped)
	if !exists(f.agent) {
		t.Fatalf("untracked work was removed")
	}
}

// Without the merged head (GitHub's refs/pull/N/head out of reach), the commits are compared by patch: the rebase merge
// gave them new ids on develop, and nothing is lost.
func TestCleanupRebaseMergeWithoutMergedHead(t *testing.T) {
	f := makeCleanupFixture(t, false)
	f.prHead = strings.Repeat("f", 40)

	result := f.cleanup(CleanupRequest{})

	agent := expectStep(t, result, CleanupStepAgentTree, CleanupStateDone)
	if agent.Loss == nil || agent.Loss.CommitCount != 0 {
		t.Fatalf("agent worktree loss: %+v", agent.Loss)
	}
	expectStep(t, result, CleanupStepLocalBranch, CleanupStateDone)
}

// A squash merge, then a later edit on develop of a file the PR added: by patch or by content the branch's commits
// look unmerged, but every one of them is in the head GitHub merged, so nothing is lost (#673 adds squash merges).
func TestCleanupCommitsAreJudgedByTheMergedHead(t *testing.T) {
	f := makeCleanupFixture(t, false)
	f.write(f.agent, "x.txt", "x\n")
	f.git(f.agent, "add", "x.txt")
	f.git(f.agent, "commit", "--quiet", "-m", "x")
	f.write(f.agent, "y.txt", "y\n")
	f.git(f.agent, "add", "y.txt")
	f.git(f.agent, "commit", "--quiet", "-m", "y")
	f.git(f.agent, "push", "--quiet", "origin", "feature/7-thing")
	f.prHead = f.git(f.agent, "rev-parse", "HEAD")
	merger := filepath.Join(f.root, "merger")
	f.git(merger, "pull", "--quiet", "origin", "develop")
	f.git(merger, "fetch", "--quiet", "origin", "feature/7-thing")
	f.git(merger, "merge", "--quiet", "--squash", "FETCH_HEAD")
	f.git(merger, "commit", "--quiet", "-m", "feat(#7): thing (squash)")
	f.write(merger, "x.txt", "x edited later\n")
	f.git(merger, "commit", "--quiet", "-am", "later edit")
	f.git(merger, "push", "--quiet", "origin", "develop", ":feature/7-thing")

	result := f.cleanup(CleanupRequest{})

	agent := expectStep(t, result, CleanupStepAgentTree, CleanupStateDone)
	if agent.Loss == nil || agent.Loss.CommitCount != 0 {
		t.Fatalf("agent worktree loss: %+v", agent.Loss)
	}
	expectStep(t, result, CleanupStepLocalBranch, CleanupStateDone)
}

// A merge commit (#673): the branch's commits are on develop as they are, and the cleanup removes everything.
func TestCleanupAfterAMergeCommit(t *testing.T) {
	f := makeCleanupFixture(t, false)
	f.write(f.agent, "x.txt", "x\n")
	f.git(f.agent, "add", "x.txt")
	f.git(f.agent, "commit", "--quiet", "-m", "x")
	f.git(f.agent, "push", "--quiet", "origin", "feature/7-thing")
	f.prHead = f.git(f.agent, "rev-parse", "HEAD")
	merger := filepath.Join(f.root, "merger")
	f.git(merger, "pull", "--quiet", "origin", "develop")
	f.git(merger, "fetch", "--quiet", "origin", "feature/7-thing")
	f.git(merger, "merge", "--quiet", "--no-ff", "-m", "Merge pull request #7", "FETCH_HEAD")
	f.git(merger, "push", "--quiet", "origin", "develop", ":feature/7-thing")

	result := f.cleanup(CleanupRequest{})

	agent := expectStep(t, result, CleanupStepAgentTree, CleanupStateDone)
	if agent.Loss == nil || agent.Loss.CommitCount != 0 {
		t.Fatalf("agent worktree loss: %+v", agent.Loss)
	}
	expectStep(t, result, CleanupStepLocalBranch, CleanupStateDone)
	expectStep(t, result, CleanupStepRemoteBranch, CleanupStateDone)
}

func TestCleanupPlanSaysWhatWillGo(t *testing.T) {
	f := makeCleanupFixture(t, false)
	steps := f.cleaner().Plan(context.Background(), MergedPr{Dir: f.dir, Repo: cleanupRepo, Number: 7, HeadRef: "feature/7-thing", BaseRef: "develop"})
	byId := map[string]CleanupStepResult{}
	for _, s := range steps {
		if s.State != CleanupStatePlanned {
			t.Errorf("planned: %+v", s)
		}
		byId[s.Id] = s
	}
	if s := byId[CleanupStepAgentTree]; s.Code != CleanupCodeWillRemove || realOf(s.Path) != realOf(f.agent) {
		t.Errorf("agent worktree: %+v", s)
	}
	if s := byId[CleanupStepReviewTree]; s.Code != CleanupCodeNoReviewTree {
		t.Errorf("review worktree: %+v", s)
	}
	if s := byId[CleanupStepTicketClose]; s.Code != CleanupCodeNoTicket {
		t.Errorf("ticket: %+v", s)
	}
	if s := byId[CleanupStepLocalBranch]; s.Branch != "feature/7-thing" || s.Base != "develop" {
		t.Errorf("branch: %+v", s)
	}
}

func TestCleanupFailureStopsOnlyItsDependents(t *testing.T) {
	f := makeCleanupFixture(t, true)
	f.ghFail["issue close"] = errors.New("gh issue close 7: HTTP 502")
	f.ghFail["pr list"] = errors.New("gh pr list: HTTP 502")

	result := f.cleanup(CleanupRequest{})

	expectStep(t, result, CleanupStepTicketClose, CleanupStateFailed)
	expectStep(t, result, CleanupStepOtherPrs, CleanupStateFailed)
	expectStep(t, result, CleanupStepTicketDone, CleanupStateDone)
	expectStep(t, result, CleanupStepAgentTree, CleanupStateDone)
	expectStep(t, result, CleanupStepLocalBranch, CleanupStateDone)
	if step := result.Step(CleanupStepTicketClose); !strings.Contains(step.Error, "502") {
		t.Errorf("failure message: %q", step.Error)
	}
}

func TestCleanupNeedsAMergedPr(t *testing.T) {
	f := makeCleanupFixture(t, true)
	f.prState = "OPEN"

	result := f.cleanup(CleanupRequest{})

	expectStep(t, result, CleanupStepPr, CleanupStateFailed)
	for _, id := range CleanupSteps[1:] {
		expectStep(t, result, id, CleanupStateSkipped)
	}
	if writes := f.ghWrites(); len(writes) != 0 || f.workflowCalls() != "" {
		t.Errorf("writes on an unmerged PR: %q %q", writes, f.workflowCalls())
	}
	if !exists(f.agent) {
		t.Errorf("worktree removed for an unmerged PR")
	}
}

func TestCleanupAlreadyDone(t *testing.T) {
	f := makeCleanupFixture(t, true)
	f.issue = "CLOSED"
	f.write(f.dir, CleanupWorkflowCliPath, "#!/bin/sh\necho \"$@\" >> \"$(dirname \"$0\")/calls.log\"\n"+
		"echo \"Ticket #$2 is currently in status: Done\"\n")

	result := f.cleanup(CleanupRequest{Steps: []string{CleanupStepTicketClose, CleanupStepTicketDone}})

	expectStep(t, result, CleanupStepTicketClose, CleanupStateSkipped)
	expectStep(t, result, CleanupStepTicketDone, CleanupStateSkipped)
	if writes := f.ghWrites(); len(writes) != 0 || f.workflowCalls() != "status 7\n" {
		t.Errorf("writes: %q %q", writes, f.workflowCalls())
	}
}

func TestCleanupRequestChecks(t *testing.T) {
	c := MakeCleaner(CleanupEnv{Run: func(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
		t.Fatalf("ran %s", name)
		return nil, nil
	}})
	for _, req := range []CleanupRequest{
		{Dir: "relative", Repo: cleanupRepo, Number: 7},
		{Dir: "/tmp", Repo: "nope", Number: 7},
		{Dir: "/tmp", Repo: cleanupRepo, Number: 0},
		{Dir: "/tmp", Repo: cleanupRepo, Number: 7, Steps: []string{"merge"}},
	} {
		if _, err := c.Run(context.Background(), req); err == nil {
			t.Errorf("accepted %+v", req)
		}
	}
}

func TestStoreKeepsCleanupSteps(t *testing.T) {
	s := MakeStore(t.TempDir())
	first := CleanupResult{Repo: cleanupRepo, Number: 7, Steps: []CleanupStepResult{
		{Id: CleanupStepPr, State: CleanupStateDone},
		{Id: CleanupStepTicketClose, State: CleanupStateDone},
		{Id: CleanupStepAgentTree, State: CleanupStateSkipped},
	}}
	if _, _, err := s.SetCleanup(first); err != nil {
		t.Fatal(err)
	}
	retry := CleanupResult{Repo: cleanupRepo, Number: 7, Steps: []CleanupStepResult{
		{Id: CleanupStepPr, State: CleanupStateDone},
		{Id: CleanupStepAgentTree, State: CleanupStateDone},
	}}
	state, changed, err := s.SetCleanup(retry)
	if err != nil || !changed {
		t.Fatal(err)
	}
	got, _ := json.Marshal(state.Cleanup.Steps)
	want := `[{"id":"pr","state":"done"},{"id":"ticket-close","state":"done"},{"id":"agent-worktree","state":"done"}]`
	if string(got) != want {
		t.Errorf("steps: %s", got)
	}
}
