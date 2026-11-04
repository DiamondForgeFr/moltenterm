// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentlaunch"
)

// A client folder with the app's repository inside it, and a pane in it (FR-SHELL-105, FR-SHELL-036, FR-SHELL-038).
func clientProject(t *testing.T) (env map[string]string, folder string, repo string) {
	t.Helper()
	env, data := launchEnv(t)
	folder = filepath.Join(filepath.Dir(data), "client")
	repo = filepath.Join(folder, "app")
	for _, dir := range []string{filepath.Join(folder, "docs"), filepath.Join(repo, ".git")} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
	}
	return env, folder, repo
}

func realDir(t *testing.T, dir string) string {
	t.Helper()
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	return real
}

// The agent run from the client folder starts in the repository and gets the folder and the note, whichever agent.
func TestPlanMoltenAgentLaunchStartsInTheProjectRepository(t *testing.T) {
	for _, agent := range []string{"claude", "codex"} {
		env, folder, repo := clientProject(t)
		folder, repo = realDir(t, folder), realDir(t, repo)
		t.Chdir(folder)
		getenv := func(name string) string { return env[name] }
		places := agentlaunch.ProjectPlaces{Folder: folder, Repo: repo}
		report, args, procEnv, startDir := planMoltenAgentLaunchHooks(agentlaunch.FindAdapter(agent), "/real/"+agent, []string{"fix it"}, getenv, time.Now(), nil, places)
		if startDir != repo {
			t.Errorf("%s: starts in %q, want %q", agent, startDir, repo)
		}
		if !slices.Contains(args, folder) && !slices.Contains(args, "--add-dir="+folder) {
			t.Errorf("%s: the folder is an extra directory: %q", agent, args)
		}
		if args[len(args)-1] != "fix it" {
			t.Errorf("%s: the user's prompt stays last: %q", agent, args)
		}
		kinds := map[string]bool{}
		for _, it := range report.Added {
			kinds[it.Kind] = true
		}
		for _, kind := range []string{molten.IntegrationProjectFolder, molten.IntegrationProjectNote, molten.IntegrationProjectStart} {
			if !kinds[kind] {
				t.Errorf("%s: the report says nothing of %s: %+v", agent, kind, report.Added)
			}
		}
		if report.StepAside != "" || len(report.Args) == 0 {
			t.Errorf("%s: report %+v", agent, report)
		}
		if got := moltenSetEnv(procEnv, "PWD", startDir); got[len(got)-1] != "PWD="+repo {
			t.Errorf("%s: PWD follows the start folder: %q", agent, got[len(got)-1])
		}
	}
}

// Nothing of the project is added from another folder, for a project without a repository of its own, or when the
// settings turn the integration off (the run then starts where the terminal is).
func TestPlanMoltenAgentLaunchLeavesOtherTerminalsAlone(t *testing.T) {
	env, folder, repo := clientProject(t)
	folder, repo = realDir(t, folder), realDir(t, repo)
	getenv := func(name string) string { return env[name] }
	claude := agentlaunch.FindAdapter("claude")
	places := agentlaunch.ProjectPlaces{Folder: folder, Repo: repo}

	elsewhere := t.TempDir()
	t.Chdir(elsewhere)
	_, args, _, startDir := planMoltenAgentLaunchHooks(claude, "/real/claude", []string{"hi"}, getenv, time.Now(), nil, places)
	if startDir != "" || slices.ContainsFunc(args, func(a string) bool { return strings.HasPrefix(a, "--add-dir") }) {
		t.Errorf("another folder: %q %q", startDir, args)
	}

	t.Chdir(folder)
	own := agentlaunch.ProjectPlaces{Folder: folder, Repo: folder}
	_, args, _, startDir = planMoltenAgentLaunchHooks(claude, "/real/claude", []string{"hi"}, getenv, time.Now(), nil, own)
	if startDir != "" || slices.ContainsFunc(args, func(a string) bool { return strings.HasPrefix(a, "--add-dir") }) {
		t.Errorf("a folder that is its repository: %q %q", startDir, args)
	}

	report, args, _, startDir := planMoltenAgentLaunchHooks(claude, "/real/claude", []string{"hi"}, getenv, time.Now(), func() string { return agentlaunch.StepAsideSettingsOff }, places)
	if startDir != "" || report.StepAside == "" || !slices.Equal(args, []string{"hi"}) || len(report.Added) != 0 {
		t.Errorf("integration off: %q %+v %q", startDir, report, args)
	}
}

func TestMoltenProjectPlacesOfMeta(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "client")
	repo := filepath.Join(folder, "app")
	got := moltenProjectPlacesOf(map[string]any{molten.ProjectMetaKey: folder, molten.ProjectRepoMetaKey: repo})
	if got.Folder != folder || got.Repo != repo {
		t.Errorf("places %+v", got)
	}
	got = moltenProjectPlacesOf(map[string]any{molten.ProjectMetaKey: folder})
	if got.Folder != folder || got.Repo != folder {
		t.Errorf("a project without repository: the folder is its repository: %+v", got)
	}
	if got := moltenProjectPlacesOf(map[string]any{}); got != (agentlaunch.ProjectPlaces{}) {
		t.Errorf("unlinked: %+v", got)
	}
}

func TestMoltenLaunchPlacesWaitIsBounded(t *testing.T) {
	ready := make(chan agentlaunch.ProjectPlaces, 1)
	ready <- agentlaunch.ProjectPlaces{Folder: "/a", Repo: "/a/b"}
	if got := moltenLaunchPlaces(ready, time.Now().Add(time.Minute)); got.Repo != "/a/b" {
		t.Errorf("places %+v", got)
	}
	// Nothing ever answers on this channel: a wait that ignored the deadline shows as a hang.
	if got := moltenLaunchPlaces(make(chan agentlaunch.ProjectPlaces), time.Now().Add(20*time.Millisecond)); got != (agentlaunch.ProjectPlaces{}) {
		t.Errorf("no answer: %+v", got)
	}
}
