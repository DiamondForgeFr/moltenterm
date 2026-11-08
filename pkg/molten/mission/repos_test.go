// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func mkRepoDir(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, ".git"), 0755); err != nil {
		t.Fatal(err)
	}
}

// FR-SHELL-105: the Code repository choice lists the repositories of a folder, and says when the folder is one.
func TestFindReposListsTheFolderRepositories(t *testing.T) {
	t.Parallel()
	client := filepath.Join(t.TempDir(), "client")
	mkRepoDir(t, filepath.Join(client, "app"))
	mkRepoDir(t, filepath.Join(client, "code", "api"))
	answer, err := FindRepos(ReposRequest{Dir: client})
	if err != nil {
		t.Fatal(err)
	}
	if answer.Self || !slices.Equal(answer.Repos, []string{filepath.Join(client, "app"), filepath.Join(client, "code", "api")}) {
		t.Errorf("answer %+v", answer)
	}

	own := filepath.Join(t.TempDir(), "own")
	mkRepoDir(t, own)
	answer, err = FindRepos(ReposRequest{Dir: own})
	if err != nil || !answer.Self || !slices.Equal(answer.Repos, []string{own}) {
		t.Errorf("a folder that is a repository: %+v %v", answer, err)
	}

	none, err := FindRepos(ReposRequest{Dir: t.TempDir()})
	if err != nil || none.Self || none.Repos == nil || len(none.Repos) != 0 {
		t.Errorf("a folder without repository lists none, as an empty list: %+v %v", none, err)
	}
}

func TestFindReposWantsAnAbsoluteFolder(t *testing.T) {
	t.Parallel()
	for _, dir := range []string{"", "relative/folder"} {
		if _, err := FindRepos(ReposRequest{Dir: dir}); err == nil {
			t.Errorf("%q must be refused", dir)
		}
	}
}
