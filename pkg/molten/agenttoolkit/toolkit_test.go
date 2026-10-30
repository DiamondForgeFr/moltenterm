// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agenttoolkit

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

func skill(t *testing.T, dir string, name string, desc string) {
	write(t, filepath.Join(dir, name, skillFileName), "---\nname: "+name+"\ndescription: "+desc+"\n---\n\n# "+name+"\n")
}

func fixtureEnv(t *testing.T) (Env, string) {
	home := t.TempDir()
	project := filepath.Join(home, "work", "app")
	if err := os.MkdirAll(filepath.Join(project, ".git"), 0755); err != nil {
		t.Fatal(err)
	}
	return Env{Home: home, Getenv: func(string) string { return "" }}, project
}

func serverNames(tk Toolkit) string {
	var rtn []string
	for _, s := range tk.Servers {
		rtn = append(rtn, s.Scope+":"+s.Name+":"+s.Transport+":"+s.State+":"+s.Plugin)
	}
	return strings.Join(rtn, ",")
}

func skillNames(tk Toolkit) string {
	var rtn []string
	for _, s := range tk.Skills {
		rtn = append(rtn, s.Scope+":"+s.Name+":"+s.Plugin)
	}
	return strings.Join(rtn, ",")
}

const secret = "sk-SECRET-TOKEN"

func TestReadClaude(t *testing.T) {
	env, project := fixtureEnv(t)
	sub := filepath.Join(project, "pkg")
	write(t, filepath.Join(env.Home, ".claude.json"), `{
		"oauthAccount": {"emailAddress": "someone@example.com"},
		"mcpServers": {
			"github": {"type": "http", "url": "https://api.example.com/mcp", "headers": {"Authorization": "Bearer `+secret+`"}},
			"context7": {"command": "npx", "args": ["-y", "ctx7"], "env": {"KEY": "`+secret+`"}}
		},
		"projects": {
			"`+project+`": {
				"mcpServers": {"localdb": {"command": "db-mcp"}},
				"enabledMcpjsonServers": ["approved"],
				"disabledMcpServers": ["context7"]
			}
		}
	}`)
	write(t, filepath.Join(project, ".mcp.json"), `{"mcpServers": {"approved": {"type": "sse", "url": "x"}, "pending": {"command": "p"}, "refused": {"command": "r"}}}`)
	write(t, filepath.Join(project, ".claude", "settings.json"), `{"disabledMcpjsonServers": ["refused"], "enabledPlugins": {"offplug@market": false}}`)
	write(t, filepath.Join(env.Home, ".claude", "settings.json"), `{"enabledPlugins": {"design@market": true}}`)
	plugDir := filepath.Join(env.Home, ".claude", "plugins", "cache", "market", "design", "1.0.0")
	offDir := filepath.Join(env.Home, ".claude", "plugins", "cache", "market", "offplug", "1.0.0")
	installed, _ := json.Marshal(map[string]any{"version": 2, "plugins": map[string]any{
		"design@market":  []any{map[string]any{"scope": "user", "installPath": plugDir}},
		"offplug@market": []any{map[string]any{"scope": "user", "installPath": offDir}},
		"elsewhere@mkt":  []any{map[string]any{"scope": "project", "projectPath": "/other", "installPath": "/x"}},
	}})
	write(t, filepath.Join(env.Home, ".claude", "plugins", "installed_plugins.json"), string(installed))
	write(t, filepath.Join(plugDir, ".mcp.json"), `{"mcpServers": {"figma": {"type": "http", "url": "u"}}}`)
	write(t, filepath.Join(plugDir, ".claude-plugin", "plugin.json"), `{"name": "design", "mcpServers": {"slack": {"command": "s"}}}`)
	write(t, filepath.Join(offDir, ".mcp.json"), `{"mcpServers": {"hidden": {"command": "h"}}}`)
	skill(t, filepath.Join(plugDir, "skills"), "critique", "Review a design.")
	skill(t, filepath.Join(offDir, "skills"), "nope", "Off plugin.")
	skill(t, filepath.Join(env.Home, ".claude", "skills"), "git-commit", "Quick commit and push\n  with a clean message")
	skill(t, filepath.Join(project, ".claude", "skills"), "sf-workflow", strings.Repeat("long words ", 40))
	write(t, filepath.Join(env.Home, ".claude", "skills", "broken", "README.md"), "no skill here")

	tk := ReadClaude(env, sub)
	if !tk.Supported || !tk.Online {
		t.Fatalf("flags: %+v", tk)
	}
	want := "user:context7:stdio:off:,user:github:http::," +
		"project:approved:sse::,project:pending:stdio:needsapproval:,project:refused:stdio:off:," +
		"local:localdb:stdio::,plugin:figma:http::design,plugin:slack:stdio::design"
	if got := serverNames(tk); got != want {
		t.Fatalf("servers:\n got %s\nwant %s", got, want)
	}
	if got := skillNames(tk); got != "user:git-commit:,project:sf-workflow:,plugin:critique:design" {
		t.Fatalf("skills: %s", got)
	}
	if tk.Skills[0].Description != "Quick commit and push with a clean message" {
		t.Fatalf("description: %q", tk.Skills[0].Description)
	}
	if d := tk.Skills[1].Description; len([]rune(d)) > maxDescriptionLen+1 || !strings.HasSuffix(d, "…") {
		t.Fatalf("long description: %q", d)
	}
	if len(tk.Plugins) != 2 || tk.Plugins[0].Name != "design" || !tk.Plugins[0].Enabled || tk.Plugins[1].Enabled {
		t.Fatalf("plugins: %+v", tk.Plugins)
	}
	data, _ := json.Marshal(tk)
	for _, leak := range []string{secret, "api.example.com", "npx", "someone@example.com", "ctx7"} {
		if strings.Contains(string(data), leak) {
			t.Fatalf("toolkit carries %q: %s", leak, data)
		}
	}
}

func TestReadClaudeConfigDirAndEmpty(t *testing.T) {
	env, project := fixtureEnv(t)
	alt := filepath.Join(env.Home, "alt")
	env.Getenv = func(k string) string {
		if k == "CLAUDE_CONFIG_DIR" {
			return alt
		}
		return ""
	}
	write(t, filepath.Join(alt, ".claude.json"), `{"mcpServers": {"alt": {"command": "a"}}}`)
	write(t, filepath.Join(env.Home, ".claude.json"), `{"mcpServers": {"ignored": {"command": "a"}}}`)
	if got := serverNames(ReadClaude(env, project)); got != "user:alt:stdio::" {
		t.Fatalf("servers: %s", got)
	}
	empty := ReadClaude(Env{Home: t.TempDir()}, "")
	if !empty.Supported || len(empty.Servers)+len(empty.Skills)+len(empty.Plugins) != 0 {
		t.Fatalf("empty: %+v", empty)
	}
}

func TestReadCodex(t *testing.T) {
	env, project := fixtureEnv(t)
	codex := filepath.Join(env.Home, ".codex")
	write(t, filepath.Join(codex, "config.toml"), `model = "gpt"

[mcp_servers.node_repl]
command = "node"
args = ["repl"]

[mcp_servers.node_repl.env]
TOKEN = "`+secret+`"

[mcp_servers.Context7]
url = "https://mcp.example.com"
enabled = false

[plugins."browser@bundled"]
enabled = true

[plugins."sleepy@bundled"]
enabled = false
`)
	write(t, filepath.Join(codex, "auth.json"), `{"OPENAI_API_KEY": "`+secret+`"}`)
	write(t, filepath.Join(project, ".codex", "config.toml"), "[mcp_servers.projdb]\ncommand = \"db\"\n")
	plug := filepath.Join(codex, "plugins", "cache", "bundled", "browser", "26.1")
	write(t, filepath.Join(plug, ".mcp.json"), `{"mcpServers": {"browser-use": {"command": "b", "enabled": false}}}`)
	skill(t, filepath.Join(plug, "skills"), "browse", "Drive a browser.")
	skill(t, filepath.Join(codex, "skills"), "defuddle", "Read pages.")
	skill(t, filepath.Join(codex, "skills", ".system"), "imagegen", "Make images.")
	skill(t, filepath.Join(env.Home, ".agents", "skills"), "shared", "Shared skill.")
	skill(t, filepath.Join(project, ".agents", "skills"), "repo", "Repo skill.")

	tk := ReadCodex(env, project)
	if !tk.Supported || tk.Online {
		t.Fatalf("flags: %+v", tk)
	}
	want := "user:Context7:http:off:,user:node_repl:stdio::,project:projdb:stdio::,plugin:browser-use:stdio:off:browser"
	if got := serverNames(tk); got != want {
		t.Fatalf("servers:\n got %s\nwant %s", got, want)
	}
	if got := skillNames(tk); got != "user:defuddle:,user:shared:,project:repo:,plugin:browse:browser,system:imagegen:" {
		t.Fatalf("skills: %s", got)
	}
	if len(tk.Plugins) != 2 || !tk.Plugins[0].Enabled || tk.Plugins[1].Enabled {
		t.Fatalf("plugins: %+v", tk.Plugins)
	}
	data, _ := json.Marshal(tk)
	if strings.Contains(string(data), secret) || strings.Contains(string(data), "mcp.example.com") {
		t.Fatalf("toolkit carries a secret: %s", data)
	}
}

func TestReaderFor(t *testing.T) {
	if ReaderFor("claude") == nil || ReaderFor("codex") == nil || ReaderFor("gemini") != nil {
		t.Fatal("readers")
	}
}

func TestRegularToolkitFiles(t *testing.T) {
	dir := t.TempDir()
	config := filepath.Join(dir, "config")
	write(t, config, "small config")
	if got := string(readConfig(config)); got != "small config" {
		t.Fatalf("config = %q", got)
	}
	if readConfig(dir) != nil || readConfig(filepath.Join(dir, "missing")) != nil {
		t.Fatal("directory or missing config accepted")
	}
	large := filepath.Join(dir, "large")
	f, err := os.Create(large)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(maxConfigBytes + 1); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if readConfig(large) != nil {
		t.Fatal("oversize config accepted")
	}
	if _, err := readConfigLimit(strings.NewReader("123456789"), 8); err == nil {
		t.Fatal("reader that grows beyond its limit accepted")
	}
	if got, err := readConfigLimit(strings.NewReader("12345678"), 8); err != nil || string(got) != "12345678" {
		t.Fatalf("at limit: %q, %v", got, err)
	}
	skillPath := filepath.Join(dir, "actual-skill")
	write(t, skillPath, "---\nname: linked\ndescription: works\n---\n")
	link := filepath.Join(dir, "linked-skill")
	if err := os.Symlink(skillPath, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if head, ok := readSkillHead(link); !ok || head.Name != "linked" {
		t.Fatalf("symlink skill: %+v, %v", head, ok)
	}
	skillDir := filepath.Join(dir, "skill-source")
	write(t, filepath.Join(skillDir, skillFileName), "---\nname: linked-directory\n---\n")
	skillsDir := filepath.Join(dir, "skills")
	if err := os.Mkdir(skillsDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(skillDir, filepath.Join(skillsDir, "link")); err != nil {
		t.Fatal(err)
	}
	if skills := readSkills(skillsDir, ScopeUser, ""); len(skills) != 1 || skills[0].Name != "linked-directory" {
		t.Fatalf("symlink skill directory: %+v", skills)
	}
	configLink := filepath.Join(dir, "linked-config")
	if err := os.Symlink(config, configLink); err != nil {
		t.Fatal(err)
	}
	if string(readConfig(configLink)) != "small config" {
		t.Fatal("symlink config rejected")
	}
}
