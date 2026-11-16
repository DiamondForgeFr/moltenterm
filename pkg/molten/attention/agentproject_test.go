// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package attention

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func makeFolders(t *testing.T, dirs ...string) {
	t.Helper()
	for _, dir := range dirs {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
}

// The key an agent's locked names are kept under (#2324): the workspace project's repository, so two projects that share
// a folder stay apart; else the project's folder; else the folder's git root.
func TestProjectKeyOfATerminal(t *testing.T) {
	t.Parallel()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	alpha := filepath.Join(base, "alpha")
	client := filepath.Join(base, "client")
	repoA := filepath.Join(client, "site")
	repoB := filepath.Join(client, "app")
	outside := filepath.Join(base, "scratch")
	makeFolders(t, filepath.Join(alpha, "pkg"), filepath.Join(repoA, ".git"), filepath.Join(repoA, "src"),
		filepath.Join(repoB, ".git"), filepath.Join(repoB, "src"), filepath.Join(outside, ".git"), filepath.Join(outside, "src"))

	single := waveobj.MetaMapType{molten.ProjectMetaKey: alpha}
	if got := projectKeyOf(filepath.Join(alpha, "pkg"), single); got != alpha {
		t.Errorf("a folder of the workspace's only project: %q, want %q", got, alpha)
	}

	// Two projects share the client's folder and differ by their repository (#1777); the first is the current one.
	shared := waveobj.MetaMapType{
		molten.ProjectMetaKey:     client,
		molten.ProjectRepoMetaKey: repoA,
		"molten:currentproject":   "p1",
		"molten:projects": []any{
			map[string]any{"id": "p1", "dir": client, "repo": repoA},
			map[string]any{"id": "p2", "dir": client, "repo": repoB},
		},
	}
	if got := projectKeyOf(filepath.Join(repoA, "src"), shared); got != repoA {
		t.Errorf("a terminal in the first repository: %q, want %q", got, repoA)
	}
	if got := projectKeyOf(filepath.Join(repoB, "src"), shared); got != repoB {
		t.Errorf("a terminal in the second repository: %q, want %q", got, repoB)
	}

	if got := projectKeyOf(filepath.Join(outside, "src"), single); got != outside {
		t.Errorf("a repository outside the workspace's projects: %q, want its root %q", got, outside)
	}
	if got := projectKeyOf(filepath.Join(outside, "src"), nil); got != outside {
		t.Errorf("a workspace without a project: %q, want %q", got, outside)
	}
	if got := projectKeyOf("", shared); got != repoA {
		t.Errorf("a terminal with no folder known takes the workspace's repository: %q, want %q", got, repoA)
	}
	if got := projectKeyOf("", nil); got != "" {
		t.Errorf("nothing known: %q", got)
	}
}
