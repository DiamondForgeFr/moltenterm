// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package molten

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const (
	DefaultTrunkBranch   = "develop"
	DefaultReleaseBranch = "main"

	BranchFromPipeline        = ".molten/project.json branches"
	BranchFromSfWorkingBranch = ".saasfoundry.json workflow.workingBranch"
	BranchFromSfReleaseBranch = ".saasfoundry.json workflow.releaseBranch"
	BranchFromSfMainBranch    = ".saasfoundry.json mainBranch"
	BranchFromDefault         = "the default"
	// Read from git alone (#2556): origin's default branch, a branch of the repository found by its usual name, or the
	// branch checked out in a repository that has neither.
	BranchFromOriginHead = "origin/HEAD"
	BranchFromRepository = "git branch"
	BranchFromCheckout   = "the branch checked out"
)

// The usual names of a trunk, in the order they are looked for when origin names no default branch; a git-flow
// repository has its working branch before main.
var CommonTrunkNames = []string{"develop", "development", "dev", "main", "master"}

// The usual names of a release branch: a trunk under one of them is a single-branch project.
var CommonReleaseNames = []string{"main", "master"}

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

// GitQuery runs one git command in the project and returns its trimmed output; ok is false when git failed.
type GitQuery func(args ...string) (string, bool)

// ExecGitQuery runs git in dir.
func ExecGitQuery(dir string) GitQuery {
	return func(args ...string) (string, bool) {
		out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).Output()
		if err != nil {
			return "", false
		}
		return strings.TrimSpace(string(out)), true
	}
}

// HasBranch: the branch exists locally or on origin.
func HasBranch(git GitQuery, name string) bool {
	if name == "" {
		return false
	}
	for _, ref := range []string{"refs/heads/" + name, "refs/remotes/origin/" + name} {
		if _, ok := git("rev-parse", "--verify", "--quiet", ref+"^{commit}"); ok {
			return true
		}
	}
	return false
}

func firstBranch(git GitQuery, names []string, skip string) string {
	for _, name := range names {
		if name != skip && HasBranch(git, name) {
			return name
		}
	}
	return ""
}

func isReleaseName(name string) bool {
	for _, n := range CommonReleaseNames {
		if n == name {
			return true
		}
	}
	return false
}

// DetectTrunk reads the trunk from git alone (#2556): origin's default branch, unless it is a release name (main,
// master) beside a working branch (develop, development, dev), which is git-flow; then the usual names; then the branch
// checked out. Empty outside a repository.
func DetectTrunk(git GitQuery) (string, string) {
	if head, ok := git("symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"); ok && head != "" {
		head = strings.TrimPrefix(head, "origin/")
		if HasBranch(git, head) {
			if isReleaseName(head) {
				if work := firstBranch(git, CommonTrunkNames[:3], ""); work != "" {
					return work, BranchFromRepository
				}
			}
			return head, BranchFromOriginHead
		}
	}
	if name := firstBranch(git, CommonTrunkNames, ""); name != "" {
		return name, BranchFromRepository
	}
	if current, ok := git("symbolic-ref", "--quiet", "--short", "HEAD"); ok && current != "" {
		return current, BranchFromCheckout
	}
	return "", ""
}

// DetectRelease reads the release branch beside a trunk: main or master when the trunk is another branch, else the
// trunk itself (a single-branch project).
func DetectRelease(git GitQuery, trunk string) (string, string) {
	if !isReleaseName(trunk) {
		if name := firstBranch(git, CommonReleaseNames, trunk); name != "" {
			return name, BranchFromRepository
		}
	}
	if trunk == "" {
		return "", ""
	}
	return trunk, BranchFromRepository
}

// ResolveBranchesWith fills what the project does not declare from git (#2556), then from MoltenTerm's defaults when git
// tells nothing (outside a repository). A declared name always wins, so SaaSFoundry or the project settings refine
// what git gives and are never required for it.
func ResolveBranchesWith(dir string, git GitQuery) ProjectBranches {
	rtn := ConfiguredBranches(dir)
	if rtn.Trunk == "" {
		rtn.Trunk, rtn.TrunkFrom = DetectTrunk(git)
	}
	if rtn.Release == "" && rtn.Trunk != "" {
		rtn.Release, rtn.ReleaseFrom = DetectRelease(git, rtn.Trunk)
		if rtn.ReleaseFrom == BranchFromRepository && rtn.Release == rtn.Trunk && !HasBranch(git, rtn.Trunk) {
			// A declared trunk this clone lacks says nothing of the release branch.
			rtn.Release, rtn.ReleaseFrom = "", ""
		}
	}
	if rtn.Trunk == "" {
		rtn.Trunk, rtn.TrunkFrom = DefaultTrunkBranch, BranchFromDefault
	}
	if rtn.Release == "" {
		rtn.Release, rtn.ReleaseFrom = DefaultReleaseBranch, BranchFromDefault
	}
	return rtn
}

// ResolvedBranches are the project's branches, each with where it came from: the declared ones, else the ones git
// gives (#2556), else MoltenTerm's defaults.
func ResolvedBranches(dir string) ProjectBranches {
	return ResolveBranchesWith(dir, ExecGitQuery(dir))
}
