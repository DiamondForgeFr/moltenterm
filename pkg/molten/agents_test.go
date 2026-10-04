// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"bytes"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/agentdocs"
	"github.com/wavetermdev/waveterm/pkg/molten/agentparts"
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
		"claude-code": "/h/.claude/skills/morph/SKILL.md",
		"codex":       "/h/.agents/skills/morph/SKILL.md",
		"gemini-cli":  "/h/.gemini/commands/morph.toml",
		"qwen-code":   "/h/.qwen/commands/morph.md",
		"kimi":        "/k/skills/morph/SKILL.md",
		"generic":     "/d/molten/agents/morph.md",
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
		"codex":       "after `$morph`",
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
		if m := agentMarkerRegex.FindStringSubmatch(content); m == nil || m[1] != "morph" || m[2] != "1.2.3" {
			t.Errorf("%s: missing version marker", p.Id)
		}
		if !strings.Contains(content, "molten docs") || !strings.Contains(content, "molten copy") || !strings.Contains(content, "Decide what the request changes") {
			t.Errorf("%s: the guide must be complete", p.Id)
		}
		switch p.Format {
		case "skill":
			if !strings.HasPrefix(content, "---\nname: morph\ndescription: ") {
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
	for _, name := range []string{"mod-format.md", "morph.md", "agent-states.md", "worktrees.md", "examples/copy-box/mod.json", "examples/copy-box/main.js"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Errorf("missing %s: %v", name, err)
		}
	}
	guide, _ := os.ReadFile(filepath.Join(dir, "morph.md"))
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
		if m := agentMarkerRegex.FindStringSubmatch(content); m == nil || m[1] != "molten-pipeline" || m[2] != "2.0.0" {
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
	if len(status.Guides) != 3 || status.Guides[1].Name != PipelineGuideName || status.Guides[2].Name != BugGuideName {
		t.Fatalf("every guide installed: %+v", status.Guides)
	}
	for _, g := range status.Guides {
		if !g.Installed {
			t.Fatalf("%s not installed", g.Name)
		}
	}
	bug, _ := FindGuide(BugGuideName)
	if s := claude.GuideStatus(env, bug); !strings.Contains(s.Invocation, "/molten-bug") {
		t.Fatalf("bug guide invocation: %+v", s)
	}
	// A morph file must not be mistaken for the pipeline guide.
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

// An earlier version's /molten-feature, as molten wrote it: the old marker and frontmatter (FR-MORPH-009).
func writeRetiredGuide(t *testing.T, p AgentProfile, env AgentEnv, version string) string {
	t.Helper()
	retired := RetiredGuides[0]
	path := p.GuidePath(env, retired)
	content := p.render(AgentGuide{Name: retired.Name, Description: "old"}, "old guide", agentMarker(retired.Name, version, p.Id))
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestInstallReplacesTheRetiredGuide(t *testing.T) {
	for _, p := range AgentProfiles {
		env := testAgentEnv(t)
		oldPath := writeRetiredGuide(t, p, env, "0.14.5")
		if got := p.InstalledRetiredGuides(env); len(got) != 1 || got[0] != "molten-feature" {
			t.Fatalf("%s: the old guide is recognised: %v", p.Id, got)
		}
		if _, err := p.Install(env, "0.16.0"); err != nil {
			t.Fatalf("%s install: %v", p.Id, err)
		}
		if _, err := os.Stat(oldPath); !os.IsNotExist(err) {
			t.Fatalf("%s: molten-feature must be gone", p.Id)
		}
		if p.Format == "skill" {
			if _, err := os.Stat(filepath.Dir(oldPath)); !os.IsNotExist(err) {
				t.Fatalf("%s: the empty molten-feature skill folder must go too", p.Id)
			}
		}
		if status := p.Status(env); !status.Installed || status.Version != "0.16.0" {
			t.Fatalf("%s: morph installed: %+v", p.Id, status)
		}
		if got := p.InstalledRetiredGuides(env); len(got) != 0 {
			t.Fatalf("%s: nothing retired left: %v", p.Id, got)
		}
	}
}

func TestInstallLeavesAHandWrittenRetiredGuide(t *testing.T) {
	env := testAgentEnv(t)
	p, _ := FindAgent("claude-code")
	path := p.GuidePath(env, RetiredGuides[0])
	os.MkdirAll(filepath.Dir(path), 0755)
	os.WriteFile(path, []byte("my own molten-feature"), 0644)
	if got := p.InstalledRetiredGuides(env); len(got) != 0 {
		t.Fatalf("a hand-written file is not molten's: %v", got)
	}
	if _, err := p.Install(env, "1"); err != nil {
		t.Fatalf("install must succeed beside a hand-written molten-feature: %v", err)
	}
	if _, _, err := p.Remove(env); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if data, _ := os.ReadFile(path); string(data) != "my own molten-feature" {
		t.Fatal("the hand-written file changed")
	}
}

func TestRemoveDeletesTheRetiredGuide(t *testing.T) {
	env := testAgentEnv(t)
	p, _ := FindAgent("codex")
	oldPath := writeRetiredGuide(t, p, env, "0.14.5")
	_, removed, err := p.Remove(env)
	if err != nil || !removed {
		t.Fatalf("remove: %v %v", removed, err)
	}
	if _, err := os.Stat(oldPath); !os.IsNotExist(err) {
		t.Fatal("molten-feature must be gone")
	}
}

func TestRetiredGuideIsNotMistakenForMorph(t *testing.T) {
	env := testAgentEnv(t)
	p, _ := FindAgent("claude-code")
	morph, _ := FindGuide(AgentGuideName)
	retired := RetiredGuides[0]
	content := p.render(AgentGuide{Name: retired.Name}, "old guide", agentMarker(retired.Name, "0.14.5", p.Id))
	os.MkdirAll(filepath.Dir(p.GuidePath(env, morph)), 0755)
	os.WriteFile(p.GuidePath(env, morph), []byte(content), 0644)
	if s := p.GuideStatus(env, morph); !s.Foreign || s.Installed {
		t.Fatalf("a molten-feature file at the morph path is foreign: %+v", s)
	}
}

func TestFilterAgentBlocks(t *testing.T) {
	body := "a\n<!-- only:claude-code -->\nclaude\n<!-- /only -->\n<!-- not:claude-code -->\nothers\n<!-- /not -->\nz\n"
	if got := FilterAgentBlocks(body, "claude-code"); got != "a\nclaude\nz\n" {
		t.Fatalf("claude-code: %q", got)
	}
	if got := FilterAgentBlocks(body, "codex"); got != "a\nothers\nz\n" {
		t.Fatalf("codex: %q", got)
	}
}

// FR-MORPH-010: only Claude Code's /morph builds a Claude Code part; every other agent says plainly that it cannot
// change its own session (TC-MORPH-012).
func TestMorphGuideClaudeCodePart(t *testing.T) {
	for _, p := range AgentProfiles {
		content, err := p.Render("1")
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(content, "<!-- only") || strings.Contains(content, "<!-- not") || strings.Contains(content, "<!-- /") {
			t.Errorf("%s: a block marker reached the rendering", p.Id)
		}
		if p.Id == "claude-code" {
			for _, want := range []string{"agents/claude-code", "plugin-authoring", "claude --continue", "--claude-code", "claude-code-parts.md"} {
				if !strings.Contains(content, want) {
					t.Errorf("claude-code: the guide lacks %q", want)
				}
			}
			if strings.Contains(content, "cannot change that for your agent") {
				t.Error("claude-code: the guide must not say the session cannot change")
			}
			continue
		}
		for _, absent := range []string{"Claude Code part", "agents.claude-code", "CLAUDE_CODE_PLUGIN_DIRS", "plugin-authoring"} {
			if strings.Contains(content, absent) {
				t.Errorf("%s: the guide holds %q", p.Id, absent)
			}
		}
		if !strings.Contains(content, "cannot change that for your agent") {
			t.Errorf("%s: the guide must say the agent's own session cannot change", p.Id)
		}
	}
	dir := t.TempDir()
	if err := WriteDocs(dir); err != nil {
		t.Fatal(err)
	}
	written, _ := os.ReadFile(filepath.Join(dir, "morph.md"))
	source, _ := agentdocs.Files.ReadFile(agentdocs.GuideFile)
	want := FilterAgentBlocks(strings.ReplaceAll(string(source), agentRequestPlaceholder, "(the user's request)"), GenericAgentId)
	if string(written) != want || strings.Contains(want, "plugin-authoring") {
		t.Error("molten docs writes the generic morph.md, with no Claude Code block")
	}
}

func TestEmbeddedClaudeCodeExample(t *testing.T) {
	part := "examples/test-band/agents/claude-code"
	for _, name := range []string{"claude-code-parts.md", "examples/test-band/mod.json", "examples/test-band/main.js", part + "/.claude-plugin/plugin.json", part + "/hooks/hooks.json", part + "/hooks/register.tsx", part + "/types/index.d.ts"} {
		if _, err := agentdocs.Files.ReadFile(name); err != nil {
			t.Errorf("not embedded: %s", name)
		}
	}
	if _, err := fs.Stat(agentdocs.Files, part+"/.claude-plugin/types"); err == nil {
		t.Error("Claude Code's typings must not be embedded: delete the example's .claude-plugin/types/")
	}
	dir := t.TempDir()
	if err := WriteDocs(dir); err != nil {
		t.Fatal(err)
	}
	modsDir := filepath.Join(dir, "examples")
	partInfo, err := agentparts.ReadClaudeCodePart(modsDir, "test-band")
	if err != nil || partInfo == nil {
		t.Fatalf("the example declares its part: %+v %v", partInfo, err)
	}
	if _, err := agentparts.CheckPartFolder(modsDir, "test-band", partInfo); err != nil {
		t.Fatalf("the example part: %v", err)
	}
	if _, err := exec.LookPath("claude"); err != nil {
		t.Skip("claude is not on the PATH: claude plugin validate not run")
	}
	out, err := exec.Command("claude", "plugin", "validate", filepath.Join(dir, filepath.FromSlash(part))).CombinedOutput()
	if err != nil {
		t.Fatalf("claude plugin validate on the example: %v\n%s", err, out)
	}
}
