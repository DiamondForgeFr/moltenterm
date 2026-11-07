// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package paralleltest

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const sampleTests = `package sample

import "testing"

func TestParallel(t *testing.T) {
	t.Parallel()
}

func TestSerialWithAReason(t *testing.T) {
	serialTest(t, "replaces a package-level variable")
}

func TestSerialByEnvironment(t *testing.T) {
	t.Setenv("A", "b")
}

func TestSerialWithoutAReason(t *testing.T) {
	serialTest(t, "")
}

func TestSerialWithoutAnArgument(t *testing.T) {
	serialTest(t)
}

func TestNothing(t *testing.T) {
	t.Log("neither")
}

func TestRunsAsAProgram(t *testing.T) {
}

func TestOfAnotherFile(t *testing.T) {
}

func TestMain(m *testing.M) {
}

func helper(t *testing.T) {
	t.Parallel()
}
`

func writeSample(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, text := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(text), 0644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestOnlyATestWithNeitherAChoiceNorAReasonIsRefused(t *testing.T) {
	t.Parallel()
	dir := writeSample(t, map[string]string{"sample_test.go": sampleTests})
	missing, err := testsWithoutAChoice(dir, nil, []string{"TestRunsAsAProgram"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"sample_test.go: TestSerialWithoutAReason (serialTest needs a reason)",
		"sample_test.go: TestSerialWithoutAnArgument (serialTest needs a reason)",
		"sample_test.go: TestNothing",
		"sample_test.go: TestOfAnotherFile",
	}
	if strings.Join(missing, "\n") != strings.Join(want, "\n") {
		t.Fatalf("refused:\n%s\nwant:\n%s", strings.Join(missing, "\n"), strings.Join(want, "\n"))
	}
}

func TestASkippedFileIsNotChecked(t *testing.T) {
	t.Parallel()
	dir := writeSample(t, map[string]string{
		"upstream_test.go": "package sample\n\nimport \"testing\"\n\nfunc TestUpstream(t *testing.T) {}\n",
		"ours_test.go":     "package sample\n\nimport \"testing\"\n\nfunc TestOurs(t *testing.T) { t.Parallel() }\n",
	})
	missing, err := testsWithoutAChoice(dir, []string{"upstream_test.go"}, nil)
	if err != nil || len(missing) != 0 {
		t.Fatalf("missing %v (%v), want none", missing, err)
	}
	missing, err = testsWithoutAChoice(dir, nil, nil)
	if err != nil || len(missing) != 1 || !strings.Contains(missing[0], "TestUpstream") {
		t.Fatalf("missing %v (%v), want TestUpstream", missing, err)
	}
}

func TestAFolderWithoutTestsIsAnError(t *testing.T) {
	t.Parallel()
	if _, err := testsWithoutAChoice(t.TempDir(), nil, nil); err == nil {
		t.Fatal("a folder without test files was accepted")
	}
}

// RunWithGit sets the environment once for the process, so this test runs the real thing in a program of its own: the
// environment it sets must not leak into the other tests of this package.
func TestRunWithGitSetsTheGitEnvironmentOnce(t *testing.T) {
	if os.Getenv("PARALLELTEST_HELPER") == "1" {
		return
	}
	t.Parallel()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	cmd := exec.Command(os.Args[0], "-test.run", "^TestRunWithGitHelper$", "-test.v")
	cmd.Env = append(os.Environ(), "PARALLELTEST_HELPER=1")
	out, err := cmd.CombinedOutput()
	if err != nil || !strings.Contains(string(out), "PASS: TestRunWithGitHelper") {
		t.Fatalf("the helper failed: %v\n%s", err, out)
	}
}

func TestRunWithGitHelper(t *testing.T) {
	if os.Getenv("PARALLELTEST_HELPER") != "1" {
		t.Skip("runs as a program of TestRunWithGitSetsTheGitEnvironmentOnce")
	}
	code := RunWithGit("Some test", "some@example.invalid", func() int {
		for name, want := range map[string]string{
			"GIT_CONFIG_NOSYSTEM": "1",
			"GIT_AUTHOR_NAME":     "Some test",
			"GIT_AUTHOR_EMAIL":    "some@example.invalid",
			"GIT_COMMITTER_NAME":  "Some test",
			"GIT_COMMITTER_EMAIL": "some@example.invalid",
		} {
			if got := os.Getenv(name); got != want {
				t.Errorf("%s = %q, want %q", name, got, want)
			}
		}
		config := os.Getenv("GIT_CONFIG_GLOBAL")
		data, err := os.ReadFile(config)
		if err != nil || string(data) != NoGitMaintenanceConfig {
			t.Errorf("the global config %q holds %q (%v)", config, data, err)
		}
		dir := t.TempDir()
		for _, args := range [][]string{{"init", "--quiet", "-b", "develop"}, {"commit", "--quiet", "--allow-empty", "-m", "first"}} {
			cmd := exec.Command("git", args...)
			cmd.Dir = dir
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Errorf("git %v: %v\n%s", args, err, out)
			}
		}
		cmd := exec.Command("git", "log", "-1", "--format=%an <%ae> %cn <%ce>")
		cmd.Dir = dir
		out, err := cmd.Output()
		if want := "Some test <some@example.invalid> Some test <some@example.invalid>"; err != nil || strings.TrimSpace(string(out)) != want {
			t.Errorf("the commit says %q (%v), want %q", out, err, want)
		}
		return 0
	})
	if code != 0 {
		t.Fatalf("RunWithGit returned %d", code)
	}
	if _, err := os.Stat(os.Getenv("GIT_CONFIG_GLOBAL")); !os.IsNotExist(err) {
		t.Errorf("the global config outlived the run: %v", err)
	}
}
