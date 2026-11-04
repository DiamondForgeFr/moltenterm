// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package onboarding

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func useFakeSignInExit(t *testing.T, exit SignInExit, ok bool) {
	t.Helper()
	prev := getSignInExitFn()
	UseSignInExit(func(string) (SignInExit, bool) { return exit, ok })
	t.Cleanup(func() { UseSignInExit(prev) })
}

func writeScript(t *testing.T, path string, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body), 0755); err != nil {
		t.Fatal(err)
	}
}

// The status command's answer: exit 0 and no line saying the user is out.
func TestStatusSaysSignedIn(t *testing.T) {
	failed := errors.New("exit status 1")
	cases := []struct {
		err    error
		output string
		want   bool
	}{
		{nil, "✓ Logged in as dev@example.com\n", true},
		{nil, `{"loggedIn": true, "authMethod": "claude.ai"}`, true},
		{nil, "Logged in using ChatGPT\n", true},
		{nil, "Not logged in. Run agent login.\n", false},
		{nil, "You are not signed in\n", false},
		{nil, "Unauthenticated\n", false},
		{failed, "Logged in as dev@example.com\n", false},
		{failed, "", false},
	}
	for _, c := range cases {
		if got := statusSaysSignedIn(c.err, c.output); got != c.want {
			t.Errorf("statusSaysSignedIn(%v, %q) = %v, want %v", c.err, c.output, got, c.want)
		}
	}
}

// Every status command the catalog names is sourced and runs the agent's own CLI.
func TestSignInStatusSourced(t *testing.T) {
	for id, install := range agentInstallCatalog {
		s := install.SignIn
		if len(s.StatusArgs) > 0 && len(s.StatusSources) == 0 {
			t.Errorf("%s: a status command without its source", id)
		}
	}
	for _, id := range []string{"claude-code", "codex", molten.AgentIdCursor} {
		if len(agentInstallCatalog[id].SignIn.StatusArgs) == 0 {
			t.Errorf("%s documents a status command", id)
		}
	}
}

// Parity (#1733): whatever the agent, a sign-in whose command ends with 0 is confirmed, recorded, and the listing
// then says signed in; the agents with a status command ask their fake, never the real CLI.
func TestEveryAgentSignInDone(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake status scripts are sh")
	}
	fakes := t.TempDir()
	t.Setenv(TestSignInDirEnv, fakes)
	env := testAgentEnv(t)
	bin := filepath.Join(env.Home, "bin")
	useFakeSignInExit(t, SignInExit{Ended: true, ExitCode: 0}, true)
	for _, profile := range molten.AgentProfiles {
		if profile.Id == molten.GenericAgentId {
			continue
		}
		fakeExecutable(t, bin, profile.Executable)
		hasStatus := len(agentInstallCatalog[profile.Id].SignIn.StatusArgs) > 0
		if hasStatus {
			writeScript(t, filepath.Join(fakes, profile.Id+"-status.sh"), "echo 'Logged in as dev@example.com'\n")
		}
		if findEntry(t, ListAgents(env, bin, "1.0.0"), profile.Id).SignedIn {
			t.Fatalf("%s: signed in before its sign-in", profile.Id)
		}
		res, err := checkSignInExit(env, profile, "block-"+profile.Id, bin)
		if err != nil {
			t.Fatalf("%s: %v", profile.Id, err)
		}
		want := SignInCheckedByExit
		if hasStatus {
			want = SignInCheckedByStatus
		}
		if !res.Ended || res.ExitCode != 0 || !res.SignedIn || res.CheckedBy != want {
			t.Errorf("%s: %+v, want checked by %s", profile.Id, res, want)
		}
		if !findEntry(t, ListAgents(env, bin, "1.0.0"), profile.Id).SignedIn {
			t.Errorf("%s: not signed in after a confirmed sign-in", profile.Id)
		}
	}
}

// A failed sign-in, one still running, or one the status command denies leaves the card unsigned.
func TestSignInDoneFailures(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake status scripts are sh")
	}
	fakes := t.TempDir()
	t.Setenv(TestSignInDirEnv, fakes)
	env := testAgentEnv(t)
	cursor := mustAgent(t, molten.AgentIdCursor)

	useFakeSignInExit(t, SignInExit{Ended: true, ExitCode: 1}, true)
	if res, err := checkSignInExit(env, cursor, "b", ""); err != nil || !res.Ended || res.ExitCode != 1 || res.SignedIn {
		t.Errorf("failed sign-in: %+v %v", res, err)
	}
	useFakeSignInExit(t, SignInExit{Ended: false}, true)
	if res, err := checkSignInExit(env, cursor, "b", ""); err != nil || res.Ended || res.SignedIn {
		t.Errorf("running sign-in: %+v %v", res, err)
	}
	useFakeSignInExit(t, SignInExit{}, false)
	if res, err := checkSignInExit(env, cursor, "b", ""); err != nil || res.Ended || res.SignedIn {
		t.Errorf("no controller: %+v %v", res, err)
	}

	// signed in once, then the status command says out: the record goes
	if err := recordSignIn(env.DataDir, cursor.Id, SignInCheckedByStatus); err != nil {
		t.Fatal(err)
	}
	writeScript(t, filepath.Join(fakes, cursor.Id+"-status.sh"), "echo 'Not logged in'\n")
	useFakeSignInExit(t, SignInExit{Ended: true, ExitCode: 0}, true)
	if res, err := checkSignInExit(env, cursor, "b", ""); err != nil || !res.Ended || res.SignedIn {
		t.Errorf("denied by status: %+v %v", res, err)
	}
	if signInRecorded(env.DataDir, cursor.Id) {
		t.Error("the record stays after the status command denied the sign-in")
	}
	writeScript(t, filepath.Join(fakes, cursor.Id+"-status.sh"), "echo 'Logged in'\nexit 3\n")
	if res, _ := checkSignInExit(env, cursor, "b", ""); res.SignedIn {
		t.Errorf("status exit 3 counted as signed in: %+v", res)
	}
}

// Outside the tests the status command is the agent's own, found in the login PATH only.
func TestSignInStatusCmdRealPath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake executables are sh")
	}
	t.Setenv(TestSignInDirEnv, "")
	bin := t.TempDir()
	writeScript(t, filepath.Join(bin, "agent"), "echo \"args: $*\"\n")
	cursor := mustAgent(t, molten.AgentIdCursor)
	ran, signedIn, err := runSignInStatus(cursor, bin)
	if err != nil || !ran || !signedIn {
		t.Errorf("cursor status: ran %v signed in %v err %v", ran, signedIn, err)
	}
	cmd, err := signInStatusCmd(t.Context(), cursor, bin)
	if err != nil || cmd == nil || cmd.Path != filepath.Join(bin, "agent") || strings.Join(cmd.Args[1:], " ") != "status" {
		t.Errorf("cursor status command %+v %v", cmd, err)
	}
	if _, _, err := runSignInStatus(mustAgent(t, "claude-code"), bin); err == nil {
		t.Error("claude is not in this PATH: its status cannot run")
	}
	if cmd, err := signInStatusCmd(t.Context(), mustAgent(t, molten.AgentIdCopilot), bin); cmd != nil || err != nil {
		t.Errorf("copilot documents no status command: %+v %v", cmd, err)
	}
}
