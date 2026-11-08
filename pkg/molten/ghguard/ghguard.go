// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Package ghguard keeps the real gh out of the Go tests (#1857). A unit test that runs it reaches GitHub with the
// developer's own credentials, and on a loaded machine gh can block for minutes, longer than the tests' waits (#1835).
// Tests use a fake runner (mission's withoutGh) or a scripted fake gh instead; git may stay real.
//
// A package whose tests can reach gh calls Main from its TestMain. The guard puts a gh that only records the call
// first on the test process's PATH and on the login shell's PATH (mission.ExecRunner resolves programs there, not on
// PATH), and fails the run when anything called it. Runners that never exec a program (mission's plainRunner) call
// Refuse, which does not depend on any PATH. A test that installs its own fake gh puts its folder in front of the
// guard's, so the guard sees only calls that would have run the real one.
package ghguard

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

// The name of molten.LoginPathEnv, which this package cannot import: pkg/molten's own tests use the guard.
const loginPathEnv = "MOLTENTERM_LOGIN_PATH"

const shimExitCode = 97
const callsFile = "calls.log"

// Message is what a test sees when it reaches the real gh.
const Message = "the real gh must never run in a Go test (#1857): use a fake runner (withoutGh) or a scripted fake gh"

// ErrRealGh is what Refuse returns.
var ErrRealGh = errors.New("gh: " + Message)

var refusedLock sync.Mutex
var refused []string

type savedEnv struct {
	name  string
	value string
	set   bool
}

// Guard is an installed guard.
type Guard struct {
	dir   string
	log   string
	saved []savedEnv
}

// Main is a TestMain body: os.Exit(ghguard.Main(m)).
func Main(m *testing.M) int {
	return Wrap(m.Run)
}

// Wrap runs the tests with the guard installed. A run that reached the real gh fails, even when every test passed.
func Wrap(run func() int) int {
	return wrap(run, os.Stderr)
}

func wrap(run func() int, report io.Writer) int {
	guard, err := Install()
	if err != nil {
		fmt.Fprintf(report, "ghguard: %v\n", err)
		return 1
	}
	code := run()
	calls := guard.Calls()
	guard.Remove()
	if len(calls) == 0 {
		return code
	}
	fmt.Fprint(report, Report(calls))
	if code == 0 {
		return 1
	}
	return code
}

// Report is the failure message for the calls Calls returned.
func Report(calls []string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "ghguard: %d call(s) reached the real gh during the tests. %s.\n", len(calls), Message)
	for _, call := range calls {
		fmt.Fprintf(&b, "  %s\n", call)
	}
	b.WriteString("  A call line starts with the folder it ran in: a t.TempDir path carries the test's name.\n")
	return b.String()
}

// Install puts the recording gh first on PATH and on the login shell's PATH.
func Install() (*Guard, error) {
	dir, err := os.MkdirTemp("", "ghguard")
	if err != nil {
		return nil, fmt.Errorf("making the gh shim folder: %w", err)
	}
	guard := &Guard{dir: dir, log: filepath.Join(dir, callsFile)}
	if err := os.WriteFile(guard.log, nil, 0600); err != nil {
		os.RemoveAll(dir)
		return nil, fmt.Errorf("making the gh call log: %w", err)
	}
	if err := writeShim(dir, guard.log); err != nil {
		os.RemoveAll(dir)
		return nil, err
	}
	path := os.Getenv("PATH")
	login := os.Getenv(loginPathEnv)
	if login == "" {
		login = path
	}
	guard.prepend("PATH", path)
	guard.prepend(loginPathEnv, login)
	return guard, nil
}

func (g *Guard) prepend(name string, value string) {
	previous, set := os.LookupEnv(name)
	g.saved = append(g.saved, savedEnv{name: name, value: previous, set: set})
	os.Setenv(name, g.dir+string(os.PathListSeparator)+value)
}

// Dir is the folder holding the recording gh.
func (g *Guard) Dir() string {
	return g.dir
}

// Calls lists the calls that reached the real gh: the ones the recording gh took and the ones Refuse turned down.
func (g *Guard) Calls() []string {
	calls := []string{}
	data, _ := os.ReadFile(g.log)
	for _, line := range strings.Split(string(data), "\n") {
		if line != "" {
			calls = append(calls, line)
		}
	}
	return append(calls, Refused()...)
}

// Remove restores the environment and deletes the folder of the recording gh.
func (g *Guard) Remove() {
	for i := len(g.saved) - 1; i >= 0; i-- {
		saved := g.saved[i]
		if saved.set {
			os.Setenv(saved.name, saved.value)
			continue
		}
		os.Unsetenv(saved.name)
	}
	g.saved = nil
	os.RemoveAll(g.dir)
	refusedLock.Lock()
	defer refusedLock.Unlock()
	refused = nil
}

// Refuse is for a runner that would run gh without a program lookup: it records the call, in the folder dir, and
// returns ErrRealGh.
func Refuse(dir string, args []string) error {
	refusedLock.Lock()
	defer refusedLock.Unlock()
	refused = append(refused, dir+": gh "+strings.Join(args, " "))
	return ErrRealGh
}

// Refused lists what Refuse turned down since the guard was installed.
func Refused() []string {
	refusedLock.Lock()
	defer refusedLock.Unlock()
	return append([]string{}, refused...)
}

// Forget removes, and returns, the refusals that happened in dir or below: a test of a runner's refusal calls it for the
// folder it made, so the probe does not fail the run, and a refusal elsewhere still does.
func Forget(dir string) []string {
	refusedLock.Lock()
	defer refusedLock.Unlock()
	forgotten := []string{}
	kept := []string{}
	for _, entry := range refused {
		if strings.HasPrefix(entry, dir+": ") || strings.HasPrefix(entry, dir+string(os.PathSeparator)) {
			forgotten = append(forgotten, entry)
			continue
		}
		kept = append(kept, entry)
	}
	refused = kept
	return forgotten
}

// The Windows shim is found through PATHEXT; the Go tests run on Linux in CI and on the developers' Mac, so that
// branch has never run.
func writeShim(dir string, log string) error {
	if runtime.GOOS == "windows" {
		script := "@echo off\r\n" +
			"echo %CD%: gh %*>>\"" + log + "\"\r\n" +
			"echo gh: " + Message + " 1>&2\r\n" +
			fmt.Sprintf("exit /b %d\r\n", shimExitCode)
		return writeFile(filepath.Join(dir, "gh.cmd"), script, 0600)
	}
	script := "#!/bin/sh\n" +
		"printf '%s: gh %s\\n' \"$PWD\" \"$*\" >> " + shellQuote(log) + "\n" +
		"echo " + shellQuote("gh: "+Message) + " >&2\n" +
		fmt.Sprintf("exit %d\n", shimExitCode)
	return writeFile(filepath.Join(dir, "gh"), script, 0700)
}

func writeFile(path string, content string, mode os.FileMode) error {
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		return fmt.Errorf("writing the gh shim: %w", err)
	}
	return nil
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}
