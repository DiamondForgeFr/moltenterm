// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package molten

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fakeAgentBin(t *testing.T, names ...string) string {
	bin := t.TempDir()
	for _, name := range names {
		if err := os.WriteFile(filepath.Join(bin, name), []byte("#!/bin/sh\n"), 0755); err != nil {
			t.Fatal(err)
		}
	}
	return bin
}

func syncedIds(results []AgentSyncResult, t *testing.T) string {
	ids := []string{}
	for _, result := range results {
		if result.Err != nil {
			t.Fatalf("sync %s: %v", result.Id, result.Err)
		}
		ids = append(ids, result.Id)
	}
	return strings.Join(ids, ",")
}

func TestSyncInstallsForTheAgentsFound(t *testing.T) {
	env := testAgentEnv(t)
	bin := fakeAgentBin(t, "claude", "codex")
	if err := os.WriteFile(filepath.Join(bin, "gemini"), []byte("not a program"), 0644); err != nil {
		t.Fatal(err)
	}

	got := syncedIds(SyncAgentGuides(env, "1.2.0", "/nowhere:"+bin), t)
	if got != "claude-code,codex" {
		t.Fatalf("synced %q, want claude-code,codex", got)
	}
	for _, id := range []string{"claude-code", "codex"} {
		profile, _ := FindAgent(id)
		for _, guide := range profile.Status(env).Guides {
			if !guide.Installed || guide.Version != "1.2.0" {
				t.Fatalf("%s %s: %+v", id, guide.Name, guide)
			}
		}
	}
	for _, id := range []string{"gemini-cli", "generic"} {
		profile, _ := FindAgent(id)
		if profile.Status(env).Installed {
			t.Fatalf("%s installed without its program on the PATH", id)
		}
	}
	if got := syncedIds(SyncAgentGuides(env, "1.2.0", bin), t); got != "" {
		t.Fatalf("an up-to-date install was rewritten: %q", got)
	}
}

func TestSyncUpdatesOldAndRetiredGuides(t *testing.T) {
	env := testAgentEnv(t)
	bin := fakeAgentBin(t, "claude")
	profile, _ := FindAgent("claude-code")
	if _, err := profile.Install(env, "1.0.0"); err != nil {
		t.Fatal(err)
	}
	retired := profile.GuidePath(env, RetiredGuides[0])
	os.MkdirAll(filepath.Dir(retired), 0755)
	if err := os.WriteFile(retired, []byte("<!-- molten-feature v0.14.5, installed by molten agent install claude-code -->\n"), 0644); err != nil {
		t.Fatal(err)
	}

	if got := syncedIds(SyncAgentGuides(env, "1.1.0", bin), t); got != "claude-code" {
		t.Fatalf("synced %q", got)
	}
	if status := profile.Status(env); status.Version != "1.1.0" {
		t.Fatalf("morph at %s, want 1.1.0", status.Version)
	}
	if _, err := os.Stat(retired); !os.IsNotExist(err) {
		t.Fatalf("molten-feature still there: %v", err)
	}
}

func TestSyncLeavesForeignFilesAlone(t *testing.T) {
	env := testAgentEnv(t)
	bin := fakeAgentBin(t, "claude")
	profile, _ := FindAgent("claude-code")
	foreign := profile.Path(env)
	os.MkdirAll(filepath.Dir(foreign), 0755)
	if err := os.WriteFile(foreign, []byte("my own morph\n"), 0644); err != nil {
		t.Fatal(err)
	}

	results := SyncAgentGuides(env, "1.2.0", bin)
	if len(results) != 1 || results[0].Err == nil || !strings.Contains(results[0].Err.Error(), "not written by molten") {
		t.Fatalf("results %+v, want the foreign morph reported", results)
	}
	data, _ := os.ReadFile(foreign)
	if string(data) != "my own morph\n" {
		t.Fatalf("foreign file changed: %q", data)
	}
	if !profile.GuideStatus(env, AgentGuides[1]).Installed {
		t.Fatal("the other guides were not installed")
	}
	if got := syncedIds(SyncAgentGuides(env, "1.2.0", bin), t); got != "" {
		t.Fatalf("a foreign file alone triggered a new install: %q", got)
	}
}

func TestSyncSkipsDeclinedAgents(t *testing.T) {
	env := testAgentEnv(t)
	bin := fakeAgentBin(t, "claude", "codex")
	if err := SetAgentDeclined(env.DataDir, "codex", true); err != nil {
		t.Fatal(err)
	}
	if got := syncedIds(SyncAgentGuides(env, "1.2.0", bin), t); got != "claude-code" {
		t.Fatalf("synced %q, want claude-code only", got)
	}
	codex, _ := FindAgent("codex")
	if status := codex.Status(env); status.Installed || !status.Declined {
		t.Fatalf("codex status %+v", status)
	}

	if err := SetAgentDeclined(env.DataDir, "codex", false); err != nil {
		t.Fatal(err)
	}
	if got := syncedIds(SyncAgentGuides(env, "1.2.0", bin), t); got != "codex" {
		t.Fatalf("after install again, synced %q", got)
	}
}

func TestDeclinedRecordSurvivesItsOwnMistakes(t *testing.T) {
	dataDir := t.TempDir()
	for _, step := range []struct {
		id       string
		declined bool
	}{{"codex", true}, {"codex", true}, {"kimi", true}, {"codex", false}} {
		if err := SetAgentDeclined(dataDir, step.id, step.declined); err != nil {
			t.Fatal(err)
		}
	}
	data, _ := os.ReadFile(agentGuidesFile(dataDir))
	if !IsAgentDeclined(dataDir, "kimi") || IsAgentDeclined(dataDir, "codex") || strings.Count(string(data), "kimi") != 1 {
		t.Fatalf("record %s", data)
	}

	if err := os.WriteFile(agentGuidesFile(dataDir), []byte("{"), 0644); err != nil {
		t.Fatal(err)
	}
	if IsAgentDeclined(dataDir, "kimi") {
		t.Fatal("a broken record hid the guides")
	}
	if err := SetAgentDeclined(dataDir, "kimi", true); err == nil {
		t.Fatal("declining over a broken record overwrote it silently")
	}
	if err := SetAgentDeclined(dataDir, "kimi", false); err != nil {
		t.Fatalf("installing again over a broken record: %v", err)
	}
}
