// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// An agent that discovers the CLI through `molten help` must find how to start the local CI (#383).
func TestMoltenHelpListsTheLocalCi(t *testing.T) {
	out := formatMoltenHelp(nil)
	for _, want := range []string{"ci run [branch] [--only <jobs>] [--force]", "ci status [rev]"} {
		if !strings.Contains(out, want) {
			t.Errorf("molten help lacks %q:\n%s", want, out)
		}
	}
	for _, flag := range []string{"only", "force"} {
		if moltenCiRunCmd.Flags().Lookup(flag) == nil {
			t.Errorf("molten ci run has no --%s: the help describes it", flag)
		}
	}
}

func gitForCiTest(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// Trust, verdicts and runs are kept per folder: from a linked worktree the CI must target the main checkout, which
// is the folder Mission Control shows.
func TestMoltenCiResolveDirFromALinkedWorktree(t *testing.T) {
	main := t.TempDir()
	gitForCiTest(t, main, "init", "-q", "-b", "develop")
	gitForCiTest(t, main, "commit", "-q", "--allow-empty", "-m", "init")
	worktree := filepath.Join(t.TempDir(), "wt")
	gitForCiTest(t, main, "worktree", "add", "-q", "-b", "feature/383-x", worktree)

	realMain, err := filepath.EvalSymlinks(main)
	if err != nil {
		t.Fatal(err)
	}
	if got := moltenCiResolveDir(worktree, ""); got != realMain {
		t.Errorf("no link known: want the main checkout %s, got %s", realMain, got)
	}
	if got := moltenCiResolveDir(worktree, main); got != main {
		t.Errorf("workspace linked to the main checkout: want the linked path %s, got %s", main, got)
	}
	if got := moltenCiResolveDir(worktree, worktree); got != worktree {
		t.Errorf("workspace linked to the worktree itself: want %s, got %s", worktree, got)
	}
	if got := moltenCiResolveDir(main, ""); got != main {
		t.Errorf("a main checkout stays itself: got %s", got)
	}
}

// #1072: with no branch, `molten ci run` and `molten ci status` send the checkout containing the terminal's folder,
// from any subfolder of a linked worktree, while the project folder stays the main checkout.
func TestMoltenCiSendsTheCallersCheckout(t *testing.T) {
	main := t.TempDir()
	gitForCiTest(t, main, "init", "-q", "-b", "develop")
	gitForCiTest(t, main, "commit", "-q", "--allow-empty", "-m", "init")
	worktree := filepath.Join(t.TempDir(), "wt")
	gitForCiTest(t, main, "worktree", "add", "-q", "-b", "feature/1072-b", worktree)
	sub := filepath.Join(worktree, "src", "deep")
	if err := os.MkdirAll(sub, 0755); err != nil {
		t.Fatal(err)
	}
	realMain, err := filepath.EvalSymlinks(main)
	if err != nil {
		t.Fatal(err)
	}
	noLink := func() string { return "" }
	for _, cwd := range []string{worktree, sub} {
		dir, from, err := moltenCiCheckout(cwd, noLink)
		if err != nil || dir != realMain || from != worktree {
			t.Fatalf("from %s: want project %s and checkout %s, got %s %s %v", cwd, realMain, worktree, dir, from, err)
		}
		if req := moltenCiRunRequest(dir, from, nil); req["from"] != worktree || req["branch"] != nil {
			t.Fatalf("run with no branch: %v", req)
		}
		if req := moltenCiStatusRequest(dir, from, nil); req["from"] != worktree || req["rev"] != nil {
			t.Fatalf("status with no revision: %v", req)
		}
	}
	if req := moltenCiRunRequest(realMain, worktree, []string{"develop"}); req["branch"] != "develop" || req["from"] != nil {
		t.Fatalf("a named branch is resolved in the repository: %v", req)
	}
	if req := moltenCiStatusRequest(realMain, worktree, []string{"develop"}); req["rev"] != "develop" || req["from"] != nil {
		t.Fatalf("a named revision is resolved in the repository: %v", req)
	}
	if dir, from, err := moltenCiCheckout(main, noLink); err != nil || dir != main || from != main {
		t.Fatalf("a main checkout is both: %s %s %v", dir, from, err)
	}
	if _, _, err := moltenCiCheckout(t.TempDir(), noLink); err == nil {
		t.Fatal("outside git: want an error")
	}
}

func TestFormatMoltenCiTarget(t *testing.T) {
	for _, tc := range []struct {
		run  moltenCiRun
		want string
	}{
		{moltenCiRun{Branch: "feature/1072-b"}, "feature/1072-b"},
		{moltenCiRun{Detached: true}, "detached HEAD"},
		{moltenCiRun{Detached: true, Heads: []string{"a", "b"}}, "detached HEAD (a, b)"},
	} {
		if got := formatMoltenCiTarget(tc.run); got != tc.want {
			t.Errorf("%+v: want %q, got %q", tc.run, tc.want, got)
		}
	}
}
