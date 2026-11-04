// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeAgentDefinition(t *testing.T, dir string, agentType string, text string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, agentType+".md"), []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestClaudeAgentDefinitionFrontmatter(t *testing.T) {
	folder := t.TempDir()
	config := t.TempDir()
	a := MakeClaudeAdapter([]string{filepath.Join(config, "projects")})
	project := filepath.Join(folder, ".claude", "agents")
	user := filepath.Join(config, "agents")

	writeAgentDefinition(t, project, "sf-build", "---\nname: sf-build\ndescription: \"a: colon\"\nmodel: claude-sonnet-5-5\neffort: 'xhigh'\n---\nbody\nmodel: never-read\n")
	if model, effort := a.claudeAgentDefinition("sf-build", folder); model != "claude-sonnet-5-5" || effort != "xhigh" {
		t.Errorf("project definition: %q %q", model, effort)
	}

	writeAgentDefinition(t, user, "reviewer", "---\nmodel: inherit\neffort: low\n---\n")
	if model, effort := a.claudeAgentDefinition("reviewer", folder); model != "" || effort != "low" {
		t.Errorf("inherit names no model, the effort stays: %q %q", model, effort)
	}

	writeAgentDefinition(t, user, "sf-build", "---\nmodel: haiku\neffort: low\n---\n")
	if model, effort := a.claudeAgentDefinition("sf-build", folder); model != "claude-sonnet-5-5" || effort != "xhigh" {
		t.Errorf("the project's definition wins over the user's: %q %q", model, effort)
	}
	if model, effort := a.claudeAgentDefinition("sf-build", ""); model != "haiku" || effort != "low" {
		t.Errorf("without a folder the user's stands: %q %q", model, effort)
	}

	writeAgentDefinition(t, project, "plain", "no frontmatter\nmodel: opus\n")
	writeAgentDefinition(t, project, "open", "---\nmodel: opus\n")
	writeAgentDefinition(t, project, "ctl", "---\nmodel: op\x01us\neffort: "+strings.Repeat("x", 200)+"\n---\n")
	for _, agentType := range []string{"plain", "open", "ctl", "missing", "../escape", "", "a b"} {
		if model, effort := a.claudeAgentDefinition(agentType, folder); model != "" || effort != "" {
			t.Errorf("%q gives nothing: %q %q", agentType, model, effort)
		}
	}
}

func TestClaudeAgentDefinitionIgnoresSymlink(t *testing.T) {
	folder := t.TempDir()
	a := MakeClaudeAdapter([]string{filepath.Join(t.TempDir(), "projects")})
	elsewhere := t.TempDir()
	writeAgentDefinition(t, elsewhere, "linked", "---\nmodel: opus\neffort: high\n---\n")
	agents := filepath.Join(folder, ".claude", "agents")
	if err := os.MkdirAll(agents, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(elsewhere, "linked.md"), filepath.Join(agents, "linked.md")); err != nil {
		t.Skipf("no symlinks here: %v", err)
	}
	if model, effort := a.claudeAgentDefinition("linked", folder); model != "" || effort != "" {
		t.Errorf("a linked definition is not read: %q %q", model, effort)
	}
}

// #1848: a sub-agent whose transcript says nothing yet shows the model and effort its definition gives; what the
// transcript says wins, fact by fact.
func TestClaudeListSubagentsFillsFromDefinition(t *testing.T) {
	f := makeClaudeIdentityFixture(t)
	a := MakeClaudeAdapter([]string{f.root})
	writeAgentDefinition(t, filepath.Join(f.running, ".claude", "agents"), "general-purpose", "---\nmodel: claude-haiku-4-5\neffort: medium\n---\n")
	writeLines(t, filepath.Join(f.subs, "agent-c78f.meta.json"),
		fmt.Sprintf(`{"agentType":"general-purpose","worktreePath":%q,"description":"fresh"}`, f.running))

	ids := identitiesById(a.ListSubagents(f.session))
	run := ids["a34d"]
	if run.Model != "claude-opus-5-5" || run.Effort != "medium" {
		t.Errorf("the transcript's model stays, the definition fills the effort: %q %q", run.Model, run.Effort)
	}
	fresh := ids["c78f"]
	if fresh.Model != "claude-haiku-4-5" || fresh.Effort != "medium" {
		t.Errorf("a sub-agent without a transcript yet takes its definition's: %q %q", fresh.Model, fresh.Effort)
	}
	done := ids["b56e"]
	if done.Effort != "" {
		t.Errorf("no definition, no effort: %q", done.Effort)
	}

	facts, ok := a.ReadSubagent(f.session, "a34d")
	if !ok || facts.Model != "claude-opus-5-5" || facts.Effort != "medium" {
		t.Errorf("ReadSubagent: %+v %v", facts, ok)
	}
}
