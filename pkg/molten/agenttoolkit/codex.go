// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agenttoolkit

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/BurntSushi/toml"
)

// Codex's files (developers.openai.com/codex/config-reference, mcp, skills, plugins; read 2026-10-30):
//   - $CODEX_HOME/config.toml (~/.codex): [mcp_servers.<name>] with command or url and enabled, and
//     [plugins."<name>@<marketplace>"] with enabled. A project's .codex/config.toml adds its own servers.
//   - skills: $CODEX_HOME/skills (its .system folder holds Codex's own), ~/.agents/skills, and a project's
//     .agents/skills and .codex/skills.
//   - plugins/cache/<marketplace>/<name>/<version>/: a plugin's .mcp.json and skills/, the newest version used.
// auth.json, beside config.toml, holds the credentials: it is never opened.

const codexSystemSkills = ".system"

type codexServer struct {
	Command any   `toml:"command"`
	Url     any   `toml:"url"`
	Enabled *bool `toml:"enabled"`
}

func (s codexServer) transport() string {
	if s.Url != nil {
		return TransportHttp
	}
	if s.Command != nil {
		return TransportStdio
	}
	return ""
}

type codexPlugin struct {
	Enabled *bool `toml:"enabled"`
}

type codexConfig struct {
	McpServers map[string]codexServer `toml:"mcp_servers"`
	Plugins    map[string]codexPlugin `toml:"plugins"`
}

func codexHome(env Env) string {
	return envOr(env, "CODEX_HOME", filepath.Join(env.Home, ".codex"))
}

func decodeToml(path string) (codexConfig, bool) {
	var c codexConfig
	data := readConfig(path)
	if data == nil {
		return c, false
	}
	if _, err := toml.Decode(string(data), &c); err != nil {
		return c, false
	}
	return c, true
}

func offWhen(enabled *bool) string {
	if enabled != nil && !*enabled {
		return StateOff
	}
	return ""
}

// ReadCodex lists Codex's servers, skills and plugins for a session started in cwd.
func ReadCodex(env Env, cwd string) Toolkit {
	home := codexHome(env)
	dirs := projectDirs(env, cwd)
	var tk Toolkit
	for _, dir := range dirs {
		project, ok := decodeToml(filepath.Join(dir, ".codex", "config.toml"))
		if !ok {
			continue
		}
		for name, s := range project.McpServers {
			tk.Servers = append(tk.Servers, McpServer{Name: name, Transport: s.transport(), Scope: ScopeProject, State: offWhen(s.Enabled)})
		}
	}
	config, _ := decodeToml(filepath.Join(home, "config.toml"))
	for name, s := range config.McpServers {
		tk.Servers = append(tk.Servers, McpServer{Name: name, Transport: s.transport(), Scope: ScopeUser, State: offWhen(s.Enabled)})
	}

	tk.Skills = append(tk.Skills, readSkills(filepath.Join(home, "skills"), ScopeUser, "")...)
	tk.Skills = append(tk.Skills, readSkills(filepath.Join(env.Home, ".agents", "skills"), ScopeUser, "")...)
	for _, dir := range dirs {
		tk.Skills = append(tk.Skills, readSkills(filepath.Join(dir, ".agents", "skills"), ScopeProject, "")...)
		tk.Skills = append(tk.Skills, readSkills(filepath.Join(dir, ".codex", "skills"), ScopeProject, "")...)
	}
	tk.Skills = append(tk.Skills, readSkills(filepath.Join(home, "skills", codexSystemSkills), ScopeSystem, "")...)

	for key, p := range config.Plugins {
		name, source := splitPluginKey(key)
		enabled := p.Enabled == nil || *p.Enabled
		tk.Plugins = append(tk.Plugins, Plugin{Name: name, Source: source, Scope: ScopeUser, Enabled: enabled})
		if !enabled || source == "" {
			continue
		}
		root := newestDir(filepath.Join(home, "plugins", "cache", source, name))
		if root == "" {
			continue
		}
		if m, ok := decodeCodexMcpJson(filepath.Join(root, claudeMcpJson)); ok {
			for srvName, s := range m.McpServers {
				tk.Servers = append(tk.Servers, McpServer{Name: srvName, Transport: s.transport(), Scope: ScopePlugin, Plugin: name, State: offWhen(s.Enabled)})
			}
		}
		tk.Skills = append(tk.Skills, readSkills(filepath.Join(root, "skills"), ScopePlugin, name)...)
	}
	return finish(tk)
}

func decodeCodexMcpJson(path string) (mcpJson, bool) {
	var m mcpJson
	data := readConfig(path)
	if data == nil || json.Unmarshal(data, &m) != nil {
		return m, false
	}
	return m, true
}

// newestDir is the most recently changed sub-folder of dir: the plugin version Codex installed last.
func newestDir(dir string) string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	best := ""
	var bestAt int64
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if at := info.ModTime().UnixNano(); best == "" || at > bestAt {
			best, bestAt = filepath.Join(dir, e.Name()), at
		}
	}
	return best
}
