// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package molten

import (
	"os"
	"path/filepath"
	"testing"
)

// The project of an agent's terminal (#2324): the workspace's project when the terminal's folder is in it, else the
// folder's git root, else the folder. The linked worktrees are tested through the hand-offs (agenthandoff).
func TestProjectDirOf(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	project := filepath.Join(base, "alpha")
	other := filepath.Join(base, "beta")
	plain := filepath.Join(base, "plain")
	for _, dir := range []string{filepath.Join(project, "pkg", "deep"), filepath.Join(other, ".git"), filepath.Join(other, "src"), plain} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	cases := []struct {
		name    string
		folder  string
		project string
		want    string
	}{
		{"the project's own folder", project, project, project},
		{"a folder inside the project", filepath.Join(project, "pkg", "deep"), project, project},
		{"no folder known", "", project, project},
		{"a repository outside the workspace's project", filepath.Join(other, "src"), project, other},
		{"a sibling folder with the project's name as a prefix", project + "-site", project, project + "-site"},
		{"no workspace project, in a repository", filepath.Join(other, "src"), "", other},
		{"no workspace project, in no repository", plain, "", plain},
		{"nothing known", "", "", ""},
	}
	for _, c := range cases {
		if got := ProjectDirOf(c.folder, c.project); got != c.want {
			t.Errorf("%s: ProjectDirOf(%q, %q) = %q, want %q", c.name, c.folder, c.project, got, c.want)
		}
	}
}
