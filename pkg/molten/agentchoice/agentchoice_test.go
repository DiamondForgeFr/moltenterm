// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentchoice

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
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
