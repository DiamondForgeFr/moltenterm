// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

type foreignTreeFixture struct {
	r   *Runs
	dir string
	// The worktrees by letter: a locked Claude Code agent's (a), one outside the project (b), a dirty one (c), one whose
	// branch holds a commit the trunk lacks (d), one a live process works in (e), one with a merge in progress (f).
	trees map[string]string
	// cwds is what the process table answers; tests change it between the plan and the removal.
	lock sync.Mutex
	cwds func(call int) []procCwd
	call int
}

func (f *foreignTreeFixture) readCwds() []procCwd {
	f.lock.Lock()
	defer f.lock.Unlock()
	f.call++
	if f.cwds == nil {
		return nil
	}
	return f.cwds(f.call)
}

// #1028's acceptance repository, without GitHub: the merged branches reached develop rebased (cherry-picked), then
// develop edited their files, so only `git cherry` tells they are merged.
func makeForeignTreeFixture(t *testing.T) *foreignTreeFixture {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("uses /bin/sh")
	}
	dir := t.TempDir()
	gitIn(t, dir, "init", "-q", "-b", "develop")
	commitFile(t, dir, ".gitignore", ".claude/\n", "init")
	letters := []string{"a", "b", "c", "d", "e", "f"}
	for _, l := range letters {
		gitIn(t, dir, "checkout", "-q", "-b", "feature/"+l, "develop")
		commitFile(t, dir, l+".txt", l+"\n", "work "+l)
	}
	gitIn(t, dir, "checkout", "-q", "develop")
	for _, l := range letters {
		if l != "d" {
			gitIn(t, dir, "cherry-pick", "feature/"+l)
			commitFile(t, dir, l+".txt", l+", edited on develop\n", "develop edits "+l)
		}
	}
	outside := t.TempDir()
	f := &foreignTreeFixture{dir: dir, trees: map[string]string{
		"a": filepath.Join(dir, ".claude", "worktrees", "agent-a7e6f45f"),
		"b": filepath.Join(outside, "gaborone"),
		"c": filepath.Join(outside, "dirty"),
		"d": filepath.Join(outside, "ahead"),
		"e": filepath.Join(outside, "busy"),
		"f": filepath.Join(outside, "merging"),
	}}
	for _, l := range letters {
		gitIn(t, dir, "worktree", "add", "-q", f.trees[l], "feature/"+l)
	}
	gitIn(t, dir, "worktree", "lock", "--reason", "claude agent agent-a7e6f45f", f.trees["a"])
	os.WriteFile(filepath.Join(f.trees["c"], "notes.txt"), []byte("untracked\n"), 0644)
	gitDir := strings.TrimSpace(gitIn(t, f.trees["f"], "rev-parse", "--path-format=absolute", "--git-dir"))
	os.WriteFile(filepath.Join(gitDir, "MERGE_HEAD"), []byte(headOf(t, dir, "develop")+"\n"), 0644)

	data := t.TempDir()
	r := MakeRuns(filepath.Join(data, "runs"), MakeTrustStore(filepath.Join(data, TrustFileName)), nil)
	t.Cleanup(func() { waitRunsIdle(t, r) })
	r.git = func(ctx context.Context, d string, name string, args ...string) ([]byte, error) {
		if name == "gh" {
			return nil, errors.New("none of the git remotes configured for this repository point to a known GitHub host")
		}
		return plainRunner(ctx, d, name, args...)
	}
	r.UseWorktrees(MakeWorktrees(plainRunner, func(ctx context.Context, path string, exclude []string) []WorktreeTerminal {
		return []WorktreeTerminal{}
	}), data)
	busy := f.trees["e"]
	f.cwds = func(call int) []procCwd {
		return []procCwd{{pid: 4242, name: "claude", cwd: filepath.Join(busy, "src")}, {pid: 77, name: "zsh", cwd: dir}}
	}
	r.treeCwds = f.readCwds
	f.r = r
	return f
}

func branchNamed(plan BranchesPlan, name string) BranchPlan {
	for _, b := range plan.Branches {
		if b.Name == name && !b.Remote {
			return b
		}
	}
	return BranchPlan{}
}

func TestBranchesPlanForeignAndLockedWorktrees(t *testing.T) {
	f := makeForeignTreeFixture(t)
	plan, err := f.r.PlanBranches(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	got := planOf(plan)
	for name, want := range map[string]string{
		"feature/a": "delete:merged-worktree",
		"feature/b": "delete:merged-worktree",
		"feature/c": "keep:worktree-changes",
		"feature/d": "keep:worktree-commits",
		"feature/e": "keep:worktree-process",
		"feature/f": "keep:worktree-operation",
		"develop":   "keep:protected",
	} {
		if got[name] != want {
			t.Errorf("%s: got %q, want %q", name, got[name], want)
		}
	}
	a := branchNamed(plan, "feature/a")
	if !a.Confirm || !a.Locked || a.Tool != TreeToolClaudeCode || a.Outside || !samePathForTest(a.Worktree, f.trees["a"]) {
		t.Errorf("the locked agent worktree is offered unchecked, named: %+v", a)
	}
	b := branchNamed(plan, "feature/b")
	if !b.Confirm || b.Locked || !b.Outside || b.Tool != "" || !samePathForTest(b.Worktree, f.trees["b"]) {
		t.Errorf("the outside worktree is offered unchecked, named: %+v", b)
	}
	e := branchNamed(plan, "feature/e")
	if len(e.Processes) != 1 || e.Processes[0].Pid != 4242 || e.Processes[0].Name != "claude" {
		t.Errorf("the busy worktree names its process: %+v", e)
	}
	if op := branchNamed(plan, "feature/f").Operation; op != "merge" {
		t.Errorf("the merge in progress is named: %q", op)
	}
	if d := branchNamed(plan, "feature/d"); !samePathForTest(d.Worktree, f.trees["d"]) {
		t.Errorf("the kept worktree is named: %+v", d)
	}
}

func TestCleanBranchesRemovesOnlyCheckedForeignWorktrees(t *testing.T) {
	f := makeForeignTreeFixture(t)
	all := []string{"feature/a", "feature/b", "feature/c", "feature/d", "feature/e", "feature/f"}
	res, err := f.r.CleanBranches(BranchesCleanRequest{Dir: f.dir, Names: all, Worktrees: []string{f.trees["a"]}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(res.Deleted, ",") != "feature/a" || res.Failed != 5 {
		t.Fatalf("only the checked worktree goes: %+v", res)
	}
	if _, err := os.Stat(f.trees["a"]); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the locked worktree's folder is gone: %v", err)
	}
	for _, l := range []string{"b", "c", "d", "e", "f"} {
		if _, err := os.Stat(f.trees[l]); err != nil {
			t.Fatalf("worktree %s stays: %v", l, err)
		}
	}
	res, _ = f.r.CleanBranches(BranchesCleanRequest{Dir: f.dir, Names: []string{"feature/b"}, Worktrees: []string{f.trees["b"]}})
	if strings.Join(res.Deleted, ",") != "feature/b" {
		t.Fatalf("checked, the outside worktree goes: %+v", res)
	}
	branches := gitIn(t, f.dir, "branch")
	for _, gone := range []string{"feature/a", "feature/b"} {
		if strings.Contains(branches, gone) {
			t.Fatalf("%s went with its worktree: %s", gone, branches)
		}
	}
	for _, kept := range []string{"feature/c", "feature/d", "feature/e", "feature/f"} {
		if !strings.Contains(branches, kept) {
			t.Fatalf("%s stays: %s", kept, branches)
		}
	}
	if list := gitIn(t, f.dir, "worktree", "list"); strings.Contains(list, "agent-a7e6f45f") || strings.Contains(list, "gaborone") {
		t.Fatalf("git no longer lists the removed worktrees: %s", list)
	}
	if _, err := os.Stat(filepath.Join(f.trees["c"], "notes.txt")); err != nil {
		t.Fatalf("the dirty worktree's work is untouched: %v", err)
	}
}

func TestCleanBranchesKeepsWorktreeAProcessEnteredSinceThePlan(t *testing.T) {
	f := makeForeignTreeFixture(t)
	outside := f.trees["b"]
	// The plan reads the processes first; the removal reads them again and finds an agent started in the worktree.
	f.cwds = func(call int) []procCwd {
		if call == 1 {
			return nil
		}
		return []procCwd{{pid: 5151, name: "codex", cwd: outside}}
	}
	res, err := f.r.CleanBranches(BranchesCleanRequest{Dir: f.dir, Names: []string{"feature/b"}, Worktrees: []string{outside}})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Deleted) != 0 || res.Failed != 1 || !strings.Contains(res.Errors[0], "codex (5151)") {
		t.Fatalf("the worktree a process works in stays: %+v", res)
	}
	if text := res.ErrorsText[0]; text.Parts["detail"] == nil || text.Parts["detail"].Code != "mission.branches.treeProcess" {
		t.Fatalf("the reason is worded by its code: %+v", text)
	}
	if _, err := os.Stat(outside); err != nil {
		t.Fatalf("its folder stays: %v", err)
	}
	if !strings.Contains(gitIn(t, f.dir, "branch"), "feature/b") {
		t.Fatal("its branch stays")
	}
}

func TestWorktreeRemoveRefusesLockedUnlessConfirmed(t *testing.T) {
	f := makeForeignTreeFixture(t)
	tree := f.trees["a"]
	if _, err := f.r.worktrees.Remove(WorktreeRemoveRequest{Dir: tree, Confirmed: &WorktreeRisk{}}); err == nil {
		t.Fatal("a locked worktree stays without a confirmation that says locked")
	}
	plan, err := f.r.worktrees.Plan(WorktreeRequest{Dir: tree})
	if err != nil {
		t.Fatal(err)
	}
	risk := &WorktreeRisk{Sha: plan.Sha, ChangeCount: plan.ChangeCount, Unpushed: plan.Unpushed, IgnoredFileCount: plan.IgnoredFileCount, Locked: true}
	if res, err := f.r.worktrees.Remove(WorktreeRemoveRequest{Dir: tree, Confirmed: risk}); err != nil || !res.Removed {
		t.Fatalf("confirmed locked, it goes: %+v %v", res, err)
	}
}

func TestTreeToolReadsThePath(t *testing.T) {
	home := t.TempDir()
	data := t.TempDir()
	for path, want := range map[string]string{
		filepath.Join(home, "p", ".claude", "worktrees", "agent-1"):           TreeToolClaudeCode,
		filepath.Join(home, "conductor", "workspaces", "SaaSFoundry", "oslo"): TreeToolConductor,
		filepath.Join(home, ".codex", "worktrees", "a1b2", "p"):               TreeToolCodex,
		filepath.Join(DepSyncTreesDir(data), "proj-1a2b", "work-7"):          TreeToolMoltenTerm,
		filepath.Join(home, "p-wt"):                                           "",
	} {
		if got := treeTool(data, home, path); got != want {
			t.Errorf("%s: got %q, want %q", path, got, want)
		}
	}
}

func TestLiveCwdsFindsAProcessWorkingInAFolder(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses /bin/sleep")
	}
	tree := t.TempDir()
	cmd := exec.Command("/bin/sleep", "600")
	cmd.Dir = tree
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cmd.Process.Kill()
		cmd.Wait()
	})
	procs := processesIn(liveCwds(), tree)
	if len(procs) != 1 || procs[0].Pid != int32(cmd.Process.Pid) {
		t.Fatalf("the process working in the folder is found: %+v", procs)
	}
}

func TestProcessesInMatchesTheFolderAndBelow(t *testing.T) {
	tree := t.TempDir()
	cwds := []procCwd{{pid: 1, name: "a", cwd: tree}, {pid: 2, name: "b", cwd: filepath.Join(tree, "x")},
		{pid: 3, name: "c", cwd: tree + "-other"}, {pid: 4, name: "d", cwd: filepath.Dir(tree)}}
	got := processesIn(cwds, tree)
	if len(got) != 2 || got[0].Pid != 1 || got[1].Pid != 2 {
		t.Fatalf("only the processes inside the worktree: %+v", got)
	}
}
