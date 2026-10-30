// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agenttoolkit

import (
	"encoding/json"
	"path/filepath"
	"slices"
)

// Claude Code's files (code.claude.com/docs/en/mcp, settings, skills, plugins; read 2026-10-30):
//   - ~/.claude.json ($CLAUDE_CONFIG_DIR/.claude.json when set): mcpServers (user scope), and projects[<folder>] with
//     the local-scope mcpServers, the .mcp.json approvals and the servers turned off with /mcp. The file also holds
//     account details: only the fields below are decoded.
//   - .mcp.json at the project's root: project scope, used once approved (enabledMcpjsonServers,
//     enableAllProjectMcpServers) unless refused (disabledMcpjsonServers).
//   - settings.json and settings.local.json (user, then project): enabledPlugins and the approvals.
//   - plugins/installed_plugins.json: each plugin's install folder, whose .mcp.json, .claude-plugin/plugin.json
//     mcpServers and skills/ the plugin brings.
//   - skills/ of the configuration folder (personal) and .claude/skills of the project.

const (
	claudePluginsFile   = "installed_plugins.json"
	claudePluginJson    = "plugin.json"
	claudePluginMetaDir = ".claude-plugin"
	claudeMcpJson       = ".mcp.json"
)

// rawServer is a server's declaration, decoded only as far as its transport: the values are dropped.
type rawServer struct {
	Type    string          `json:"type"`
	Command json.RawMessage `json:"command"`
	Url     json.RawMessage `json:"url"`
	Enabled *bool           `json:"enabled"`
}

func (s rawServer) transport() string {
	switch s.Type {
	case TransportStdio, TransportSse:
		return s.Type
	case TransportHttp, "streamable-http", "streamable_http":
		return TransportHttp
	}
	if len(s.Url) > 0 {
		return TransportHttp
	}
	if len(s.Command) > 0 {
		return TransportStdio
	}
	return ""
}

type claudeProject struct {
	McpServers                 map[string]rawServer `json:"mcpServers"`
	EnabledMcpjsonServers      []string             `json:"enabledMcpjsonServers"`
	DisabledMcpjsonServers     []string             `json:"disabledMcpjsonServers"`
	DisabledMcpServers         []string             `json:"disabledMcpServers"`
	EnableAllProjectMcpServers bool                 `json:"enableAllProjectMcpServers"`
}

type claudeState struct {
	McpServers map[string]rawServer      `json:"mcpServers"`
	Projects   map[string]*claudeProject `json:"projects"`
}

type claudeSettings struct {
	EnabledPlugins             map[string]bool `json:"enabledPlugins"`
	EnabledMcpjsonServers      []string        `json:"enabledMcpjsonServers"`
	DisabledMcpjsonServers     []string        `json:"disabledMcpjsonServers"`
	EnableAllProjectMcpServers *bool           `json:"enableAllProjectMcpServers"`
}

type claudeInstall struct {
	Scope       string `json:"scope"`
	InstallPath string `json:"installPath"`
	ProjectPath string `json:"projectPath"`
}

type claudeInstalled struct {
	Plugins map[string][]claudeInstall `json:"plugins"`
}

type mcpJson struct {
	McpServers map[string]rawServer `json:"mcpServers"`
}

func claudeConfigDir(env Env) string {
	return envOr(env, "CLAUDE_CONFIG_DIR", filepath.Join(env.Home, ".claude"))
}

func claudeStateFile(env Env) string {
	if dir := envOr(env, "CLAUDE_CONFIG_DIR", ""); dir != "" {
		return filepath.Join(dir, ".claude.json")
	}
	return filepath.Join(env.Home, ".claude.json")
}

func decodeJson[T any](path string) (T, bool) {
	var v T
	data := readConfig(path)
	if data == nil {
		return v, false
	}
	if err := json.Unmarshal(data, &v); err != nil {
		return v, false
	}
	return v, true
}

// ReadClaude lists Claude Code's servers, skills and plugins for a session started in cwd.
func ReadClaude(env Env, cwd string) Toolkit {
	configDir := claudeConfigDir(env)
	dirs := projectDirs(env, cwd)
	state, _ := decodeJson[claudeState](claudeStateFile(env))

	// Settings, lowest precedence first: the user's, then the project's from its root down to cwd.
	settingsFiles := []string{filepath.Join(configDir, "settings.json"), filepath.Join(configDir, "settings.local.json")}
	for i := len(dirs) - 1; i >= 0; i-- {
		settingsFiles = append(settingsFiles, filepath.Join(dirs[i], ".claude", "settings.json"), filepath.Join(dirs[i], ".claude", "settings.local.json"))
	}
	enabledPlugins := map[string]bool{}
	var approved, refused []string
	approveAll := false
	for _, path := range settingsFiles {
		s, ok := decodeJson[claudeSettings](path)
		if !ok {
			continue
		}
		for k, v := range s.EnabledPlugins {
			enabledPlugins[k] = v
		}
		approved = append(approved, s.EnabledMcpjsonServers...)
		refused = append(refused, s.DisabledMcpjsonServers...)
		if s.EnableAllProjectMcpServers != nil {
			approveAll = *s.EnableAllProjectMcpServers
		}
	}
	var turnedOff []string
	var local []*claudeProject
	for _, dir := range dirs {
		if p := state.Projects[dir]; p != nil {
			local = append(local, p)
			approved = append(approved, p.EnabledMcpjsonServers...)
			refused = append(refused, p.DisabledMcpjsonServers...)
			turnedOff = append(turnedOff, p.DisabledMcpServers...)
			approveAll = approveAll || p.EnableAllProjectMcpServers
		}
	}
	stateOf := func(name string, fallback string) string {
		if slices.Contains(turnedOff, name) {
			return StateOff
		}
		return fallback
	}

	tk := Toolkit{Online: true}
	for _, p := range local {
		for name, s := range p.McpServers {
			tk.Servers = append(tk.Servers, McpServer{Name: name, Transport: s.transport(), Scope: ScopeLocal, State: stateOf(name, "")})
		}
	}
	for _, dir := range dirs {
		m, ok := decodeJson[mcpJson](filepath.Join(dir, claudeMcpJson))
		if !ok {
			continue
		}
		for name, s := range m.McpServers {
			st := StateNeedsApproval
			switch {
			case slices.Contains(refused, name):
				st = StateOff
			case approveAll || slices.Contains(approved, name):
				st = ""
			}
			tk.Servers = append(tk.Servers, McpServer{Name: name, Transport: s.transport(), Scope: ScopeProject, State: stateOf(name, st)})
		}
	}
	for name, s := range state.McpServers {
		tk.Servers = append(tk.Servers, McpServer{Name: name, Transport: s.transport(), Scope: ScopeUser, State: stateOf(name, "")})
	}

	tk.Skills = append(tk.Skills, readSkills(filepath.Join(configDir, "skills"), ScopeUser, "")...)
	for _, dir := range dirs {
		tk.Skills = append(tk.Skills, readSkills(filepath.Join(dir, ".claude", "skills"), ScopeProject, "")...)
	}

	installed, _ := decodeJson[claudeInstalled](filepath.Join(configDir, "plugins", claudePluginsFile))
	for key, installs := range installed.Plugins {
		install, ok := claudeInstallFor(installs, dirs)
		if !ok {
			continue
		}
		name, source := splitPluginKey(key)
		enabled, set := enabledPlugins[key]
		if !set {
			enabled = true
		}
		tk.Plugins = append(tk.Plugins, Plugin{Name: name, Source: source, Scope: pluginScope(install.Scope), Enabled: enabled})
		if !enabled || install.InstallPath == "" {
			continue
		}
		for srvName, s := range claudePluginServers(install.InstallPath) {
			tk.Servers = append(tk.Servers, McpServer{Name: srvName, Transport: s.transport(), Scope: ScopePlugin, Plugin: name, State: stateOf(srvName, "")})
		}
		tk.Skills = append(tk.Skills, readSkills(filepath.Join(install.InstallPath, "skills"), ScopePlugin, name)...)
	}
	return finish(tk)
}

// claudeInstallFor picks the install a session in dirs uses: a project's or local one for one of its folders first,
// then the user's.
func claudeInstallFor(installs []claudeInstall, dirs []string) (claudeInstall, bool) {
	for _, in := range installs {
		if in.Scope != ScopeUser && in.ProjectPath != "" && slices.Contains(dirs, filepath.Clean(in.ProjectPath)) {
			return in, true
		}
	}
	for _, in := range installs {
		if in.Scope == ScopeUser || in.Scope == "" {
			return in, true
		}
	}
	return claudeInstall{}, false
}

func pluginScope(scope string) string {
	switch scope {
	case ScopeProject, ScopeLocal:
		return scope
	}
	return ScopeUser
}

// claudePluginServers reads a plugin's servers: its .mcp.json, and its manifest's mcpServers (an object, or the path
// of a file inside the plugin).
func claudePluginServers(root string) map[string]rawServer {
	rtn := map[string]rawServer{}
	if m, ok := decodeJson[mcpJson](filepath.Join(root, claudeMcpJson)); ok {
		for k, v := range m.McpServers {
			rtn[k] = v
		}
	}
	manifest, ok := decodeJson[struct {
		McpServers json.RawMessage `json:"mcpServers"`
	}](filepath.Join(root, claudePluginMetaDir, claudePluginJson))
	if !ok || len(manifest.McpServers) == 0 {
		return rtn
	}
	var inline map[string]rawServer
	if json.Unmarshal(manifest.McpServers, &inline) == nil {
		for k, v := range inline {
			rtn[k] = v
		}
		return rtn
	}
	var rel string
	if json.Unmarshal(manifest.McpServers, &rel) != nil || rel == "" {
		return rtn
	}
	path := filepath.Clean(filepath.Join(root, rel))
	if !isInside(root, path) {
		return rtn
	}
	if m, ok := decodeJson[mcpJson](path); ok {
		for k, v := range m.McpServers {
			rtn[k] = v
		}
	}
	return rtn
}

func isInside(root string, path string) bool {
	rel, err := filepath.Rel(filepath.Clean(root), path)
	return err == nil && rel != ".." && !filepath.IsAbs(rel) && (len(rel) < 3 || rel[:3] != ".."+string(filepath.Separator))
}
