// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testAgentEnv(t *testing.T) AgentEnv {
	return AgentEnv{Home: t.TempDir(), DataDir: t.TempDir(), Getenv: func(string) string { return "" }}
}

func TestAgentProfilesFollowTheCatalog(t *testing.T) {
	want := "claude-code,codex,gemini-cli,qwen-code,kimi,generic"
	ids := []string{}
	for _, p := range AgentProfiles {
		ids = append(ids, p.Id)
	}
	if strings.Join(ids, ",") != want {
		t.Fatalf("agents %v, want the SaaSFoundryAI catalog %s", ids, want)
	}
	if _, err := FindAgent("nope"); err == nil || !strings.Contains(err.Error(), "supported: claude-code") {
		t.Fatalf("unknown agent error: %v", err)
	}
}

func TestAgentPaths(t *testing.T) {
	env := AgentEnv{Home: "/h", DataDir: "/d", Getenv: func(name string) string {
		return map[string]string{"KIMI_CODE_HOME": "/k"}[name]
	}}
	cases := map[string]string{
		"claude-code": "/h/.claude/skills/molten-feature/SKILL.md",
		"codex":       "/h/.agents/skills/molten-feature/SKILL.md",
		"gemini-cli":  "/h/.gemini/commands/molten-feature.toml",
		"qwen-code":   "/h/.qwen/commands/molten-feature.md",
		"kimi":        "/k/skills/molten-feature/SKILL.md",
		"generic":     "/d/molten/agents/molten-feature.md",
	}
	for id, want := range cases {
		p, _ := FindAgent(id)
		if got := filepath.ToSlash(p.Path(env)); got != want {
			t.Errorf("%s path %q, want %q", id, got, want)
		}
	}
}

func TestAgentRenderings(t *testing.T) {
	argForms := map[string]string{
		"claude-code": "$ARGUMENTS",
		"codex":       "after `$molten-feature`",
		"gemini-cli":  "{{args}}",
		"qwen-code":   "{{args}}",
		"kimi":        "$ARGUMENTS",
		"generic":     "pointed you to this file",
	}
	for _, p := range AgentProfiles {
		content, err := p.Render("1.2.3")
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(content, agentRequestPlaceholder) || !strings.Contains(content, argForms[p.Id]) {
			t.Errorf("%s: the request must be in the agent's own form", p.Id)
		}
		if m := agentMarkerRegex.FindStringSubmatch(content); m == nil || m[1] != "1.2.3" {
			t.Errorf("%s: missing version marker", p.Id)
		}
		if !strings.Contains(content, "molten docs") || !strings.Contains(content, "molten copy") {
			t.Errorf("%s: the guide must be complete", p.Id)
		}
		switch p.Format {
		case "skill":
			if !strings.HasPrefix(content, "---\nname: molten-feature\ndescription: ") {
				t.Errorf("%s: skill frontmatter:\n%s", p.Id, content[:120])
			}
		case "custom command":
			if p.Id == "gemini-cli" {
				// No TOML parser in the module: check the shape the renderer promises.
				start := strings.Index(content, "prompt = \"\"\"\n")
				if !strings.Contains(content, "\ndescription = \"") || start < 0 || !strings.HasSuffix(content, "\"\"\"\n") {
					t.Fatalf("gemini command shape:\n%s", content)
				}
				prompt := content[start+len("prompt = \"\"\"\n") : len(content)-len("\"\"\"\n")]
				if strings.Contains(prompt, "\"\"\"") || !strings.Contains(prompt, "{{args}}") {
					t.Error("gemini prompt must hold {{args}} and no closing triple quote")
				}
			}
		}
	}
	claude, _ := FindAgent("claude-code")
	content, _ := claude.Render("1")
	if !strings.Contains(content, "disable-model-invocation: true") || !strings.Contains(content, "argument-hint:") {
		t.Error("the Claude Code skill is user-invoked only, with an argument hint")
	}
}

func TestAgentInstallStatusRemove(t *testing.T) {
	env := testAgentEnv(t)
	for _, p := range AgentProfiles {
		if status := p.Status(env); status.Installed || status.Foreign {
			t.Fatalf("%s: nothing installed yet: %+v", p.Id, status)
		}
		path, err := p.Install(env, "0.14.5")
		if err != nil {
			t.Fatalf("%s install: %v", p.Id, err)
		}
		if status := p.Status(env); !status.Installed || status.Version != "0.14.5" || status.Path != path {
			t.Fatalf("%s status after install: %+v", p.Id, status)
		}
		if _, err := p.Install(env, "0.15.0"); err != nil {
			t.Fatalf("%s reinstall over its own file: %v", p.Id, err)
		}
		if p.Status(env).Version != "0.15.0" {
			t.Fatalf("%s: reinstall must update the version", p.Id)
		}
		_, removed, err := p.Remove(env)
		if err != nil || !removed {
			t.Fatalf("%s remove: %v %v", p.Id, removed, err)
		}
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("%s: file still there", p.Id)
		}
		if p.Format == "skill" {
			if _, err := os.Stat(filepath.Dir(path)); !os.IsNotExist(err) {
				t.Fatalf("%s: the empty skill folder must go too", p.Id)
			}
		}
	}
	generic, _ := FindAgent("generic")
	if status := generic.Status(env); !strings.Contains(status.Invocation, status.Path) {
		t.Fatalf("the generic invocation names the file: %+v", status)
	}
}

func TestAgentLeavesForeignFilesAlone(t *testing.T) {
	env := testAgentEnv(t)
	p, _ := FindAgent("claude-code")
	path := p.Path(env)
	os.MkdirAll(filepath.Dir(path), 0755)
	os.WriteFile(path, []byte("my own skill"), 0644)
	if status := p.Status(env); !status.Foreign || status.Installed {
		t.Fatalf("a foreign file is reported: %+v", status)
	}
	if _, err := p.Install(env, "1"); err == nil {
		t.Fatal("install must not overwrite a foreign file")
	}
	if _, _, err := p.Remove(env); err == nil {
		t.Fatal("remove must not delete a foreign file")
	}
	if data, _ := os.ReadFile(path); string(data) != "my own skill" {
		t.Fatal("the foreign file changed")
	}
}

func TestWriteDocsAndExampleMatchesBuiltin(t *testing.T) {
	dir := t.TempDir()
	if err := WriteDocs(dir); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"mod-format.md", "molten-feature.md", "examples/copy-box/mod.json", "examples/copy-box/main.js"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Errorf("missing %s: %v", name, err)
		}
	}
	guide, _ := os.ReadFile(filepath.Join(dir, "molten-feature.md"))
	if bytes.Contains(guide, []byte(agentRequestPlaceholder)) {
		t.Error("the written guide must not keep the placeholder")
	}
	for _, name := range []string{"mod.json", "main.js"} {
		embedded, _ := os.ReadFile(filepath.Join(dir, "examples", "copy-box", name))
		builtin, err := os.ReadFile(filepath.Join("..", "..", "frontend", "molten", "builtin", "copy-box", name))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(embedded, builtin) {
			t.Errorf("pkg/molten/agentdocs/examples/copy-box/%s differs from frontend/molten/builtin/copy-box/%s: copy it again", name, name)
		}
	}
}
