// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package pipelinesetup

import (
	"github.com/wavetermdev/waveterm/pkg/molten"
)

// The branches the setup builds on (#1106): the declared ones, else the ones git gives (origin's default branch, the
// usual names, the branch checked out, #2556), else MoltenTerm's defaults outside a repository. A repository with only
// main is a single-branch project on main, not a missing develop: drafting on a branch that does not exist would leave
// nothing to open a pull request from.

// BranchFromRepository: the name was read from the repository's branches; shown as the point's source.
const BranchFromRepository = molten.BranchFromRepository

// SetupBranches: the project's branches as the setup reads them.
func SetupBranches(dir string) molten.ProjectBranches {
	return molten.ResolvedBranches(dir)
}

// readFromGit: the name was read from the repository rather than declared.
func readFromGit(from string) bool {
	return from == molten.BranchFromRepository || from == molten.BranchFromOriginHead || from == molten.BranchFromCheckout
}
