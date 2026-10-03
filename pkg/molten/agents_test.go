// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/agentdocs"
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
	for _, name := range []string{"mod-format.md", "molten-feature.md", "agent-states.md", "examples/copy-box/mod.json", "examples/copy-box/main.js"} {
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

func TestPipelineGuideForEveryAgent(t *testing.T) {
	env := AgentEnv{Home: "/h", DataDir: "/d", Getenv: func(string) string { return "" }}
	guide, err := FindGuide(PipelineGuideName)
	if err != nil {
		t.Fatal(err)
	}
	paths := map[string]string{
		"claude-code": "/h/.claude/skills/molten-pipeline/SKILL.md",
		"codex":       "/h/.agents/skills/molten-pipeline/SKILL.md",
		"gemini-cli":  "/h/.gemini/commands/molten-pipeline.toml",
		"qwen-code":   "/h/.qwen/commands/molten-pipeline.md",
		"kimi":        "/h/.kimi-code/skills/molten-pipeline/SKILL.md",
		"generic":     "/d/molten/agents/molten-pipeline.md",
	}
	for _, p := range AgentProfiles {
		if got := filepath.ToSlash(p.GuidePath(env, guide)); got != paths[p.Id] {
			t.Errorf("%s pipeline path %q, want %q", p.Id, got, paths[p.Id])
		}
		content, err := p.RenderGuide(guide, "2.0.0")
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(content, agentRequestPlaceholder) || !strings.Contains(content, "molten project validate") {
			t.Errorf("%s: the pipeline guide must be complete and in the agent's form", p.Id)
		}
		if m := agentMarkerRegex.FindStringSubmatch(content); m == nil || m[1] != "2.0.0" || !strings.Contains(content, "molten-pipeline v2.0.0") {
			t.Errorf("%s: missing pipeline marker", p.Id)
		}
		if p.Format == "skill" && !strings.HasPrefix(content, "---\nname: molten-pipeline\n") {
			t.Errorf("%s: skill name must be the guide's", p.Id)
		}
		status := p.GuideStatus(env, guide)
		if p.Id != "generic" && !strings.Contains(status.Invocation, "molten-pipeline") {
			t.Errorf("%s invocation %q", p.Id, status.Invocation)
		}
	}
}

func TestAgentInstallsEveryGuide(t *testing.T) {
	env := testAgentEnv(t)
	claude, _ := FindAgent("claude-code")
	if _, err := claude.Install(env, "1.0.0"); err != nil {
		t.Fatal(err)
	}
	status := claude.Status(env)
	if len(status.Guides) != 2 || !status.Guides[0].Installed || !status.Guides[1].Installed || status.Guides[1].Name != PipelineGuideName {
		t.Fatalf("both guides installed: %+v", status.Guides)
	}
	// A molten-feature file must not be mistaken for the pipeline guide.
	pipeline, _ := FindGuide(PipelineGuideName)
	featureContent, _ := claude.Render("1.0.0")
	os.WriteFile(claude.GuidePath(env, pipeline), []byte(featureContent), 0644)
	if s := claude.GuideStatus(env, pipeline); !s.Foreign {
		t.Fatalf("another guide's file at the pipeline path is foreign: %+v", s)
	}
	os.Remove(claude.GuidePath(env, pipeline))
	claude.Install(env, "1.0.0")
	_, removed, err := claude.Remove(env)
	if err != nil || !removed {
		t.Fatalf("remove: %v %v", removed, err)
	}
	for _, g := range claude.Status(env).Guides {
		if g.Installed {
			t.Fatalf("%s still installed", g.Name)
		}
	}
}

func TestPipelineFormatExampleIsValid(t *testing.T) {
	doc, err := agentdocs.Files.ReadFile("pipeline-format.md")
	if err != nil {
		t.Fatal(err)
	}
	text := string(doc)
	start := strings.Index(text, "```json\n")
	end := strings.Index(text[start+8:], "```")
	if start < 0 || end < 0 {
		t.Fatal("no JSON example in pipeline-format.md")
	}
	dir := t.TempDir()
	writeProjectFile(t, dir, ".molten/project.json", text[start+8:start+8+end])
	for _, script := range []string{"scripts/build-local.sh", "scripts/release.sh", "scripts/promote.mjs", "scripts/verify.mjs", "src-tauri/Cargo.toml"} {
		writeProjectFile(t, dir, script, "")
	}
	report := ValidatePipeline(dir)
	if !report.Valid || len(report.Warnings) != 0 {
		t.Fatalf("the documented example must validate cleanly: %v %v", report.Errors, report.Warnings)
	}
}
