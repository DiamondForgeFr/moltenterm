// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// A repository with only main is set up on main (#1106); the declared branches and MoltenTerm's defaults, when the
// repository has them, stay.
func TestSetupBranchesFollowTheRepository(t *testing.T) {
	only := surveyRepository(t, map[string]string{"README.md": "# App\n"})
	gitIn(t, only, "branch", "-m", "develop", "main")
	if b := SetupBranches(only); b.Trunk != "main" || b.Release != "main" || b.TrunkFrom != BranchFromRepository {
		t.Fatalf("only main: %+v", b)
	}
	both := surveyRepository(t, map[string]string{"README.md": "# App\n"})
	gitIn(t, both, "branch", "main")
	if b := SetupBranches(both); b.Trunk != "develop" || b.Release != "main" || b.TrunkFrom != molten.BranchFromDefault {
		t.Fatalf("develop and main: %+v", b)
	}
	declared := surveyRepository(t, map[string]string{".saasfoundry.json": `{"mainBranch": "master", "workflow": {"workingBranch": "trunk"}}`})
	if b := SetupBranches(declared); b.Trunk != "trunk" || b.Release != "master" {
		t.Fatalf("declared: %+v", b)
	}
	if b := SetupBranches(t.TempDir()); b.Trunk != molten.DefaultTrunkBranch || b.Release != molten.DefaultReleaseBranch {
		t.Fatalf("outside git: %+v", b)
	}
}
