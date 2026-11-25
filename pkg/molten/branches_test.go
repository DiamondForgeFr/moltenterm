// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package molten

import (
	"os"
	"path/filepath"
	"testing"
)

func writeBranchFiles(t *testing.T, pipeline string, sf string) string {
	t.Helper()
	dir := t.TempDir()
	if pipeline != "" {
		os.MkdirAll(filepath.Join(dir, ".molten"), 0755)
		os.WriteFile(filepath.Join(dir, ProjectPipelineFile), []byte(pipeline), 0644)
	}
	if sf != "" {
		os.WriteFile(filepath.Join(dir, ProjectSaaSFoundryFile), []byte(sf), 0644)
	}
	return dir
}

func TestReleaseBranchOrder(t *testing.T) {
	cases := []struct {
		name, pipeline, sf string
		want               ProjectBranches
	}{
		{"nothing declared keeps main", "", "",
			ProjectBranches{Trunk: "develop", Release: "main", TrunkFrom: BranchFromDefault, ReleaseFrom: BranchFromDefault}},
		{"workflow.releaseBranch before mainBranch (#415)", "",
			`{"mainBranch": "main", "workflow": {"workingBranch": "develop", "releaseBranch": "master"}}`,
			ProjectBranches{Trunk: "develop", Release: "master", TrunkFrom: BranchFromSfWorkingBranch, ReleaseFrom: BranchFromSfReleaseBranch}},
		{"mainBranch without a release branch", "", `{"mainBranch": "trunk-main"}`,
			ProjectBranches{Trunk: "develop", Release: "trunk-main", TrunkFrom: BranchFromDefault, ReleaseFrom: BranchFromSfMainBranch}},
		{"the pipeline wins", `{"schema": 1, "name": "x", "branches": {"trunk": "dev", "release": "stable"}}`,
			`{"workflow": {"workingBranch": "develop", "releaseBranch": "master"}}`,
			ProjectBranches{Trunk: "dev", Release: "stable", TrunkFrom: BranchFromPipeline, ReleaseFrom: BranchFromPipeline}},
	}
	for _, c := range cases {
		got := ResolvedBranches(writeBranchFiles(t, c.pipeline, c.sf))
		if got != c.want {
			t.Errorf("%s: got %+v, want %+v", c.name, got, c.want)
		}
	}
	if got := ConfiguredBranches(writeBranchFiles(t, "", "")); got != (ProjectBranches{}) {
		t.Errorf("nothing declared: ConfiguredBranches %+v, want empty names for the defaults", got)
	}
}

// fakeGit answers like a repository with these branches (local or on origin) and this origin/HEAD.
func fakeGit(originHead string, current string, branches ...string) GitQuery {
	has := map[string]bool{}
	for _, b := range branches {
		has["refs/heads/"+b+"^{commit}"] = true
	}
	return func(args ...string) (string, bool) {
		switch {
		case len(args) == 4 && args[0] == "symbolic-ref" && args[3] == "refs/remotes/origin/HEAD":
			return originHead, originHead != ""
		case len(args) == 4 && args[0] == "symbolic-ref" && args[3] == "HEAD":
			return current, current != ""
		case len(args) == 4 && args[0] == "rev-parse":
			return "", has[args[3]]
		}
		return "", false
	}
}

// Git alone names the branches (#2556): origin's default branch, git-flow beside it, the usual names, the checkout.
func TestDetectBranchesFromGit(t *testing.T) {
	cases := []struct {
		name                 string
		git                  GitQuery
		trunk, trunkFrom     string
		release, releaseFrom string
	}{
		{"origin's development", fakeGit("origin/development", "", "development", "main"),
			"development", BranchFromOriginHead, "main", BranchFromRepository},
		{"main only", fakeGit("origin/main", "", "main"), "main", BranchFromOriginHead, "main", BranchFromRepository},
		{"master only", fakeGit("origin/master", "", "master"), "master", BranchFromOriginHead, "master", BranchFromRepository},
		{"git-flow behind origin's main", fakeGit("origin/main", "", "main", "develop"),
			"develop", BranchFromRepository, "main", BranchFromRepository},
		{"no remote, usual names", fakeGit("", "topic", "topic", "dev", "master"), "dev", BranchFromRepository, "master", BranchFromRepository},
		{"no remote, no usual name", fakeGit("", "work", "work"), "work", BranchFromCheckout, "work", BranchFromRepository},
		{"outside git", fakeGit("", ""), "develop", BranchFromDefault, "main", BranchFromDefault},
	}
	for _, c := range cases {
		got := ResolveBranchesWith(t.TempDir(), c.git)
		want := ProjectBranches{Trunk: c.trunk, TrunkFrom: c.trunkFrom, Release: c.release, ReleaseFrom: c.releaseFrom}
		if got != want {
			t.Errorf("%s: got %+v, want %+v", c.name, got, want)
		}
	}
}

// A declared name wins over git; an undeclared release branch is still read beside the declared trunk.
func TestDeclaredBranchesWinOverGit(t *testing.T) {
	git := fakeGit("origin/development", "", "development", "main", "trunk")
	got := ResolveBranchesWith(writeBranchFiles(t, "", `{"workflow": {"workingBranch": "trunk"}}`), git)
	want := ProjectBranches{Trunk: "trunk", TrunkFrom: BranchFromSfWorkingBranch, Release: "main", ReleaseFrom: BranchFromRepository}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	got = ResolveBranchesWith(writeBranchFiles(t, `{"branches": {"trunk": "development", "release": "stable"}}`, ""), git)
	if got.Trunk != "development" || got.Release != "stable" || got.ReleaseFrom != BranchFromPipeline {
		t.Fatalf("settings: %+v", got)
	}
}

func TestReadProjectShowsTheBranches(t *testing.T) {
	dir := writeBranchFiles(t, "", `{"projectName": "sf", "workflow": {"workingBranch": "develop", "releaseBranch": "master"}}`)
	info := ReadProject(dir)
	if info.Branches == nil || info.Branches.Release != "master" || info.Branches.ReleaseFrom != BranchFromSfReleaseBranch {
		t.Fatalf("branches: %+v", info.Branches)
	}
	if ReadProject(t.TempDir()).Branches != nil {
		t.Fatalf("a folder declaring nothing shows no branches")
	}
}
