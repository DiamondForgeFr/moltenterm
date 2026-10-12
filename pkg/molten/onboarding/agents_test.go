// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package onboarding

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func testAgentEnv(t *testing.T) molten.AgentEnv {
	t.Helper()
	root := t.TempDir()
	return molten.AgentEnv{
		Home:    filepath.Join(root, "home"),
		DataDir: filepath.Join(root, "data"),
		Getenv:  func(string) string { return "" },
	}
}

func fakeExecutable(t *testing.T, dir string, name string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"), 0755); err != nil {
		t.Fatal(err)
	}
}

func findEntry(t *testing.T, result AgentsResult, id string) AgentEntry {
	t.Helper()
	for _, entry := range result.Agents {
		if entry.Id == id {
			return entry
		}
	}
	t.Fatalf("no entry for %s in %+v", id, result.Agents)
	return AgentEntry{}
}

func TestListAgents(t *testing.T) {
	env := testAgentEnv(t)
	bin := filepath.Join(env.Home, "bin")
	fakeExecutable(t, bin, "claude")
	codex, _ := molten.FindAgent("codex")
	if _, err := codex.Install(env, "1.0.0"); err != nil {
		t.Fatal(err)
	}
	// a guide path holding someone else's file
	gemini, _ := molten.FindAgent("gemini-cli")
	if err := os.MkdirAll(filepath.Dir(gemini.Path(env)), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(gemini.Path(env), []byte("mine"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := molten.SetAgentDeclined(env.DataDir, "qwen-code", true); err != nil {
		t.Fatal(err)
	}

	result := ListAgents(env, bin, "1.0.0")
	if len(result.Agents) != len(molten.AgentProfiles) || result.Version != "1.0.0" {
		t.Fatalf("listing %+v", result)
	}
	if last := result.Agents[len(result.Agents)-1]; last.Id != molten.GenericAgentId || last.Found || last.Executable != "" {
		t.Errorf("generic entry %+v", last)
	}
	claude := findEntry(t, result, "claude-code")
	if !claude.Found || !strings.HasSuffix(claude.FoundPath, "claude") || claude.Installed || claude.InstallPage == "" {
		t.Errorf("claude entry %+v", claude)
	}
	if claude.Invocation != "/morph <request>" {
		t.Errorf("claude invocation %q", claude.Invocation)
	}
	c := findEntry(t, result, "codex")
	if c.Found || !c.Installed || c.Version != "1.0.0" || c.Invocation != "$morph <request>" {
		t.Errorf("codex entry %+v", c)
	}
	if g := findEntry(t, result, "gemini-cli"); !g.Foreign || g.Installed {
		t.Errorf("gemini entry %+v", g)
	}
	if q := findEntry(t, result, "qwen-code"); !q.Declined {
		t.Errorf("qwen entry %+v", q)
	}
	if k := findEntry(t, result, "kimi"); k.Invocation != "/skill:morph <request>" {
		t.Errorf("kimi entry %+v", k)
	}
}

func TestInstallDeclinedAgent(t *testing.T) {
	env := testAgentEnv(t)
	if _, err := InstallDeclinedAgent(env, "codex", "1.0.0"); err == nil {
		t.Error("an agent not declined was installed")
	}
	if _, err := InstallDeclinedAgent(env, "nope", "1.0.0"); err == nil {
		t.Error("an unknown agent was accepted")
	}
	if err := molten.SetAgentDeclined(env.DataDir, "codex", true); err != nil {
		t.Fatal(err)
	}
	status, err := InstallDeclinedAgent(env, "codex", "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if !status.Installed || status.Version != "1.0.0" || status.Declined {
		t.Errorf("status after install %+v", status)
	}
	if molten.IsAgentDeclined(env.DataDir, "codex") {
		t.Error("codex is still declined")
	}
}

func TestInstallDeclinedAgentLeavesForeignFiles(t *testing.T) {
	env := testAgentEnv(t)
	claude, _ := molten.FindAgent("claude-code")
	path := claude.Path(env)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("mine"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := molten.SetAgentDeclined(env.DataDir, "claude-code", true); err != nil {
		t.Fatal(err)
	}
	status, err := InstallDeclinedAgent(env, "claude-code", "1.0.0")
	if err == nil {
		t.Error("the foreign file was not reported")
	}
	if data, _ := os.ReadFile(path); string(data) != "mine" {
		t.Errorf("the foreign file was overwritten: %q", data)
	}
	if !status.Foreign {
		t.Errorf("status %+v", status)
	}
}

func TestEnsureMorphDir(t *testing.T) {
	dataDir := t.TempDir()
	dir, err := EnsureMorphDir(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if dir != filepath.Join(dataDir, "molten", "first-morph") {
		t.Errorf("scratch folder %s", dir)
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		t.Errorf("scratch folder not created: %v", err)
	}
	if _, err := EnsureMorphDir(dataDir); err != nil {
		t.Errorf("a second call failed: %v", err)
	}
}
