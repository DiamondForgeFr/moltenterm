// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
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

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/molten/reviewsession"
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

	lock      sync.Mutex
	ghCalls   [][]string
	prState   string
	issue     string
	openPrs   string
	ghFail    map[string]error
	terminals map[string][]mission.WorktreeTerminal
	states    map[string]string
	ended     []int
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
		openPrs: "[]", ghFail: map[string]error{}, terminals: map[string][]mission.WorktreeTerminal{}, states: map[string]string{}}
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
	if len(args) > 2 && args[0] == "pr" && args[1] == "update-branch" {
		if err := f.ghFail["pr update-branch "+args[2]]; err != nil {
			return nil, err
		}
	}
	switch key {
	case "pr view":
		return []byte(fmt.Sprintf(`{"state":%q,"headRefName":"feature/7-thing","headRefOid":%q,"baseRefName":"develop","closingIssuesReferences":[]}`,
			f.prState, f.headOid)), nil
	case "issue view":
		return []byte(fmt.Sprintf(`{"state":%q}`, f.issue)), nil
	case "pr list":
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

func (f *cleanupFixture) cleaner() *Cleaner {
	return MakeCleaner(CleanupEnv{
		Run: f.run,
		Terminals: func(ctx context.Context, path string) []mission.WorktreeTerminal {
			f.lock.Lock()
			defer f.lock.Unlock()
			return f.terminals[realOf(path)]
		},
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
		t.Errorf("step %s: %s (%s%s), want %s", id, step.State, step.Reason, step.Message, state)
	}
	return step
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func (f *cleanupFixture) addOtherPr(number int, branch string, state string) string {
	tree := filepath.Join(f.root, fmt.Sprintf("app-%d", number))
	f.git(f.dir, "worktree", "add", "--quiet", "-b", branch, tree, "origin/develop")
	blockId := fmt.Sprintf("block-%d", number)
	f.terminals[realOf(tree)] = []mission.WorktreeTerminal{{BlockId: blockId, Linked: true}}
	f.states[blockId] = state
	return tree
}

func TestCleanupAfterMerge(t *testing.T) {
	f := makeCleanupFixture(t, true)
	review := reviewsession.ReviewTreeDir(f.dataDir, f.dir, 7)
	f.git(f.dir, "worktree", "add", "--quiet", "--detach", review, f.headOid)
	f.addOtherPr(8, "feature/8-busy", molten.AgentStateWorking)
	f.addOtherPr(9, "feature/9-idle", molten.AgentStateIdle)
	f.openPrs = `[{"number":7,"headRefName":"feature/7-thing","mergeStateStatus":"CLEAN"},
		{"number":8,"headRefName":"feature/8-busy","mergeStateStatus":"BEHIND"},
		{"number":9,"headRefName":"feature/9-idle","mergeStateStatus":"BEHIND"},
		{"number":10,"headRefName":"feature/10-dirty","mergeStateStatus":"DIRTY"},
		{"number":11,"headRefName":"feature/11-late","mergeStateStatus":"BEHIND"}]`
	f.ghFail["pr update-branch 11"] = errors.New("gh pr update-branch 11 --rebase: merge conflict between base and head")

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
	expectStep(t, result, CleanupStepRemoteBranch, CleanupStateSkipped)
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
	want := []string{"issue close 7 --repo acme/app", "pr update-branch 9 --rebase --repo acme/app", "pr update-branch 11 --rebase --repo acme/app"}
	if writes := f.ghWrites(); !slices.Equal(writes, want) {
		t.Errorf("gh writes: %q", writes)
	}
	byNumber := map[int]CleanupPr{}
	for _, pr := range others.Prs {
		byNumber[pr.Number] = pr
	}
	if len(others.Prs) != 4 {
		t.Errorf("other PRs: %+v", others.Prs)
	}
	if pr := byNumber[8]; pr.State != CleanupStateSkipped || pr.Flag != CleanupFlagAgentBusy {
		t.Errorf("busy PR: %+v", pr)
	}
	if pr := byNumber[9]; pr.State != CleanupStateDone {
		t.Errorf("idle PR: %+v", pr)
	}
	for _, n := range []int{10, 11} {
		if pr := byNumber[n]; pr.State != CleanupStateSkipped || pr.Flag != CleanupFlagNeedsRebase {
			t.Errorf("conflicting PR %d: %+v", n, pr)
		}
	}
}

func TestCleanupKeepsDirtyAgentWorktree(t *testing.T) {
	f := makeCleanupFixture(t, true)
	f.write(f.agent, "b.txt", "unsaved edit\n")

	result := f.cleanup(CleanupRequest{})

	agent := expectStep(t, result, CleanupStepAgentTree, CleanupStateSkipped)
	if agent.Confirm == nil || agent.Confirm.ChangeCount != 1 || agent.Worktree == nil || !strings.Contains(agent.Reason, "uncommitted") {
		t.Fatalf("agent worktree step: %+v", agent)
	}
	branch := expectStep(t, result, CleanupStepLocalBranch, CleanupStateSkipped)
	if !strings.Contains(branch.Reason, "kept agent worktree") {
		t.Errorf("branch reason: %q", branch.Reason)
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
	// A commit made after the merge, never pushed: the branch holds work that is not on develop.
	f.write(f.agent, "e.txt", "late work\n")
	f.git(f.agent, "add", "e.txt")
	f.git(f.agent, "commit", "--quiet", "-m", "late")

	result := f.cleanup(CleanupRequest{})

	agent := expectStep(t, result, CleanupStepAgentTree, CleanupStateSkipped)
	if agent.Confirm == nil || !strings.Contains(agent.Reason, "commit") {
		t.Errorf("agent worktree step: %+v", agent)
	}
	expectStep(t, result, CleanupStepTicketDone, CleanupStateSkipped)
	if step := result.Step(CleanupStepTicketDone); !strings.Contains(step.Reason, "sf-workflow") {
		t.Errorf("ticket done reason: %q", step.Reason)
	}

	// Removing the worktree after the confirmation still keeps the branch: its content is not on develop.
	final := f.cleanup(CleanupRequest{Steps: []string{CleanupStepAgentTree, CleanupStepLocalBranch}, WorktreeConfirmed: agent.Confirm})
	expectStep(t, final, CleanupStepAgentTree, CleanupStateDone)
	branch := expectStep(t, final, CleanupStepLocalBranch, CleanupStateSkipped)
	if !strings.Contains(branch.Reason, "not on develop") {
		t.Errorf("branch reason: %q", branch.Reason)
	}
	if out := f.git(f.dir, "branch", "--list", "feature/7-thing"); out == "" {
		t.Errorf("the branch with unmerged work was deleted")
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
	if step := result.Step(CleanupStepTicketClose); !strings.Contains(step.Message, "502") {
		t.Errorf("failure message: %q", step.Message)
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
