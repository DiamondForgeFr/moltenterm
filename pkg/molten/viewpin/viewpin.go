// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package viewpin keeps what a pinned view is made of (FR-SHELL-080): its panels and their layout, without what
// belongs to one project or one moment. A view pinned in a workspace keeps this configuration in its tab; a view
// pinned everywhere keeps one in the client, which each workspace opens on its own project: its terminals in the
// project's folder, its repository page on the project's repository, its agent panel as an empty slot that offers
// to start an agent.
package viewpin

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const (
	RouteId        = "molten:viewpin"
	CaptureCommand = "moltenviewpincapture"
	BuildCommand   = "moltenviewpinbuild"

	// RepoToken stands for the project's repository web address (https://github.com/owner/name) in a pinned page.
	RepoToken = "molten:repo"
	// AgentSlotMetaKey: a terminal that held an agent when the view was pinned; it offers to start one.
	AgentSlotMetaKey = "molten:agentslot"
	// ProjectMetaKey: the workspace's project folder, as frontend/moltenterm-shell/workspace-project.ts names it.
	ProjectMetaKey = "molten:project"

	browserTabsMetaKey = "molten:browser:tabs"
)

// Node is a view's layout: a split (Dir "row" puts its children side by side, "column" stacks them) or a panel.
// The window sends panels by BlockId; a configuration names them by their index in Config.Panes.
type Node struct {
	Dir      string `json:"dir,omitempty"`
	Children []Node `json:"children,omitempty"`
	BlockId  string `json:"blockid,omitempty"`
	Pane     *int   `json:"pane,omitempty"`
}

// Config is a pinned view's configuration: its layout and each panel's meta.
type Config struct {
	Tree  Node                  `json:"tree"`
	Panes []waveobj.MetaMapType `json:"panes"`
}

// CaptureRequest: the view to read (its tab), its layout as the window shows it, and the panels that hold an agent.
type CaptureRequest struct {
	WorkspaceId string   `json:"workspaceid"`
	TabId       string   `json:"tabid"`
	Tree        Node     `json:"tree"`
	AgentBlocks []string `json:"agentblocks,omitempty"`
}

// BuildRequest makes a view from a configuration, on the workspace's project: a new tab (TabId empty, named Name,
// with TabMeta) or, in place of its panels, an existing one (back to the pinned state).
type BuildRequest struct {
	WorkspaceId string              `json:"workspaceid"`
	TabId       string              `json:"tabid,omitempty"`
	Name        string              `json:"name,omitempty"`
	TabMeta     waveobj.MetaMapType `json:"tabmeta,omitempty"`
	Config      Config              `json:"config"`
}

type BuildResult struct {
	TabId string `json:"tabid"`
}

// The keys a panel keeps besides its MoltenTerm ones: what it shows, not where or when.
var keptKeys = map[string]bool{
	waveobj.MetaKey_View:       true,
	waveobj.MetaKey_Controller: true,
	waveobj.MetaKey_Url:        true,
	waveobj.MetaKey_File:       true,
	waveobj.MetaKey_Connection: true,
	waveobj.MetaKey_FrameTitle: true,
	waveobj.MetaKey_FrameIcon:  true,
	waveobj.MetaKey_Cmd:        true,
	waveobj.MetaKey_CmdArgs:    true,
	"term:fontsize":            true,
	"term:fontfamily":          true,
	"term:theme":               true,
	"term:mode":                true,
}

// MoltenTerm keys that belong to one moment or one agent, never to a configuration.
var droppedPrefixes = []string{
	molten.BrowserOpenKeyPrefix,
	molten.BrowserCloseKeyPrefix,
	"molten:browser:ask",
	"molten:browser:keepfocus",
	"molten:browser:notice",
	"molten:browser:recent",
	"molten:origin",
	"molten:agenttab",
	"molten:pipelineterm",
	"molten:splitfrom",
	"molten:focusblock",
	"molten:openertab",
	"molten:companion:block",
	"molten:worktree",
	"molten:review",
	AgentSlotMetaKey,
}

func keptKey(key string) bool {
	if keptKeys[key] {
		return true
	}
	if !strings.HasPrefix(key, "molten:") {
		return false
	}
	for _, p := range droppedPrefixes {
		if strings.HasPrefix(key, p) {
			return false
		}
	}
	return true
}

func isTerm(meta waveobj.MetaMapType) bool {
	return meta.GetString(waveobj.MetaKey_View, "") == "term"
}

// PaneConfig is what a panel keeps in a configuration. An agent's terminal becomes an agent slot; a page of the
// project's repository names it by RepoToken, so another project opens its own.
func PaneConfig(meta waveobj.MetaMapType, agent bool, repoUrl string) waveobj.MetaMapType {
	if agent && isTerm(meta) {
		rtn := waveobj.MetaMapType{waveobj.MetaKey_View: "term", waveobj.MetaKey_Controller: "shell", AgentSlotMetaKey: true}
		if conn := meta.GetString(waveobj.MetaKey_Connection, ""); conn != "" {
			rtn[waveobj.MetaKey_Connection] = conn
		}
		return rtn
	}
	rtn := waveobj.MetaMapType{}
	for k, v := range meta {
		if v == nil || !keptKey(k) {
			continue
		}
		rtn[k] = v
	}
	if url, ok := rtn[waveobj.MetaKey_Url].(string); ok {
		rtn[waveobj.MetaKey_Url] = tokenizeUrl(url, repoUrl)
	}
	if tabs, ok := rtn[browserTabsMetaKey].([]any); ok {
		rtn[browserTabsMetaKey] = mapTabUrls(tabs, func(url string) string { return tokenizeUrl(url, repoUrl) })
	}
	return rtn
}

func tokenizeUrl(url string, repoUrl string) string {
	if repoUrl == "" || len(url) < len(repoUrl) || !strings.EqualFold(url[:len(repoUrl)], repoUrl) {
		return url
	}
	rest := url[len(repoUrl):]
	if rest != "" && !strings.HasPrefix(rest, "/") && !strings.HasPrefix(rest, "?") && !strings.HasPrefix(rest, "#") {
		return url
	}
	return RepoToken + rest
}

// resolveUrl gives a pinned page's address on a project; a repository page on a project without one opens the
// GitHub home page.
func resolveUrl(url string, repoUrl string) string {
	if !strings.HasPrefix(url, RepoToken) {
		return url
	}
	if repoUrl == "" {
		return "https://github.com"
	}
	return repoUrl + strings.TrimPrefix(url, RepoToken)
}

func mapTabUrls(tabs []any, fn func(string) string) []any {
	rtn := make([]any, 0, len(tabs))
	for _, tab := range tabs {
		m, ok := tab.(map[string]any)
		if !ok {
			rtn = append(rtn, tab)
			continue
		}
		copied := map[string]any{}
		for k, v := range m {
			copied[k] = v
		}
		if url, ok := copied["url"].(string); ok {
			copied["url"] = fn(url)
		}
		rtn = append(rtn, copied)
	}
	return rtn
}

// ResolvePane gives a configured panel's meta on a project: its terminal in the project's folder, its repository
// page on the project's repository.
func ResolvePane(meta waveobj.MetaMapType, dir string, repoUrl string) waveobj.MetaMapType {
	rtn := waveobj.MetaMapType{}
	for k, v := range meta {
		rtn[k] = v
	}
	if isTerm(rtn) && dir != "" {
		rtn[waveobj.MetaKey_CmdCwd] = dir
	}
	if url, ok := rtn[waveobj.MetaKey_Url].(string); ok {
		rtn[waveobj.MetaKey_Url] = resolveUrl(url, repoUrl)
	}
	if tabs, ok := rtn[browserTabsMetaKey].([]any); ok {
		rtn[browserTabsMetaKey] = mapTabUrls(tabs, func(url string) string { return resolveUrl(url, repoUrl) })
	}
	return rtn
}

// Capture turns a view's layout into a configuration; meta reads a panel's block (false: gone, left out).
func Capture(tree Node, agents map[string]bool, repoUrl string, meta func(blockId string) (waveobj.MetaMapType, bool)) Config {
	cfg := Config{Panes: []waveobj.MetaMapType{}}
	var walk func(n Node) (Node, bool)
	walk = func(n Node) (Node, bool) {
		if len(n.Children) == 0 {
			m, ok := meta(n.BlockId)
			if n.BlockId == "" || !ok {
				return Node{}, false
			}
			idx := len(cfg.Panes)
			cfg.Panes = append(cfg.Panes, PaneConfig(m, agents[n.BlockId], repoUrl))
			return Node{Pane: &idx}, true
		}
		out := Node{Dir: splitDir(n.Dir)}
		for _, c := range n.Children {
			if cn, ok := walk(c); ok {
				out.Children = append(out.Children, cn)
			}
		}
		switch len(out.Children) {
		case 0:
			return Node{}, false
		case 1:
			return out.Children[0], true
		}
		return out, true
	}
	if root, ok := walk(tree); ok {
		cfg.Tree = root
	}
	return cfg
}

func splitDir(dir string) string {
	if dir == "column" {
		return "column"
	}
	return "row"
}

// LayoutRoot gives the configuration's tree in the shape the layout stores (reopen.LayoutLeaves reads it), its
// panels named "p<index>".
func LayoutRoot(n Node) map[string]any {
	if len(n.Children) == 0 {
		id := ""
		if n.Pane != nil {
			id = PaneBlockId(*n.Pane)
		}
		return map[string]any{"data": map[string]any{"blockId": id}}
	}
	children := make([]any, 0, len(n.Children))
	for _, c := range n.Children {
		children = append(children, LayoutRoot(c))
	}
	return map[string]any{"flexDirection": splitDir(n.Dir), "children": children}
}

func PaneBlockId(idx int) string {
	return "p" + strconv.Itoa(idx)
}

// RepoWebUrl reads the project's GitHub address from its origin remote, from the git config itself (no git run):
// "" when the folder is not a GitHub clone.
func RepoWebUrl(dir string) string {
	if dir == "" {
		return ""
	}
	return githubWebUrl(originUrl(gitConfigPath(dir)))
}

func gitConfigPath(dir string) string {
	gitPath := filepath.Join(dir, ".git")
	info, err := os.Stat(gitPath)
	if err != nil {
		return ""
	}
	if info.IsDir() {
		return filepath.Join(gitPath, "config")
	}
	// A worktree: .git names its git folder, whose commondir holds the shared config.
	data, err := os.ReadFile(gitPath)
	if err != nil {
		return ""
	}
	gitDir := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(string(data)), "gitdir:"))
	if !filepath.IsAbs(gitDir) {
		gitDir = filepath.Join(dir, gitDir)
	}
	if common, err := os.ReadFile(filepath.Join(gitDir, "commondir")); err == nil {
		c := strings.TrimSpace(string(common))
		if !filepath.IsAbs(c) {
			c = filepath.Join(gitDir, c)
		}
		return filepath.Join(c, "config")
	}
	return filepath.Join(gitDir, "config")
}

func originUrl(configPath string) string {
	if configPath == "" {
		return ""
	}
	data, err := os.ReadFile(configPath)
	if err != nil {
		return ""
	}
	return OriginUrlOf(string(data))
}

// OriginUrlOf finds remote "origin"'s url in a git config's text.
func OriginUrlOf(config string) string {
	inOrigin := false
	for _, line := range strings.Split(config, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "[") {
			inOrigin = strings.ReplaceAll(line, " ", "") == `[remote"origin"]`
			continue
		}
		if !inOrigin {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if ok && strings.TrimSpace(key) == "url" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

// githubWebUrl is the web address of a GitHub remote, "" for another host (as mission.GitHubWebUrl).
func githubWebUrl(remote string) string {
	remote = strings.TrimSuffix(strings.TrimSpace(remote), ".git")
	switch {
	case strings.HasPrefix(remote, "git@github.com:"):
		return "https://github.com/" + strings.TrimPrefix(remote, "git@github.com:")
	case strings.HasPrefix(remote, "ssh://git@github.com/"):
		return "https://github.com/" + strings.TrimPrefix(remote, "ssh://git@github.com/")
	case strings.HasPrefix(remote, "https://github.com/"):
		return remote
	}
	return ""
}
