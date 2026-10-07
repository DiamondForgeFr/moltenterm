// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// ProjectBranches are the two long-lived branches: work is merged into the trunk, releases are cut from the release
// branch. The same branch for both is a single-branch project.
type ProjectBranches struct {
	Trunk   string `json:"trunk"`
	Release string `json:"release"`
}

func readBranchesJson(path string, target any) bool {
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	return json.Unmarshal(data, target) == nil
}

// ConfiguredBranches reads the branch names the project declares: `.molten/project.json` first, then
// `.saasfoundry.json`. Empty names are left to the repository's defaults.
func ConfiguredBranches(dir string) ProjectBranches {
	var rtn ProjectBranches
	var pipeline struct {
		Branches ProjectBranches `json:"branches"`
	}
	if readBranchesJson(filepath.Join(dir, ProjectPipelineFile), &pipeline) {
		rtn = pipeline.Branches
	}
	var sf struct {
		MainBranch string `json:"mainBranch"`
		Workflow   struct {
			WorkingBranch string `json:"workingBranch"`
		} `json:"workflow"`
	}
	if readBranchesJson(filepath.Join(dir, ".saasfoundry.json"), &sf) {
		if rtn.Trunk == "" {
			rtn.Trunk = sf.Workflow.WorkingBranch
		}
		if rtn.Release == "" {
			rtn.Release = sf.MainBranch
		}
	}
	return rtn
}
