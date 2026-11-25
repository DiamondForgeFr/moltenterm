// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// A project without SaaSFoundry or settings is read from git alone (#2556): fixtures are clones of a local upstream, so
// origin/HEAD is what a real clone gets.

func commitDated(t *testing.T, dir string, file string, subject string, date string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, file), []byte(subject), 0644); err != nil {
		t.Fatal(err)
	}
	gitRun(t, dir, "add", file)
	cmd := exec.Command("git", "commit", "-q", "-m", subject)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
		"GIT_AUTHOR_DATE="+date, "GIT_COMMITTER_DATE="+date)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git commit: %v\n%s", err, out)
	}
}

// cloneOf clones upstream the way a developer does, so origin/HEAD names upstream's default branch.
func cloneOf(t *testing.T, upstream string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "clone")
	gitRun(t, filepath.Dir(dir), "clone", "-q", upstream, dir)
	return dir
}

func requireGit(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
}

// An upstream whose default branch is development, with main beside it, a branch merged with a merge commit and one
// still open on origin.
func makeDevelopmentUpstream(t *testing.T) string {
	t.Helper()
	requireGit(t)
	up := t.TempDir()
	gitRun(t, up, "init", "-q", "-b", "main")
	commit(t, up, "a.txt", "feat: first")
	gitRun(t, up, "checkout", "-q", "-b", "development")
	commit(t, up, "b.txt", "feat: second")
	gitRun(t, up, "checkout", "-q", "-b", "feature/login")
	commit(t, up, "c.txt", "feat: login")
	gitRun(t, up, "checkout", "-q", "development")
	gitRun(t, up, "merge", "-q", "--no-ff", "-m", "Merge branch 'feature/login' into development", "feature/login")
	return up
}

func collect(t *testing.T, dir string) *GitSnapshot {
	t.Helper()
	snap, err := CollectGit(context.Background(), plainRunner, dir, false)
	if err != nil {
		t.Fatal(err)
	}
	return snap
}

func trunkCommits(snap *GitSnapshot) int {
	for _, b := range snap.Branches {
		if b.Name == snap.Trunk {
			return len(b.Commits)
		}
	}
	return -1
}

func TestCollectGitTrunkDevelopmentFromOriginHead(t *testing.T) {
	t.Parallel()
	dir := cloneOf(t, makeDevelopmentUpstream(t))
	snap := collect(t, dir)
	if snap.Trunk != "development" || snap.TrunkFrom != molten.BranchFromOriginHead {
		t.Fatalf("trunk %q from %q", snap.Trunk, snap.TrunkFrom)
	}
	if snap.Release != "main" || snap.ReleaseFrom != molten.BranchFromRepository {
		t.Fatalf("release %q from %q", snap.Release, snap.ReleaseFrom)
	}
	if n := trunkCommits(snap); n != 3 {
		t.Fatalf("development's first-parent history: %d commits", n)
	}
	if len(snap.Merges) != 1 || snap.Merges[0].Commits != 1 || snap.Merges[0].Fork == nil {
		t.Fatalf("merges drawn from history: %+v", snap.Merges)
	}
	if snap.VersionsDeclared {
		t.Fatal("no settings declare versions")
	}
}

func TestCollectGitTrunkMainOnly(t *testing.T) {
	t.Parallel()
	requireGit(t)
	up := t.TempDir()
	gitRun(t, up, "init", "-q", "-b", "main")
	commit(t, up, "a.txt", "first")
	commit(t, up, "b.txt", "second")
	dir := cloneOf(t, up)
	gitRun(t, dir, "checkout", "-q", "-b", "topic")
	commit(t, dir, "c.txt", "topic work")
	snap := collect(t, dir)
	if snap.Trunk != "main" || snap.Release != "main" || snap.TrunkFrom != molten.BranchFromOriginHead {
		t.Fatalf("single branch: trunk %q (%q) release %q", snap.Trunk, snap.TrunkFrom, snap.Release)
	}
	if n := trunkCommits(snap); n != 2 {
		t.Fatalf("main's history: %d commits", n)
	}
	found := false
	for _, b := range snap.Branches {
		if b.Name == "topic" && len(b.Commits) == 1 && b.Fork != nil {
			found = true
		}
	}
	if !found {
		t.Fatalf("open branch drawn: %+v", snap.Branches)
	}
}

func TestCollectGitTrunkMasterWithTags(t *testing.T) {
	t.Parallel()
	requireGit(t)
	up := t.TempDir()
	gitRun(t, up, "init", "-q", "-b", "master")
	commit(t, up, "a.txt", "first")
	gitRun(t, up, "tag", "v0.1.0")
	commit(t, up, "b.txt", "second")
	gitRun(t, up, "tag", "-a", "v0.2.0", "-m", "v0.2.0")
	commit(t, up, "c.txt", "third")
	snap := collect(t, cloneOf(t, up))
	if snap.Trunk != "master" || snap.Release != "master" {
		t.Fatalf("trunk %q release %q", snap.Trunk, snap.Release)
	}
	if len(snap.Tags) != 2 || snap.LastPublic != "v0.2.0" || len(snap.SincePublic) != 1 {
		t.Fatalf("tags %+v, last public %q, since %d", snap.Tags, snap.LastPublic, len(snap.SincePublic))
	}
}

// A fresh clone of an old history: the commits are still read, whatever the window the panel draws.
func TestCollectGitOldHistory(t *testing.T) {
	t.Parallel()
	requireGit(t)
	up := t.TempDir()
	gitRun(t, up, "init", "-q", "-b", "development")
	commitDated(t, up, "a.txt", "first", "2021-03-01T10:00:00Z")
	commitDated(t, up, "b.txt", "second", "2021-04-01T10:00:00Z")
	snap := collect(t, cloneOf(t, up))
	if snap.Trunk != "development" || trunkCommits(snap) != 2 {
		t.Fatalf("trunk %q, %d commits", snap.Trunk, trunkCommits(snap))
	}
	if snap.Branches[0].Date == "" || snap.Branches[0].Date[:4] != "2021" {
		t.Fatalf("trunk date: %q", snap.Branches[0].Date)
	}
}

// Without a remote, the usual names, then the branch checked out.
func TestCollectGitTrunkWithoutRemote(t *testing.T) {
	t.Parallel()
	requireGit(t)
	dir := t.TempDir()
	gitRun(t, dir, "init", "-q", "-b", "work")
	commit(t, dir, "a.txt", "first")
	snap := collect(t, dir)
	if snap.Trunk != "work" || snap.TrunkFrom != molten.BranchFromCheckout || trunkCommits(snap) != 1 {
		t.Fatalf("checked-out trunk %q from %q", snap.Trunk, snap.TrunkFrom)
	}
	gitRun(t, dir, "branch", "dev")
	if snap := collect(t, dir); snap.Trunk != "dev" || snap.TrunkFrom != molten.BranchFromRepository {
		t.Fatalf("usual name: trunk %q from %q", snap.Trunk, snap.TrunkFrom)
	}
}

// The manifest and the project settings still name the branches when they exist in the clone.
func TestCollectGitDeclaredBranchesOverrideDetection(t *testing.T) {
	t.Parallel()
	dir := cloneOf(t, makeDevelopmentUpstream(t))
	os.WriteFile(filepath.Join(dir, ".saasfoundry.json"), []byte(`{"workflow":{"workingBranch":"main"}}`), 0644)
	snap := collect(t, dir)
	if snap.Trunk != "main" || snap.TrunkFrom != molten.BranchFromSfWorkingBranch {
		t.Fatalf("SaaSFoundry's trunk: %q from %q", snap.Trunk, snap.TrunkFrom)
	}
	os.MkdirAll(filepath.Join(dir, ".molten"), 0755)
	os.WriteFile(filepath.Join(dir, ".molten", "project.json"),
		[]byte(`{"branches":{"trunk":"development","release":"development"},"versions":{"tagprefix":"release-"}}`), 0644)
	snap = collect(t, dir)
	if snap.Trunk != "development" || snap.Release != "development" || snap.TrunkFrom != molten.BranchFromPipeline ||
		snap.ReleaseFrom != molten.BranchFromPipeline {
		t.Fatalf("settings: %+v", snap)
	}
	if !snap.VersionsDeclared || snap.TagPrefix != "release-" {
		t.Fatalf("declared versions: %v %q", snap.VersionsDeclared, snap.TagPrefix)
	}
	// A declared branch this clone lacks falls back to what git gives.
	os.WriteFile(filepath.Join(dir, ".molten", "project.json"), []byte(`{"branches":{"trunk":"gone"}}`), 0644)
	if snap := collect(t, dir); snap.Trunk != "development" || snap.TrunkFrom != molten.BranchFromOriginHead {
		t.Fatalf("missing declared trunk: %q from %q", snap.Trunk, snap.TrunkFrom)
	}
}

// The other panels read the same branches: ResolvedBranches (CI/CD's branches, the release facts, Integration's target)
// and the dependency trunk.
func TestResolvedBranchesWithoutManifest(t *testing.T) {
	t.Parallel()
	dir := cloneOf(t, makeDevelopmentUpstream(t))
	b := molten.ResolvedBranches(dir)
	if b.Trunk != "development" || b.Release != "main" || b.TrunkFrom != molten.BranchFromOriginHead {
		t.Fatalf("resolved: %+v", b)
	}
	target, from := reviewTarget(Snapshot{Dir: dir})
	if target != "development" || from != ReviewTargetFromTrunk {
		t.Fatalf("Integration's target: %q from %q", target, from)
	}
	g := &gitReader{ctx: context.Background(), run: plainRunner, dir: dir}
	trunk, _, err := g.dependentTrunk()
	if err != nil || trunk != "development" {
		t.Fatalf("dependency trunk %q: %v", trunk, err)
	}
	if name, ref := resolveTrunk(context.Background(), plainRunner, dir); name != "development" || ref != "origin/development" {
		t.Fatalf("builds' trunk %q %q", name, ref)
	}
}
