// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agenthandoff

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func gitIn(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

// The merge queue's agent works in a detached worktree under MoltenTerm's data folder (#1123): it belongs to the
// project the worktree was made from, never to the worktree's folder.
func TestProjectDirOfAWorktreeOutsideTheProject(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	project := filepath.Join(base, "MoltenTerm")
	if err := os.MkdirAll(project, 0700); err != nil {
		t.Fatal(err)
	}
	gitIn(t, project, "init", "-q", "-b", "develop")
	gitIn(t, project, "commit", "-q", "--allow-empty", "-m", "first")
	tree := filepath.Join(base, "data", "molten", "worktrees", "MoltenTerm-beeb5ffc", "batch-merge-6")
	if err := os.MkdirAll(filepath.Dir(tree), 0700); err != nil {
		t.Fatal(err)
	}
	gitIn(t, project, "worktree", "add", "--detach", "-q", tree, "develop")
	sub := filepath.Join(tree, "pkg")
	if err := os.MkdirAll(sub, 0700); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name    string
		folder  string
		project string
		want    string
	}{
		{"the workspace's project", tree, project, project},
		{"a subfolder of the tree", sub, project, project},
		{"no workspace project", tree, "", project},
		{"another workspace project", tree, filepath.Join(base, "Other"), project},
		{"the main checkout itself", project, "", project},
	}
	for _, c := range cases {
		if got := projectDirOf(c.folder, c.project); got != c.want {
			t.Errorf("%s: projectDirOf(%s, %s) = %s, want %s", c.name, c.folder, c.project, got, c.want)
		}
		if got := projectName(projectDirOf(c.folder, c.project)); got != "MoltenTerm" {
			t.Errorf("%s: project name %q, want MoltenTerm", c.name, got)
		}
	}
	plain := filepath.Join(base, "plain")
	if err := os.MkdirAll(plain, 0700); err != nil {
		t.Fatal(err)
	}
	if got := projectDirOf(plain, ""); got != plain {
		t.Errorf("a folder outside any repository: %s, want %s", got, plain)
	}
}
