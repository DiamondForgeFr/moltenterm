// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentchoice

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func resolver(installed map[string]bool, global string, projects map[string]string) Resolver {
	return Resolver{
		Order:     []string{"claude", "codex"},
		Installed: func(id string) bool { return installed[id] },
		Global:    func() string { return global },
		Project:   func(dir string) string { return projects[dir] },
	}
}

// #845 AC1: the run's pick, then the project's choice, then the global default, then the order's first installed.
func TestResolveOrder(t *testing.T) {
	both := map[string]bool{"claude": true, "codex": true}
	cases := []struct {
		name     string
		r        Resolver
		run      string
		agent    string
		source   string
		explicit bool
	}{
		{"order", resolver(both, "", nil), "", "claude", SourceOrder, false},
		{"order skips what is not installed", resolver(map[string]bool{"codex": true}, "", nil), "", "codex", SourceOrder, false},
		{"global", resolver(both, "codex", nil), "", "codex", SourceGlobal, true},
		{"project over global", resolver(both, "codex", map[string]string{"/p": "claude"}), "", "claude", SourceProject, true},
		{"run over project", resolver(both, "claude", map[string]string{"/p": "claude"}), "codex", "codex", SourceRun, true},
		{"an unknown choice is no choice", resolver(both, "gemini", map[string]string{"/p": "nope"}), "", "claude", SourceOrder, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := c.r.Resolve("/p", c.run)
			if got.Agent != c.agent || got.Source != c.source || got.Explicit() != c.explicit || got.Missing {
				t.Fatalf("got %+v", got)
			}
		})
	}
}

// #845 AC1: a chosen agent that is not installed is reported, never replaced by the installed one.
func TestResolveReportsAMissingChoice(t *testing.T) {
	got := resolver(map[string]bool{"claude": true}, "", map[string]string{"/p": "codex"}).Resolve("/p", "")
	if got.Agent != "" || !got.Missing || got.Chosen != "codex" || got.ChosenName != "Codex" || got.Order != "claude" {
		t.Fatalf("got %+v", got)
	}
	want := []Agent{{Id: "claude", Name: "Claude Code", Installed: true}, {Id: "codex", Name: "Codex"}}
	if !reflect.DeepEqual(got.Agents, want) {
		t.Errorf("agents %+v", got.Agents)
	}
	if text := got.MissingText(); text != "Codex, the coding agent chosen for this project, is not installed on this computer: choose Claude Code in the panel's options (Agent), or install Codex" {
		t.Errorf("text: %s", text)
	}
	if env := got.RunEnv(); !reflect.DeepEqual(env, []string{MissingEnvVar + "=codex"}) {
		t.Errorf("env %v", env)
	}
	none := resolver(map[string]bool{}, "", nil).Resolve("/p", "")
	if none.Agent != "" || none.Missing || none.RunEnv() != nil {
		t.Errorf("nothing installed: %+v", none)
	}
}

func TestPrintArgv(t *testing.T) {
	if got := PrintArgv("claude"); !reflect.DeepEqual(got, []string{"claude", "-p"}) {
		t.Errorf("claude: %v", got)
	}
	if got := PrintArgv("codex"); !reflect.DeepEqual(got, []string{"codex", "exec", "-"}) {
		t.Errorf("codex: %v", got)
	}
	if PrintArgv("gemini") != nil {
		t.Errorf("an agent without a review flow has no form")
	}
}

// A linked worktree follows its project's choice: the key falls back to the main checkout.
func TestProjectChoiceFollowsTheMainCheckout(t *testing.T) {
	root := t.TempDir()
	main := filepath.Join(root, "app")
	tree := filepath.Join(root, "app-9")
	if err := os.MkdirAll(filepath.Join(main, ".git", "worktrees", "app-9"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(tree, "sub"), 0755); err != nil {
		t.Fatal(err)
	}
	gitdir := "gitdir: " + filepath.Join(main, ".git", "worktrees", "app-9") + "\n"
	if err := os.WriteFile(filepath.Join(tree, ".git"), []byte(gitdir), 0644); err != nil {
		t.Fatal(err)
	}
	projects := map[string]any{main: "codex"}
	if got := ProjectChoiceIn(projects, filepath.Join(tree, "sub")); got != "codex" {
		t.Errorf("worktree: %q", got)
	}
	if got := ProjectChoiceIn(projects, main); got != "codex" {
		t.Errorf("main: %q", got)
	}
	if got := ProjectChoiceIn(map[string]any{main: "gemini"}, main); got != "" {
		t.Errorf("unsupported: %q", got)
	}
}

// #1460: the companion offers the agents found on this computer, whatever their provider; a fresh Resolve lists them
// all, the ones the flows cannot run included, with the program that starts each.
func TestResolveListsEveryKnownAgent(t *testing.T) {
	r := resolver(map[string]bool{"gemini": true}, "", nil)
	r.Roster = []KnownAgent{
		{Id: "claude", Name: "Claude Code", Executable: "claude"},
		{Id: "gemini", Name: "Gemini CLI", Executable: "gemini"},
	}
	got := r.Resolve("/p", "")
	want := []Agent{
		{Id: "claude", Name: "Claude Code", Command: "claude"},
		{Id: "gemini", Name: "Gemini CLI", Installed: true, Command: "gemini"},
	}
	if !reflect.DeepEqual(got.Known, want) {
		t.Errorf("known %+v", got.Known)
	}
	if got.Agent != "" {
		t.Errorf("an agent the flows cannot run is never the flows' agent: %+v", got)
	}
	if none := (Resolver{}).Resolve("", ""); none.Known == nil || len(none.Known) != 0 {
		t.Errorf("no roster is an empty list, not null: %+v", none.Known)
	}
}

func TestRosterFollowsTheRegistry(t *testing.T) {
	ids := map[string]string{}
	for _, k := range Roster() {
		ids[k.Id] = k.Executable
	}
	for _, id := range Supported {
		if ids[id] == "" {
			t.Errorf("%s is supported but not in the roster: %v", id, ids)
		}
	}
	if ids["gemini"] != "gemini" {
		t.Errorf("a planned agent is in the roster: %v", ids)
	}
}

// #1460: detection is a cached PATH lookup, so a panel that asks again and again does not stat the PATH each time, and
// an agent installed since shows once the cache expires.
func TestPathCacheLooksUpOnceUntilItExpires(t *testing.T) {
	now := time.Now()
	lookups := 0
	installed := false
	c := &pathCache{
		now:    func() time.Time { return now },
		lookup: func(exe string) bool { lookups++; return installed },
	}
	if c.has("myagent") || c.has("myagent") || lookups != 1 {
		t.Fatalf("lookups %d", lookups)
	}
	installed = true
	if c.has("myagent") {
		t.Errorf("the answer is cached")
	}
	now = now.Add(PathCacheTtl + time.Second)
	if !c.has("myagent") || lookups != 2 {
		t.Errorf("expired: lookups %d", lookups)
	}
}
