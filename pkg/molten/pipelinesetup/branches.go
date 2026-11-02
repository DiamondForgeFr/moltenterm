// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"os/exec"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// The branches the setup builds on (#1106): the declared ones, else MoltenTerm's defaults (develop, main) when the
// repository has them, else the repository's own. A repository with only main is a single-branch project on main, not
// a missing develop: drafting on a branch that does not exist would leave nothing to open a pull request from.

// BranchFromRepository: the name was read from the repository's branches; shown as the point's source.
const BranchFromRepository = "git branch"

func gitQuiet(dir string, args ...string) (string, bool) {
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	out, err := cmd.Output()
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(string(out)), true
}

func hasBranch(dir string, name string) bool {
	if _, ok := gitQuiet(dir, "rev-parse", "--verify", "--quiet", "refs/heads/"+name); ok {
		return true
	}
	_, ok := gitQuiet(dir, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/"+name)
	return ok
}

// repositoryTrunk: origin's default branch, else the branch checked out.
func repositoryTrunk(dir string) string {
	if head, ok := gitQuiet(dir, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"); ok && head != "" {
		return strings.TrimPrefix(head, "origin/")
	}
	head, _ := gitQuiet(dir, "symbolic-ref", "--quiet", "--short", "HEAD")
	return head
}

// SetupBranches: the project's branches as the setup reads them.
func SetupBranches(dir string) molten.ProjectBranches {
	b := molten.ResolvedBranches(dir)
	if b.TrunkFrom != molten.BranchFromDefault && b.ReleaseFrom != molten.BranchFromDefault {
		return b
	}
	if _, ok := gitQuiet(dir, "rev-parse", "--verify", "--quiet", "HEAD"); !ok {
		return b
	}
	if b.TrunkFrom == molten.BranchFromDefault && !hasBranch(dir, b.Trunk) {
		if trunk := repositoryTrunk(dir); trunk != "" {
			b.Trunk, b.TrunkFrom = trunk, BranchFromRepository
		}
	}
	if b.ReleaseFrom == molten.BranchFromDefault && !hasBranch(dir, b.Release) {
		b.Release, b.ReleaseFrom = b.Trunk, BranchFromRepository
	}
	return b
}
