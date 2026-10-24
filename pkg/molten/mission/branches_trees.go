// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/proctree"
)

// Worktrees MoltenTerm did not make (#1028): a coding agent's, another tool's, one the developer made, inside or outside
// the project folder. A merged branch they hold is offered with its worktree only when the worktree is clean, no git
// operation is left in progress, no terminal is open in it and no live process works in it. They are offered unchecked
// (Confirm): the developer checks each one, its folder named, and CleanBranches removes only the folders it was given.

const (
	TreeToolMoltenTerm = "moltenterm"
	TreeToolClaudeCode = "claude-code"
	TreeToolConductor  = "conductor"
	TreeToolCodex      = "codex"
)

// TreeProcess is a live process whose current folder is inside a worktree.
type TreeProcess struct {
	Pid  int32  `json:"pid"`
	Name string `json:"name"`
}

// procCwd: a process and its current folder, symlinks resolved.
type procCwd struct {
	pid  int32
	name string
	cwd  string
}

// gitOperations: the files git leaves in a worktree's git folder while an operation waits for the developer.
var gitOperations = []struct{ file, name string }{
	{"rebase-merge", "rebase"},
	{"rebase-apply", "rebase"},
	{"MERGE_HEAD", "merge"},
	{"CHERRY_PICK_HEAD", "cherry-pick"},
	{"REVERT_HEAD", "revert"},
	{"BISECT_LOG", "bisect"},
}

// gitOperation names the git operation left in progress in a worktree, "" when none.
func gitOperation(gitDir string) string {
	if gitDir == "" {
		return ""
	}
	for _, op := range gitOperations {
		if _, err := os.Lstat(filepath.Join(gitDir, op.file)); err == nil {
			return op.name
		}
	}
	return ""
}

// treeTool tells which tool made a worktree when its path says so, "" otherwise.
func treeTool(dataDir string, home string, path string) string {
	if ownTree(dataDir, path) {
		return TreeToolMoltenTerm
	}
	real := filepath.ToSlash(realPath(path))
	switch {
	case strings.Contains(real, "/.claude/worktrees/"):
		return TreeToolClaudeCode
	case strings.Contains(real, "/.codex/worktrees/"):
		return TreeToolCodex
	case home != "" && pathInside(realPath(path), filepath.Join(realPath(home), "conductor", "workspaces")):
		return TreeToolConductor
	}
	return ""
}

// liveCwds reads the current folder of every live process this user can read, in one pass over the process table.
func liveCwds() []procCwd {
	table, err := proctree.Read()
	if err != nil {
		return nil
	}
	self := int32(os.Getpid())
	var rtn []procCwd
	for _, pid := range table.Pids() {
		p := table.Get(pid)
		if p == nil || p.Zombie || pid == self || pid <= 1 {
			continue
		}
		cwd := proctree.Cwd(pid)
		if cwd == "" || !filepath.IsAbs(cwd) {
			continue
		}
		rtn = append(rtn, procCwd{pid: pid, name: p.Name, cwd: cwd})
	}
	return rtn
}

// processesIn lists the processes working inside path.
func processesIn(cwds []procCwd, path string) []TreeProcess {
	real := realPath(path)
	var rtn []TreeProcess
	for _, p := range cwds {
		if pathInside(realPath(p.cwd), real) {
			rtn = append(rtn, TreeProcess{Pid: p.pid, Name: p.name})
		}
	}
	return rtn
}

func (r *Runs) readCwds() []procCwd {
	if r.treeCwds != nil {
		return r.treeCwds()
	}
	return liveCwds()
}

// treeFit is how a merged branch's worktree reads for branch cleaning.
type treeFit struct {
	// reason: "" when the worktree can go with its branch, else why it stays.
	reason    string
	risk      *WorktreeRisk
	terms     []WorktreeTerminal
	procs     []TreeProcess
	locked    bool
	ignored   int
	operation string
}

// fitTree reads a merged branch's worktree as closing it would (Worktrees.Plan): "" when it can go with its branch,
// else why it stays. Git-ignored files go with it, as after a merge (review/loss.go), and are counted for the row; the
// branch's commits were checked against the pull request or the trunk instead of the remote, deleted by the merge.
func (r *Runs) fitTree(path string, cwds func() []procCwd) treeFit {
	if r.worktrees == nil {
		return treeFit{reason: BranchKeepCheckedOut}
	}
	plan, err := r.worktrees.Plan(WorktreeRequest{Dir: path})
	switch {
	case err != nil:
		return treeFit{reason: BranchKeepCheckedOut}
	case plan.Refused != "":
		return treeFit{reason: BranchKeepTreeRefused}
	case plan.Missing:
		return treeFit{}
	case plan.ChangeCount != 0:
		return treeFit{reason: BranchKeepTreeChanges}
	case plan.Operation != "":
		return treeFit{reason: BranchKeepTreeOperation, operation: plan.Operation}
	case len(plan.Terminals) > 0:
		return treeFit{reason: BranchKeepTreeInUse, terms: plan.Terminals}
	}
	if procs := processesIn(cwds(), path); len(procs) > 0 {
		return treeFit{reason: BranchKeepTreeProcess, procs: procs}
	}
	risk := &WorktreeRisk{Sha: plan.Sha, ChangeCount: plan.ChangeCount, Unpushed: plan.Unpushed,
		IgnoredFileCount: plan.IgnoredFileCount, Locked: plan.Locked}
	return treeFit{risk: risk, locked: plan.Locked, ignored: plan.IgnoredFileCount}
}
