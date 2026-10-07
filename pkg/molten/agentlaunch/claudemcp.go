// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentlaunch

import (
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
	"github.com/wavetermdev/waveterm/pkg/util/shellutil"
)

// The MoltenTerm browser offered to Claude Code at launch (FR-SHELL-037, DS-SHELL-049). mcpServers is not a settings
// key: servers come from ~/.claude.json (user scope, and local scope under projects[<folder>]), the .mcp.json files
// of the folder and its parents (project scope), managed MCP, and --mcp-config, whose servers are added to the
// others (https://code.claude.com/docs/en/mcp). So the run gets a second generated file declaring molten-browser,
// passed with --mcp-config, unless the user already has a server of that name, passed --strict-mcp-config (they chose
// the servers), or their organization's managed-mcp.json has exclusive control. A file that cannot be read is a doubt:
// nothing is added.

const (
	claudeMcpConfigFlag   = "--mcp-config"
	claudeStrictMcpFlag   = "--strict-mcp-config"
	claudeMcpFilePrefix   = "claude-mcp"
	claudeManagedMcpFile  = "managed-mcp.json"
	claudeGlobalConfig    = ".claude.json"
	claudeProjectMcpFile  = ".mcp.json"
	claudeBrowserItemName = "MoltenTerm browser"
	// ~/.claude.json holds the history of every project and grows large: it is searched for the name before it is
	// parsed, and not read past this size.
	maxGlobalConfigBytes = 64 * 1024 * 1024
)

// claudeMcpArgs is what the plan reads of the user's MCP options: the values of every --mcp-config (Commander reads
// `--mcp-config a b` until the next option, and `--mcp-config=a` as one value) and --strict-mcp-config.
type claudeMcpArgs struct {
	configs []string
	strict  bool
}

func parseClaudeMcpArgs(args []string) claudeMcpArgs {
	var rtn claudeMcpArgs
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			break
		}
		if arg == claudeStrictMcpFlag {
			rtn.strict = true
			continue
		}
		if value, ok := strings.CutPrefix(arg, claudeMcpConfigFlag+"="); ok {
			rtn.configs = append(rtn.configs, value)
			continue
		}
		if arg != claudeMcpConfigFlag {
			continue
		}
		for i+1 < len(args) && !isCommanderOption(args[i+1]) {
			i++
			rtn.configs = append(rtn.configs, args[i])
		}
	}
	return rtn
}

func isCommanderOption(arg string) bool {
	return len(arg) > 1 && arg[0] == '-'
}

type claudeMcpDoc struct {
	McpServers map[string]json.RawMessage `json:"mcpServers"`
}

func (d claudeMcpDoc) hasBrowser() bool {
	_, ok := d.McpServers[mcpbrowser.ServerName]
	return ok
}

// claudeBrowserConfigJSON is the generated --mcp-config: one stdio server running MoltenTerm's own molten by its
// absolute path, never one looked up on PATH.
func claudeBrowserConfigJSON(moltenPath string) ([]byte, error) {
	doc := map[string]any{"mcpServers": map[string]any{
		mcpbrowser.ServerName: map[string]any{"type": "stdio", "command": moltenPath, "args": []string{"mcp", "browser"}},
	}}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(doc); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// planClaudeBrowser returns the --mcp-config file to add, or nil with the reason in Skipped.
func planClaudeBrowser(ctx LaunchContext, managed settingsSource, plan *LaunchPlan) []byte {
	skip := func(reason string) []byte {
		plan.Skipped = append(plan.Skipped, molten.IntegrationItem{Kind: molten.IntegrationBrowser, Name: claudeBrowserItemName, Reason: reason})
		return nil
	}
	if ctx.MoltenPath == "" {
		return skip("MoltenTerm's browser server (molten mcp browser) is not installed")
	}
	mcpArgs := parseClaudeMcpArgs(ctx.Args)
	if mcpArgs.strict {
		return skip("you passed " + claudeStrictMcpFlag + ": only your own --mcp-config servers run")
	}
	if reason := managedMcpReason(ctx, managed); reason != "" {
		return skip(reason)
	}
	for _, value := range mcpArgs.configs {
		doc, err := readUserMcpConfig(value, ctx.Cwd)
		if err != nil {
			return skip("your --mcp-config " + value + " could not be read")
		}
		if doc.hasBrowser() {
			return skip("already yours, in your --mcp-config")
		}
	}
	if where, err := claudeBrowserInGlobalConfig(ctx); err != nil || where != "" {
		if err != nil {
			return skip(err.Error())
		}
		return skip("already yours, in " + where)
	}
	if where, err := claudeBrowserInProjectFiles(ctx); err != nil || where != "" {
		if err != nil {
			return skip(err.Error())
		}
		return skip("already yours, in " + where)
	}
	data, err := claudeBrowserConfigJSON(ctx.MoltenPath)
	if err != nil {
		return skip("the server's configuration could not be written")
	}
	plan.Added = append(plan.Added, molten.IntegrationItem{Kind: molten.IntegrationBrowser, Name: claudeBrowserItemName})
	return data
}

// managedMcpReason: a managed-mcp.json next to the managed settings has exclusive control (Claude Code then ignores
// other servers), and a managed managedMcpServers naming molten-browser is the organization's own.
func managedMcpReason(ctx LaunchContext, managed settingsSource) string {
	managedPath := ctx.ManagedSettings
	if managedPath == "" {
		managedPath = molten.ClaudeManagedSettingsPath()
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(managedPath), claudeManagedMcpFile)); err == nil {
		return "your organization's managed MCP configuration decides which servers run"
	}
	if managed.unreadable && strings.Contains(managed.raw, mcpbrowser.ServerName) {
		return "already provided by your organization's managed settings"
	}
	if raw, ok := managed.keys["managedMcpServers"]; ok && bytes.Contains(raw, []byte(`"`+mcpbrowser.ServerName+`"`)) {
		return "already provided by your organization's managed settings"
	}
	return ""
}

// readUserMcpConfig reads one --mcp-config value as Claude Code does: a JSON object, inline or in a file.
func readUserMcpConfig(value string, cwd string) (claudeMcpDoc, error) {
	var doc claudeMcpDoc
	data := []byte(value)
	if !strings.HasPrefix(strings.TrimSpace(value), "{") {
		path := value
		if !filepath.IsAbs(path) {
			path = filepath.Join(cwd, path)
		}
		read, err := readBounded(path)
		if err != nil {
			return doc, err
		}
		data = read
	}
	err := json.Unmarshal(data, &doc)
	return doc, err
}

// claudeGlobalConfigPath is Claude Code's ~/.claude.json: in CLAUDE_CONFIG_DIR when it is set, else in the home folder.
func claudeGlobalConfigPath(env molten.AgentEnv) string {
	if env.Getenv != nil {
		if dir := env.Getenv("CLAUDE_CONFIG_DIR"); dir != "" {
			return filepath.Join(dir, claudeGlobalConfig)
		}
	}
	return filepath.Join(env.Home, claudeGlobalConfig)
}

// claudeBrowserInGlobalConfig looks for molten-browser in ~/.claude.json: at the top (user scope) and under the
// projects entry of the folder or of one of its parents (local scope).
func claudeBrowserInGlobalConfig(ctx LaunchContext) (string, error) {
	path := claudeGlobalConfigPath(ctx.Env)
	display := molten.DisplayHomePath(ctx.Env, path)
	data, err := readGlobalConfig(path)
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", errors.New(display + " could not be read")
	}
	if !bytes.Contains(data, []byte(`"`+mcpbrowser.ServerName+`"`)) {
		return "", nil
	}
	var parsed struct {
		claudeMcpDoc
		Projects map[string]claudeMcpDoc `json:"projects"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		return "", errors.New(display + " could not be read")
	}
	if parsed.hasBrowser() {
		return display, nil
	}
	cwd := filepath.Clean(ctx.Cwd)
	for folder, project := range parsed.Projects {
		if !project.hasBrowser() {
			continue
		}
		folder = filepath.Clean(folder)
		if cwd == folder || strings.HasPrefix(cwd, strings.TrimSuffix(folder, string(filepath.Separator))+string(filepath.Separator)) {
			return display + " (this project)", nil
		}
	}
	return "", nil
}

func readGlobalConfig(path string) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxGlobalConfigBytes {
		return nil, errors.New("not a regular file of a readable size")
	}
	return os.ReadFile(path)
}

// claudeBrowserInProjectFiles looks for molten-browser in the .mcp.json of the folder and of each parent, up to the
// root, as Claude Code loads them.
func claudeBrowserInProjectFiles(ctx LaunchContext) (string, error) {
	if ctx.Cwd == "" || !filepath.IsAbs(ctx.Cwd) {
		return "", nil
	}
	for dir := filepath.Clean(ctx.Cwd); ; dir = filepath.Dir(dir) {
		path := filepath.Join(dir, claudeProjectMcpFile)
		display := molten.DisplayHomePath(ctx.Env, path)
		data, err := readBounded(path)
		if err == nil {
			var doc claudeMcpDoc
			if json.Unmarshal(data, &doc) != nil {
				if bytes.Contains(data, []byte(mcpbrowser.ServerName)) {
					return "", errors.New(display + " could not be read")
				}
			} else if doc.hasBrowser() {
				return display, nil
			}
		} else if !errors.Is(err, fs.ErrNotExist) {
			return "", errors.New(display + " could not be read")
		}
		if dir == filepath.Dir(dir) {
			return "", nil
		}
	}
}

// MoltenPath is the molten command of a MoltenTerm data folder (<data>/bin/molten, a link to wsh), or "" when it is
// not installed: the browser server is then not offered. It is this same wsh, so it serves `molten mcp browser`.
func MoltenPath(dataDir string) string {
	if dataDir == "" {
		return ""
	}
	for _, candidate := range programCandidates(filepath.Join(dataDir, "bin"), shellutil.MoltenCommandName) {
		if isExecutableFile(candidate) {
			return candidate
		}
	}
	return ""
}
