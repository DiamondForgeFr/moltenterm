// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

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
