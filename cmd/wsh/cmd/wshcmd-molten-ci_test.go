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
