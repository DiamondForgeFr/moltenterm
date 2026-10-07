// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentlaunch

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"

	"github.com/BurntSushi/toml"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
)

// What the Codex launcher reads of the user's configuration, read-only (NFR-SHELL-019): the system config.toml and
// managed_config.toml (/etc/codex), the user's $CODEX_HOME/config.toml, and the .codex/config.toml files of the
// folder and its parents up to the repository's root. Managed preferences deployed through MDM (macOS) cannot be
// read: one that sets notify replaces the wrapper. Codex applies the project files of a trusted folder only, above the user's; whether it takes a
// notify or a profile from them is not documented, so a project file that sets one is a doubt and notify is left
// alone. Nothing else of Codex's folder is opened: never auth.json, hooks.json or any credential.

const (
	codexConfigFile        = "config.toml"
	codexProjectDir        = ".codex"
	codexUnixSystemConfig  = "/etc/codex/config.toml"
	codexManagedConfigFile = "managed_config.toml"
	codexRootMarkersKey    = "project_root_markers"
	codexNotifyKey         = "notify"
	codexProfileKey        = "profile"
	codexProfilesKey       = "profiles"
	codexMcpServersKey     = "mcp_servers"
	codexProjectRootMarker = ".git"
)

// codexConfigSource is one config.toml Codex may read. managed: the administrator's managed_config.toml, which
// Codex applies above -c.
type codexConfigSource struct {
	display string
	keys    map[string]any
	project bool
	managed bool
}

// codexConfig is what the plan needs of the user's configuration.
type codexConfig struct {
	sources []codexConfigSource
	// unreadable: the display name of a config file that exists but could not be read or parsed.
	unreadable string
}

// readCodexConfig reads the system, user and project files, lowest level first.
func readCodexConfig(ctx LaunchContext) codexConfig {
	var rtn codexConfig
	userPath := filepath.Join(molten.CodexHome(ctx.Env), codexConfigFile)
	systemPath := codexSystemConfigPath(ctx)
	paths := []string{systemPath, userPath}
	project := map[string]bool{}
	managedPath := ""
	if systemPath != "" {
		managedPath = filepath.Join(filepath.Dir(systemPath), codexManagedConfigFile)
		paths = append(paths, managedPath)
	}
	realUser, userErr := filepath.EvalSymlinks(userPath)
	for _, p := range codexProjectConfigFiles(ctx.Cwd) {
		if filepath.Clean(p) == filepath.Clean(userPath) {
			continue
		}
		if real, err := filepath.EvalSymlinks(p); userErr == nil && err == nil && real == realUser {
			continue
		}
		paths = append(paths, p)
		project[p] = true
	}
	for _, path := range paths {
		if path == "" {
			continue
		}
		display := molten.DisplayHomePath(ctx.Env, path)
		// A repository's file that is a link may point anywhere (~/.codex/auth.json): it is never opened.
		if info, err := os.Lstat(path); project[path] && err == nil && info.Mode()&fs.ModeSymlink != 0 {
			rtn.unreadable = display
			return rtn
		}
		data, err := readBounded(path)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		var keys map[string]any
		if err == nil {
			_, err = toml.Decode(string(data), &keys)
		}
		if err != nil {
			rtn.unreadable = display
			return rtn
		}
		rtn.sources = append(rtn.sources, codexConfigSource{display: display, keys: keys, project: project[path], managed: path == managedPath})
	}
	return rtn
}

func codexSystemConfigPath(ctx LaunchContext) string {
	if ctx.CodexSystemConfig != "" {
		return ctx.CodexSystemConfig
	}
	if runtime.GOOS == "windows" {
		return ""
	}
	return codexUnixSystemConfig
}

// codexProjectConfigFiles lists the .codex/config.toml of the folder and of each parent up to the repository's
// root (the nearest folder holding .git), root first; only the folder's own when no root is found.
func codexProjectConfigFiles(cwd string) []string {
	if cwd == "" || !filepath.IsAbs(cwd) {
		return nil
	}
	cwd = filepath.Clean(cwd)
	var dirs []string
	found := false
	for dir := cwd; ; dir = filepath.Dir(dir) {
		dirs = append(dirs, dir)
		if _, err := os.Lstat(filepath.Join(dir, codexProjectRootMarker)); err == nil {
			found = true
			break
		}
		if dir == filepath.Dir(dir) {
			break
		}
	}
	if !found {
		dirs = []string{cwd}
	}
	var rtn []string
	for i := len(dirs) - 1; i >= 0; i-- {
		rtn = append(rtn, filepath.Join(dirs[i], codexProjectDir, codexConfigFile))
	}
	return rtn
}

// userNotify is the notify of the system and user files, the user's winning: the argv Codex runs at each turn's
// end, nil for none. ok is false when the value is not an array of strings (Codex would refuse it).
func (c codexConfig) userNotify() ([]string, string, bool) {
	var argv []string
	where := ""
	for _, s := range c.sources {
		if s.project || s.managed {
			continue
		}
		raw, has := s.keys[codexNotifyKey]
		if !has {
			continue
		}
		list, ok := tomlStrings(raw)
		if !ok {
			return nil, s.display, false
		}
		argv, where = list, s.display
	}
	return argv, where, true
}

func tomlStrings(raw any) ([]string, bool) {
	items, ok := raw.([]any)
	if !ok {
		return nil, false
	}
	rtn := make([]string, 0, len(items))
	for _, it := range items {
		s, ok := it.(string)
		if !ok {
			return nil, false
		}
		rtn = append(rtn, s)
	}
	return rtn, true
}

// projectSetsNotify names a project file that sets notify, a profile or profiles: Codex may apply it above the
// user's file.
func (c codexConfig) projectSetsNotify() string {
	for _, s := range c.sources {
		if !s.project {
			continue
		}
		for _, key := range []string{codexNotifyKey, codexProfileKey, codexProfilesKey} {
			if _, ok := s.keys[key]; ok {
				return s.display
			}
		}
	}
	return ""
}

// managedSetsNotify names the managed file that sets notify: it applies above -c, so the wrapper would not run.
func (c codexConfig) managedSetsNotify() string {
	for _, s := range c.sources {
		if _, ok := s.keys[codexNotifyKey]; ok && s.managed {
			return s.display
		}
	}
	return ""
}

// projectRootMarkers names a file that changes how Codex finds a project's root, so its project files.
func (c codexConfig) projectRootMarkers() string {
	for _, s := range c.sources {
		if _, ok := s.keys[codexRootMarkersKey]; ok {
			return s.display
		}
	}
	return ""
}

// profile is the profile the files select, the user's winning.
func (c codexConfig) profile() string {
	rtn := ""
	for _, s := range c.sources {
		if name, ok := s.keys[codexProfileKey].(string); ok && !s.project {
			rtn = name
		}
	}
	return rtn
}

// profileNotify names the file whose profile of that name sets notify, or "".
func (c codexConfig) profileNotify(name string) string {
	if name == "" {
		return ""
	}
	for _, s := range c.sources {
		profiles, _ := s.keys[codexProfilesKey].(map[string]any)
		profile, _ := profiles[name].(map[string]any)
		if _, ok := profile[codexNotifyKey]; ok {
			return s.display
		}
	}
	return ""
}

// browserWhere names the file that declares a molten-browser MCP server, or "".
func (c codexConfig) browserWhere() string {
	for _, s := range c.sources {
		servers, _ := s.keys[codexMcpServersKey].(map[string]any)
		if _, ok := servers[mcpbrowser.ServerName]; ok {
			return s.display
		}
	}
	return ""
}
