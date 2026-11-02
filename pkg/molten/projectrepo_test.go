// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func mkRepo(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, ".git"), 0755); err != nil {
		t.Fatal(err)
	}
}

func mkDir(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
}

// FR-SHELL-105: the repository the Git features read is the chosen one when it lies inside the folder, else the
// folder (a project without one, or a folder that is itself the repository, is unchanged).
func TestProjectRepoOf(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "client")
	cases := []struct {
		name, folder, repo, want string
	}{
		{"none chosen", folder, "", folder},
		{"inside", folder, filepath.Join(folder, "app"), filepath.Join(folder, "app")},
		{"deeper, with a trailing separator", folder, filepath.Join(folder, "code", "app") + string(filepath.Separator), filepath.Join(folder, "code", "app")},
		{"the folder itself", folder, folder, folder},
		{"outside the folder", folder, filepath.Join(filepath.Dir(folder), "other"), folder},
		{"a sibling with the folder's name as prefix", folder, folder + "-old", folder},
		{"relative", folder, "app", folder},
		{"no folder", "", filepath.Join(folder, "app"), ""},
	}
	for _, c := range cases {
		if got := ProjectRepoOf(c.folder, c.repo); got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
}

func TestWorkspaceRepoReadsTheLiveKeys(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "client")
	repo := filepath.Join(folder, "app")
	meta := waveobj.MetaMapType{ProjectMetaKey: folder, ProjectRepoMetaKey: repo}
	if got := WorkspaceRepo(meta); got != repo {
		t.Errorf("repo: %q", got)
	}
	if got := WorkspaceRepoOfMap(map[string]any{ProjectMetaKey: folder, ProjectRepoMetaKey: repo}); got != repo {
		t.Errorf("map: %q", got)
	}
	delete(meta, ProjectRepoMetaKey)
	if got := WorkspaceRepo(meta); got != folder {
		t.Errorf("a workspace without a repository reads its folder: %q", got)
	}
	if got := WorkspaceRepo(waveobj.MetaMapType{}); got != "" {
		t.Errorf("an unlinked workspace has none: %q", got)
	}
}

func TestFindRepositories(t *testing.T) {
	root := t.TempDir()

	selfRepo := filepath.Join(root, "self")
	mkRepo(t, selfRepo)
	mkRepo(t, filepath.Join(selfRepo, "vendored"))
	if got := FindRepositories(selfRepo); !slices.Equal(got, []string{selfRepo}) {
		t.Errorf("a folder that is a repository lists itself alone: %v", got)
	}

	client := filepath.Join(root, "client")
	mkDir(t, filepath.Join(client, "docs"))
	mkDir(t, filepath.Join(client, "mails", "2026"))
	mkRepo(t, filepath.Join(client, "app"))
	mkRepo(t, filepath.Join(client, "app", "nested"))
	mkRepo(t, filepath.Join(client, "code", "api"))
	mkRepo(t, filepath.Join(client, "a", "b", "c", "toodeep"))
	mkRepo(t, filepath.Join(client, "node_modules", "pkg"))
	mkRepo(t, filepath.Join(client, ".hidden", "repo"))
	if err := os.WriteFile(filepath.Join(client, "docs", ".git"), []byte("gitdir: ../elsewhere\n"), 0644); err != nil {
		t.Fatal(err)
	}
	want := []string{filepath.Join(client, "app"), filepath.Join(client, "docs"), filepath.Join(client, "code", "api")}
	if got := FindRepositories(client); !slices.Equal(got, want) {
		t.Errorf("found %v, want %v (shallowest first; a worktree's .git file counts; nothing in a repository, node_modules, hidden folders or past 3 levels)", got, want)
	}

	empty := filepath.Join(root, "empty")
	mkDir(t, filepath.Join(empty, "docs"))
	if got := FindRepositories(empty); got == nil || len(got) != 0 {
		t.Errorf("a folder without repository lists none: %v", got)
	}
	if got := FindRepositories(filepath.Join(root, "missing")); got == nil || len(got) != 0 {
		t.Errorf("a missing folder lists none: %v", got)
	}
	if got := FindRepositories("relative"); len(got) != 0 {
		t.Errorf("a relative folder lists none: %v", got)
	}
}

func TestFindRepositoriesDoesNotFollowLinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks")
	}
	root := t.TempDir()
	outside := filepath.Join(root, "outside", "secret")
	mkRepo(t, outside)
	client := filepath.Join(root, "client")
	mkDir(t, client)
	if err := os.Symlink(filepath.Join(root, "outside"), filepath.Join(client, "link")); err != nil {
		t.Fatal(err)
	}
	if got := FindRepositories(client); len(got) != 0 {
		t.Errorf("a link to a folder outside is not followed: %v", got)
	}
}

func TestFindRepositoriesIsBounded(t *testing.T) {
	client := filepath.Join(t.TempDir(), "client")
	for i := 0; i < repoSearchMax+10; i++ {
		mkRepo(t, filepath.Join(client, "r"+string(rune('a'+i%26))+string(rune('a'+i/26))))
	}
	if got := FindRepositories(client); len(got) != repoSearchMax {
		t.Errorf("%d repositories listed, want the bound %d", len(got), repoSearchMax)
	}
}
