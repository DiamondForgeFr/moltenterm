// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/ghguard"
)

// NoGitMaintenanceConfig turns off git's automatic housekeeping in every git the tests start (#794). After a commit,
// cherry-pick, fetch or push, git spawns `git maintenance run --auto --detach` (or `gc --auto`): a daemon that
// outlives the command and the test, with no handle to wait on. Since git 2.54 its default (geometric) strategy
// repacks a fixture's loose objects, writing packs and a multi-pack-index into .git/objects while t.TempDir empties
// the repository, so the removal fails with "directory not empty".
//
// It is a global config file, not GIT_CONFIG_COUNT: git drops the config variables of the environment when it starts
// receive-pack or upload-pack for a local remote, and the push's receive-pack in a bare origin starts the same daemon.
const NoGitMaintenanceConfig = "[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n[receive]\n\tautogc = false\n"

// TestGitConfigPath is the global git config of the package's tests; a test that wants no user config uses it in
// place of os.DevNull, so it keeps the housekeeping off.
var TestGitConfigPath string

func TestMain(m *testing.M) {
	os.Exit(ghguard.Wrap(func() int { return runWithTestGitConfig(m) }))
}

func runWithTestGitConfig(m *testing.M) int {
	dir, err := os.MkdirTemp("", "mission-gitconfig")
	if err != nil {
		fmt.Printf("making the test git config: %v\n", err)
		return 1
	}
	defer os.RemoveAll(dir)
	TestGitConfigPath = filepath.Join(dir, "gitconfig")
	if err := os.WriteFile(TestGitConfigPath, []byte(NoGitMaintenanceConfig), 0644); err != nil {
		fmt.Printf("writing the test git config: %v\n", err)
		return 1
	}
	os.Setenv("GIT_CONFIG_GLOBAL", TestGitConfigPath)
	return m.Run()
}

func TestGitInTestsSpawnsNoMaintenance(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses git from the PATH")
	}
	origin := t.TempDir()
	gitIn(t, origin, "init", "-q", "--bare", "-b", "develop")
	dir := t.TempDir()
	gitIn(t, dir, "init", "-q", "-b", "develop")
	gitIn(t, dir, "remote", "add", "origin", origin)
	trace := filepath.Join(t.TempDir(), "trace.json")
	t.Setenv("GIT_TRACE2_EVENT", trace)
	commitFile(t, dir, "a.txt", "a\n", "init")
	gitIn(t, dir, "push", "-q", "origin", "develop")
	gitIn(t, dir, "fetch", "-q", "origin")
	data, err := os.ReadFile(trace)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"receive-pack"`) {
		t.Fatal("the trace misses the push's receive-pack: the check would prove nothing")
	}
	if strings.Contains(string(data), `"maintenance"`) || strings.Contains(string(data), `"gc"`) {
		t.Fatal("git spawned its detached maintenance: it would outlive the test and race t.TempDir's cleanup")
	}
}

// #1857: no test reaches the real gh. plainRunner refuses it and records the refusal, so the run fails even when the
// code under test swallows the error; withoutGh is the explicit fake that answers it.
func TestPlainRunnerRefusesGhAndRecordsIt(t *testing.T) {
	dir := t.TempDir()
	out, err := plainRunner(context.Background(), dir, "gh", "pr", "list")
	forgotten := ghguard.Forget(dir)
	if out != nil || !errors.Is(err, ghguard.ErrRealGh) {
		t.Fatalf("plainRunner ran gh: %q, %v", out, err)
	}
	if len(forgotten) != 1 || forgotten[0] != dir+": gh pr list" {
		t.Fatalf("the refusal was not recorded: %q", forgotten)
	}
}

func TestWithoutGhFailsGhQuietlyAndRunsTheRest(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	if out, err := withoutGh(context.Background(), dir, "gh", "pr", "list"); out != nil || err == nil {
		t.Fatalf("withoutGh answered gh: %q, %v", out, err)
	}
	if forgotten := ghguard.Forget(dir); len(forgotten) != 0 {
		t.Fatalf("an explicit fake is not a violation: %q", forgotten)
	}
	if out, err := withoutGh(context.Background(), dir, "git", "--version"); err != nil || !strings.HasPrefix(string(out), "git version") {
		t.Fatalf("withoutGh did not run git: %q, %v", out, err)
	}
}
