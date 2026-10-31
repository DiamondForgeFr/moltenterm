// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package onboarding

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

const cliTestDeadline = time.Minute

// fakeInstallers points the catalog at a folder of fake installers and keeps the login shell off the user's rc files.
func fakeInstallers(t *testing.T, scripts map[string]string) string {
	t.Helper()
	root := t.TempDir()
	home := filepath.Join(root, "home")
	dir := filepath.Join(root, "installers")
	for _, d := range []string{home, dir} {
		if err := os.MkdirAll(d, 0755); err != nil {
			t.Fatal(err)
		}
	}
	for id, body := range scripts {
		if err := os.WriteFile(filepath.Join(dir, id+".sh"), []byte(body), 0644); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("HOME", home)
	t.Setenv("ZDOTDIR", home)
	t.Setenv(TestInstallDirEnv, dir)
	t.Setenv(molten.LoginPathEnv, "/usr/bin:/bin")
	quiet := cliInstallQuietWait
	cliInstallQuietWait = 100 * time.Millisecond
	t.Cleanup(func() { cliInstallQuietWait = quiet })
	return root
}

// waitCliJobDone is registered after the temp folders: cleanups run in reverse, so the installer is gone before they
// are removed.
func waitCliJobDone(t *testing.T, id string) {
	t.Cleanup(func() {
		job := getCliJob(id)
		if job == nil {
			return
		}
		if pid := job.markCanceled(); pid != 0 {
			killProcessGroup(pid)
		}
		<-job.done
	})
}

func waitCliStatus(t *testing.T, id string, what string, ok func(CliInstallStatus) bool) CliInstallStatus {
	t.Helper()
	deadline := time.Now().Add(cliTestDeadline)
	for {
		status := CliInstallStatusOf(id)
		if ok(status) {
			return status
		}
		if time.Now().After(deadline) {
			t.Fatalf("install of %s: no %s within %s; last status %+v", id, what, cliTestDeadline, status)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func ended(s CliInstallStatus) bool { return s.State != "" && s.State != CliInstallRunning }

func TestCliInstallSucceedsAndWritesTheAgent(t *testing.T) {
	root := filepath.Join(t.TempDir(), "kimi-home")
	bin := filepath.Join(root, ".kimi-code", "bin")
	rc := filepath.Join(root, ".zshrc")
	fakeInstallers(t, map[string]string{
		"kimi": "set -e\nmkdir -p '" + bin + "'\nprintf '#!/bin/sh\\necho kimi\\n' > '" + bin + "/kimi'\nchmod +x '" + bin +
			"/kimi'\necho 'export PATH=\"" + bin + ":$PATH\"' >> '" + rc + "'\necho 'Kimi Code installed'\n",
	})
	waitCliJobDone(t, "kimi")
	status, err := StartCliInstall("kimi")
	if err != nil {
		t.Fatal(err)
	}
	if status.State != CliInstallRunning || !strings.Contains(status.Command, "kimi.sh") {
		t.Fatalf("start = %+v", status)
	}
	status = waitCliStatus(t, "kimi", "end", ended)
	if status.State != CliInstallSucceeded || !strings.Contains(status.Output, "Kimi Code installed") {
		t.Fatalf("status = %+v", status)
	}
	if molten.LookPathIn("kimi", bin) == "" {
		t.Fatalf("the fake installer wrote no kimi in %s", bin)
	}
}

func TestCliInstallFailureKeepsTheOutputAndExitCode(t *testing.T) {
	fakeInstallers(t, map[string]string{"gemini-cli": "echo 'npm: command not found' >&2\nexit 3\n"})
	waitCliJobDone(t, "gemini-cli")
	if _, err := StartCliInstall("gemini-cli"); err != nil {
		t.Fatal(err)
	}
	status := waitCliStatus(t, "gemini-cli", "end", ended)
	if status.State != CliInstallFailed || status.ExitCode != 3 || !strings.Contains(status.Output, "npm: command not found") {
		t.Fatalf("status = %+v", status)
	}
}

func TestCliInstallAnswersAPrompt(t *testing.T) {
	fakeInstallers(t, map[string]string{
		"qwen-code": "printf 'Continue? [y/N] '\nread answer\necho \"answer: $answer\"\n[ \"$answer\" = y ]\n",
	})
	waitCliJobDone(t, "qwen-code")
	if _, err := StartCliInstall("qwen-code"); err != nil {
		t.Fatal(err)
	}
	waitCliStatus(t, "qwen-code", "question", func(s CliInstallStatus) bool {
		return s.Waiting && strings.Contains(s.Output, "Continue? [y/N]")
	})
	if _, err := SendCliInstallInput("qwen-code", "y"); err != nil {
		t.Fatal(err)
	}
	status := waitCliStatus(t, "qwen-code", "end", ended)
	if status.State != CliInstallSucceeded || !strings.Contains(status.Output, "answer: y") {
		t.Fatalf("status = %+v", status)
	}
	if _, err := SendCliInstallInput("qwen-code", "again"); err == nil {
		t.Fatal("an answer to an ended install was accepted")
	}
}

func processGone(pid int) bool {
	return errors.Is(syscall.Kill(pid, 0), syscall.ESRCH)
}

func TestCliInstallCancelKillsTheInstallerAndItsChildren(t *testing.T) {
	root := fakeInstallers(t, nil)
	pidFile := filepath.Join(root, "child.pid")
	dir := os.Getenv(TestInstallDirEnv)
	// The child ignores the hangup of the closing terminal: only the group's kill stops it.
	script := "trap '' HUP\nsleep 600 &\necho $! > '" + pidFile + "'\necho started\nwait\n"
	if err := os.WriteFile(filepath.Join(dir, "codex.sh"), []byte(script), 0644); err != nil {
		t.Fatal(err)
	}
	waitCliJobDone(t, "codex")
	if _, err := StartCliInstall("codex"); err != nil {
		t.Fatal(err)
	}
	waitCliStatus(t, "codex", "start", func(s CliInstallStatus) bool { return strings.Contains(s.Output, "started") })
	raw, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	child, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), cliTestDeadline)
	defer cancel()
	status, err := CancelCliInstall(ctx, "codex")
	if err != nil {
		t.Fatal(err)
	}
	if status.State != CliInstallCanceled {
		t.Fatalf("status = %+v", status)
	}
	deadline := time.Now().Add(cliTestDeadline)
	for !processGone(child) {
		if time.Now().After(deadline) {
			t.Fatalf("the installer's child %d still runs after Cancel", child)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestCliInstallRunsOnceAtATime(t *testing.T) {
	fakeInstallers(t, map[string]string{"claude-code": "read line\n"})
	waitCliJobDone(t, "claude-code")
	first, err := StartCliInstall("claude-code")
	if err != nil {
		t.Fatal(err)
	}
	firstJob := getCliJob("claude-code")
	second, err := StartCliInstall("claude-code")
	if err != nil {
		t.Fatal(err)
	}
	if getCliJob("claude-code") != firstJob || second.State != CliInstallRunning || first.Command != second.Command {
		t.Fatalf("a second Install started another installer: %+v", second)
	}
}

func TestCliInstallRunsOnlyCatalogCommands(t *testing.T) {
	fakeInstallers(t, map[string]string{})
	if _, err := StartCliInstall("rm -rf /"); err == nil {
		t.Fatal("an unknown agent id was accepted")
	}
	if _, err := StartCliInstall("kimi"); err == nil {
		t.Fatal("an agent without an installer ran something")
	}
	if _, err := StartCliInstall(molten.GenericAgentId); err == nil {
		t.Fatal("the generic profile has no install command")
	}
}

func TestInstallCatalogCoversTheAgents(t *testing.T) {
	t.Setenv(TestInstallDirEnv, "")
	for _, profile := range molten.AgentProfiles {
		if profile.Executable == "" {
			continue
		}
		entry, ok := agentInstallCatalog[profile.Id]
		if !ok || !strings.HasPrefix(entry.Page, "https://") || len(entry.Commands) == 0 {
			t.Fatalf("%s: catalog entry %+v", profile.Id, entry)
		}
		if got := installCommands(profile.Id); got[0] != entry.Commands[0] {
			t.Fatalf("%s: installCommands = %v", profile.Id, got)
		}
	}
	if strings.Contains(agentInstallCatalog["kimi"].Page, "kimi-cli") {
		t.Fatal("the Kimi page is the archived kimi-cli repository")
	}
}
