// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestBuildTreeRecoversFromPrunedMetadata(t *testing.T) {
	origin := makeGitFlowRepo(t)
	dir := filepath.Join(t.TempDir(), "project")
	gitIn(t, filepath.Dir(dir), "clone", "-q", origin, dir)
	data := t.TempDir()
	r := MakeRuns(filepath.Join(data, "runs"), MakeTrustStore(filepath.Join(data, TrustFileName)), nil)
	rec := RunRecord{Id: "b1", Dir: dir, Kind: RunKindBuild, State: RunStateRunning}
	if err := os.MkdirAll(filepath.Join(r.projectDir(dir), rec.Id), 0700); err != nil {
		t.Fatal(err)
	}
	file, err := os.Create(filepath.Join(data, "build.log"))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	b := &buildLog{r: r, rec: &rec, file: file}
	want := gitIn(t, dir, "rev-parse", "origin/develop")

	tree, err := r.prepareBuildTree(context.Background(), b)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(dir, ".git", "worktrees", filepath.Base(tree))); err != nil {
		t.Fatal(err)
	}

	tree, err = r.prepareBuildTree(context.Background(), b)
	if err != nil {
		t.Fatalf("a build tree whose metadata was pruned must be recreated: %v", err)
	}
	if got := gitIn(t, tree, "rev-parse", "HEAD"); got != want {
		t.Fatalf("the recreated tree is on %s, want %s", got, want)
	}
	if _, err := r.prepareBuildTree(context.Background(), b); err != nil {
		t.Fatalf("a healthy build tree must be reused: %v", err)
	}
}
