// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package ghguard

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func installed(t *testing.T) *Guard {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the shim is a .cmd file: run through the shell of the test machine")
	}
	t.Setenv("PATH", os.Getenv("PATH"))
	t.Setenv(loginPathEnv, "")
	os.Unsetenv(loginPathEnv)
	guard, err := Install()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(guard.Remove)
	return guard
}

// ghguard cannot import pkg/molten (its own tests use the guard), so it repeats the name of the login PATH variable.
func TestTheLoginPathVariableIsMoltensOwn(t *testing.T) {
	if loginPathEnv != molten.LoginPathEnv {
		t.Fatalf("ghguard sets %q, the login PATH reads %q", loginPathEnv, molten.LoginPathEnv)
	}
}

func TestAGhCallIsRecordedAndFails(t *testing.T) {
	guard := installed(t)
	work := t.TempDir()
	path, err := exec.LookPath("gh")
	if err != nil || filepath.Dir(path) != guard.Dir() {
		t.Fatalf("gh resolves to %q (%v), not to the guard's folder %q", path, err, guard.Dir())
	}
	cmd := exec.Command("gh", "pr", "list", "--state", "open")
	cmd.Dir = work
	out, err := cmd.CombinedOutput()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != shimExitCode {
		t.Fatalf("the shim exited with %v, want code %d", err, shimExitCode)
	}
	if !strings.Contains(string(out), Message) {
		t.Fatalf("the shim did not say why: %q", out)
	}
	calls := guard.Calls()
	if len(calls) != 1 || !strings.HasSuffix(calls[0], ": gh pr list --state open") || !strings.Contains(calls[0], filepath.Base(work)) {
		t.Fatalf("calls: %q", calls)
	}
}

func TestAFakeGhOfATestComesBeforeTheGuard(t *testing.T) {
	guard := installed(t)
	fake := t.TempDir()
	if err := os.WriteFile(filepath.Join(fake, "gh"), []byte("#!/bin/sh\necho fake\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", fake+string(os.PathListSeparator)+os.Getenv("PATH"))
	out, err := exec.Command("gh", "pr", "list").Output()
	if err != nil || strings.TrimSpace(string(out)) != "fake" {
		t.Fatalf("the test's fake gh did not run: %q %v", out, err)
	}
	if calls := guard.Calls(); len(calls) != 0 {
		t.Fatalf("a call to the test's own fake gh was reported: %q", calls)
	}
}

func TestTheLoginPathStartsWithTheGuard(t *testing.T) {
	t.Setenv("PATH", "/usr/bin:/bin")
	guard := installed(t)
	if got, want := os.Getenv(loginPathEnv), guard.Dir()+":/usr/bin:/bin"; got != want {
		t.Fatalf("login PATH = %q, want %q", got, want)
	}
	if got, want := os.Getenv("PATH"), guard.Dir()+":/usr/bin:/bin"; got != want {
		t.Fatalf("PATH = %q, want %q", got, want)
	}
	if got := molten.LookPathIn("gh", os.Getenv(loginPathEnv)); got != filepath.Join(guard.Dir(), "gh") {
		t.Fatalf("the login PATH resolves gh to %q", got)
	}
}

func TestAnExistingLoginPathKeepsItsFolders(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("see installed")
	}
	t.Setenv(loginPathEnv, "/tmp/somewhere")
	guard, err := Install()
	if err != nil {
		t.Fatal(err)
	}
	if got, want := os.Getenv(loginPathEnv), guard.Dir()+string(os.PathListSeparator)+"/tmp/somewhere"; got != want {
		t.Fatalf("login PATH = %q, want %q", got, want)
	}
	guard.Remove()
	if got := os.Getenv(loginPathEnv); got != "/tmp/somewhere" {
		t.Fatalf("login PATH after Remove = %q", got)
	}
}

func TestRemoveRestoresTheEnvironmentAndDeletesTheShim(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("see installed")
	}
	t.Setenv("PATH", os.Getenv("PATH"))
	os.Unsetenv(loginPathEnv)
	before := os.Getenv("PATH")
	guard, err := Install()
	if err != nil {
		t.Fatal(err)
	}
	dir := guard.Dir()
	guard.Remove()
	if got := os.Getenv("PATH"); got != before {
		t.Fatalf("PATH after Remove = %q, want %q", got, before)
	}
	if _, set := os.LookupEnv(loginPathEnv); set {
		t.Fatal("the login PATH variable was left set")
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("the shim folder was left behind: %v", err)
	}
}

func TestRefuseRecordsTheCallWithoutAnyPath(t *testing.T) {
	guard := installed(t)
	err := Refuse("/work/TestX001", []string{"pr", "view", "5"})
	if !errors.Is(err, ErrRealGh) {
		t.Fatalf("Refuse = %v", err)
	}
	calls := guard.Calls()
	if len(calls) != 1 || calls[0] != "/work/TestX001: gh pr view 5" {
		t.Fatalf("calls: %q", calls)
	}
}

func TestForgetRemovesOnlyTheRefusalsOfOneFolder(t *testing.T) {
	guard := installed(t)
	probe := t.TempDir()
	other := t.TempDir()
	Refuse(probe, []string{"a"})
	Refuse(filepath.Join(probe, "sub"), []string{"b"})
	Refuse(other, []string{"c"})
	forgotten := Forget(probe)
	if len(forgotten) != 2 || forgotten[0] != probe+": gh a" || forgotten[1] != filepath.Join(probe, "sub")+": gh b" {
		t.Fatalf("forgotten: %q", forgotten)
	}
	if calls := guard.Calls(); len(calls) != 1 || calls[0] != other+": gh c" {
		t.Fatalf("the refusal of another folder was swallowed: %q", calls)
	}
}

func TestAnUntouchedRunPassesThrough(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("see installed")
	}
	var out bytes.Buffer
	if code := wrap(func() int { return 0 }, &out); code != 0 || out.Len() != 0 {
		t.Fatalf("a clean run ended with %d and %q", code, out.String())
	}
	if code := wrap(func() int { return 3 }, &out); code != 3 || out.Len() != 0 {
		t.Fatalf("a failing run ended with %d and %q", code, out.String())
	}
}

func TestARunThatReachedGhFailsEvenWhenItsTestsPassed(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("see installed")
	}
	work := t.TempDir()
	var out bytes.Buffer
	reach := func() int {
		cmd := exec.Command("gh", "issue", "list")
		cmd.Dir = work
		cmd.Run()
		Refuse(work, []string{"api", "user"})
		return 0
	}
	if code := wrap(reach, &out); code != 1 {
		t.Fatalf("exit code = %d, want 1", code)
	}
	report := out.String()
	for _, want := range []string{"2 call(s) reached the real gh", ": gh issue list", ": gh api user", filepath.Base(work)} {
		if !strings.Contains(report, want) {
			t.Fatalf("the report misses %q: %s", want, report)
		}
	}
	if code := wrap(func() int { reach(); return 5 }, &out); code != 5 {
		t.Fatalf("a failing run reaching gh ended with %d, want its own 5", code)
	}
}

func TestTheGuardLeavesNothingBehindAfterARun(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("see installed")
	}
	var dir string
	var out bytes.Buffer
	wrap(func() int {
		path, err := exec.LookPath("gh")
		if err != nil {
			t.Error(err)
			return 1
		}
		dir = filepath.Dir(path)
		return 0
	}, &out)
	if dir == "" {
		t.Fatal("gh was not found during the run")
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("the shim folder survived the run: %v", err)
	}
}
