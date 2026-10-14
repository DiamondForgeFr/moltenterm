// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"encoding/json"
	"os"
	"path/filepath"
)

const (
	DefaultTrunkBranch   = "develop"
	DefaultReleaseBranch = "main"

	BranchFromPipeline        = ".molten/project.json branches"
	BranchFromSfWorkingBranch = ".saasfoundry.json workflow.workingBranch"
	BranchFromSfReleaseBranch = ".saasfoundry.json workflow.releaseBranch"
	BranchFromSfMainBranch    = ".saasfoundry.json mainBranch"
	BranchFromDefault         = "the default"
)

// ProjectBranches are the two long-lived branches: work is merged into the trunk, releases are cut from the release
// branch. The same branch for both is a single-branch project.
type ProjectBranches struct {
	Trunk   string `json:"trunk"`
	Release string `json:"release"`
	// Where each name was read (BranchFrom…); empty when nothing declares it.
	TrunkFrom   string `json:"trunkfrom,omitempty"`
	ReleaseFrom string `json:"releasefrom,omitempty"`
}

func readBranchesJson(path string, target any) bool {
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	return json.Unmarshal(data, target) == nil
}

// ConfiguredBranches reads the branch names the project declares: `.molten/project.json` first, then
// `.saasfoundry.json` (the release branch from workflow.releaseBranch, else mainBranch, #415). Empty names are left
// to the repository's defaults.
func ConfiguredBranches(dir string) ProjectBranches {
	var rtn ProjectBranches
	var pipeline struct {
		Branches ProjectBranches `json:"branches"`
	}
	if readBranchesJson(filepath.Join(dir, ProjectPipelineFile), &pipeline) {
		if pipeline.Branches.Trunk != "" {
			rtn.Trunk, rtn.TrunkFrom = pipeline.Branches.Trunk, BranchFromPipeline
		}
		if pipeline.Branches.Release != "" {
			rtn.Release, rtn.ReleaseFrom = pipeline.Branches.Release, BranchFromPipeline
		}
	}
	var sf struct {
		MainBranch string `json:"mainBranch"`
		Workflow   struct {
			WorkingBranch string `json:"workingBranch"`
			ReleaseBranch string `json:"releaseBranch"`
		} `json:"workflow"`
	}
	if readBranchesJson(filepath.Join(dir, ".saasfoundry.json"), &sf) {
		if rtn.Trunk == "" && sf.Workflow.WorkingBranch != "" {
			rtn.Trunk, rtn.TrunkFrom = sf.Workflow.WorkingBranch, BranchFromSfWorkingBranch
		}
		if rtn.Release == "" && sf.Workflow.ReleaseBranch != "" {
			rtn.Release, rtn.ReleaseFrom = sf.Workflow.ReleaseBranch, BranchFromSfReleaseBranch
		}
		if rtn.Release == "" && sf.MainBranch != "" {
			rtn.Release, rtn.ReleaseFrom = sf.MainBranch, BranchFromSfMainBranch
		}
	}
	return rtn
}

// PrTargetBranch is the branch the project's pull requests target, as `.saasfoundry.json` declares it
// (workflow.prTargetBranch); empty when nothing declares it, and the caller falls back to the trunk (FR-REV-001).
func PrTargetBranch(dir string) string {
	var sf struct {
		Workflow struct {
			PrTargetBranch string `json:"prTargetBranch"`
		} `json:"workflow"`
	}
	if !readBranchesJson(filepath.Join(dir, ProjectSaaSFoundryFile), &sf) {
		return ""
	}
	return sf.Workflow.PrTargetBranch
}

// ResolvedBranches are the configured branches with the defaults filled in, each with where it came from.
func ResolvedBranches(dir string) ProjectBranches {
	rtn := ConfiguredBranches(dir)
	if rtn.Trunk == "" {
		rtn.Trunk, rtn.TrunkFrom = DefaultTrunkBranch, BranchFromDefault
	}
	if rtn.Release == "" {
		rtn.Release, rtn.ReleaseFrom = DefaultReleaseBranch, BranchFromDefault
	}
	return rtn
}
