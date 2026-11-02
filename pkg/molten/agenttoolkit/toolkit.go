// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package agenttoolkit lists what an agent session can use (FR-CONT-006, FR-SHELL-084, #1543): its MCP servers, its
// skills and its plugins, read-only, from the agent's own configuration files for the session's folder. Each agent's
// reader is a thin adapter (claude.go, codex.go) behind the provider-neutral Toolkit; an agent without one reports
// Supported false and the interface says it does not tell MoltenTerm.
//
// What a reader keeps is a name, a transport, a scope and a description. A server's command, arguments, URL,
// environment and headers can hold tokens: they are decoded at most to tell the transport and never leave the
// reader. No agent CLI is run (`claude mcp list` checks each server's health, which starts it and may reach the
// network), nothing is written, and the credential files (~/.claude/.credentials.json, ~/.codex/auth.json) are never
// opened. Choosing what stays usable is #550.
package agenttoolkit

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/wavetermdev/waveterm/pkg/molten"

	"gopkg.in/yaml.v3"
)

// Where an entry comes from.
const (
	ScopeUser    = "user"
	ScopeProject = "project"
	ScopeLocal   = "local"
	ScopePlugin  = "plugin"
	ScopeSystem  = "system"
)

// What the configuration says of a server; "" is configured and in use as far as the files tell.
const (
	StateNeedsApproval = "needsapproval"
	StateOff           = "off"
)

const (
	TransportStdio = "stdio"
	TransportHttp  = "http"
	TransportSse   = "sse"
)

const (
	maxServers        = 200
	maxSkills         = 400
	maxPlugins        = 200
	maxDescriptionLen = 160
	skillHeadBytes    = 16 * 1024
	maxConfigBytes    = 64 * 1024 * 1024
	skillFileName     = "SKILL.md"
)

var scopeOrder = map[string]int{ScopeUser: 0, ScopeProject: 1, ScopeLocal: 2, ScopePlugin: 3, ScopeSystem: 4}

type McpServer struct {
	Name      string `json:"name"`
	Transport string `json:"transport,omitempty"`
	Scope     string `json:"scope"`
	Plugin    string `json:"plugin,omitempty"`
	State     string `json:"state,omitempty"`
}

type Skill struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Scope       string `json:"scope"`
	Plugin      string `json:"plugin,omitempty"`
}

type Plugin struct {
	Name    string `json:"name"`
	Source  string `json:"source,omitempty"`
	Scope   string `json:"scope"`
	Enabled bool   `json:"enabled"`
}

// Toolkit is what a session can use. Online: the agent may also add servers from the user's online account, which no
// local file lists.
type Toolkit struct {
	Supported bool        `json:"supported"`
	Online    bool        `json:"online,omitempty"`
	Servers   []McpServer `json:"servers,omitempty"`
	Skills    []Skill     `json:"skills,omitempty"`
	Plugins   []Plugin    `json:"plugins,omitempty"`
}

// Env is what a reader may read: the agent's configuration folders, never a credential.
type Env = molten.AgentEnv

// Reader lists an agent's toolkit for a session started in cwd.
type Reader func(env Env, cwd string) Toolkit

var readers = map[string]Reader{
	molten.AgentIdClaude: ReadClaude,
	molten.AgentIdCodex:  ReadCodex,
}

// ReaderFor returns the reader of an agent id, nil when the agent does not tell.
func ReaderFor(agent string) Reader {
	return readers[agent]
}

func envOr(env Env, name string, fallback string) string {
	if env.Getenv != nil {
		if value := env.Getenv(name); value != "" {
			return value
		}
	}
	return fallback
}

// projectDirs lists cwd and its parents up to the repository's root (the first folder holding .git), never above the
// home folder, nearest first. A relative or empty cwd has none.
func projectDirs(env Env, cwd string) []string {
	if cwd == "" || !filepath.IsAbs(cwd) {
		return nil
	}
	home := filepath.Clean(env.Home)
	var rtn []string
	for dir := filepath.Clean(cwd); ; dir = filepath.Dir(dir) {
		if dir == home {
			break
		}
		rtn = append(rtn, dir)
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			break
		}
		if dir == filepath.Dir(dir) {
			break
		}
	}
	return rtn
}

func readConfig(path string) []byte {
	f := openRegular(path, maxConfigBytes)
	if f == nil {
		return nil
	}
	defer f.Close()
	data, err := readConfigLimit(f, maxConfigBytes)
	if err != nil {
		return nil
	}
	return data
}

func readConfigLimit(r io.Reader, max int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > max {
		return nil, errors.New("config exceeds size limit")
	}
	return data, nil
}

// Symlinked skills are supported; validate the target before and after a nonblocking open to avoid a FIFO swap.
func openRegular(path string, maxSize int64) *os.File {
	before, err := os.Stat(path)
	if err != nil || !before.Mode().IsRegular() || (maxSize > 0 && before.Size() > maxSize) {
		return nil
	}
	f, err := openNoBlock(path)
	if err != nil {
		return nil
	}
	after, err := f.Stat()
	if err != nil || !after.Mode().IsRegular() || !os.SameFile(before, after) || (maxSize > 0 && after.Size() > maxSize) {
		f.Close()
		return nil
	}
	return f
}

type skillHead struct {
	Name        string `yaml:"name"`
	Description string `yaml:"description"`
}

// readSkills lists the skills of a folder: each sub-folder holding a SKILL.md, named by its front matter (or the
// folder), with its description cut to one short line.
func readSkills(dir string, scope string, plugin string) []Skill {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var rtn []Skill
	for _, e := range entries {
		if !e.IsDir() && e.Type()&os.ModeSymlink == 0 {
			continue
		}
		path := filepath.Join(dir, e.Name(), skillFileName)
		head, ok := readSkillHead(path)
		if !ok {
			continue
		}
		name := strings.TrimSpace(head.Name)
		if name == "" {
			name = e.Name()
		}
		rtn = append(rtn, Skill{Name: name, Description: oneLine(head.Description), Scope: scope, Plugin: plugin})
	}
	return rtn
}

func readSkillHead(path string) (skillHead, bool) {
	f := openRegular(path, 0)
	if f == nil {
		return skillHead{}, false
	}
	defer f.Close()
	buf := make([]byte, skillHeadBytes)
	n, _ := f.Read(buf)
	data := bytes.TrimLeft(bytes.TrimPrefix(buf[:n], []byte("\xef\xbb\xbf")), " \t\r\n")
	var head skillHead
	if !bytes.HasPrefix(data, []byte("---")) {
		return head, true
	}
	rest := data[3:]
	end := bytes.Index(rest, []byte("\n---"))
	if end < 0 {
		return head, true
	}
	if err := yaml.Unmarshal(rest[:end], &head); err != nil {
		return skillHead{}, true
	}
	return head, true
}

// oneLine keeps a description's first sentence-sized line: whitespace folded, cut on a word near maxDescriptionLen.
func oneLine(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) <= maxDescriptionLen {
		return s
	}
	runes := []rune(s)[:maxDescriptionLen]
	cut := string(runes)
	if i := strings.LastIndexByte(cut, ' '); i > maxDescriptionLen/2 {
		cut = cut[:i]
	}
	return strings.TrimRight(cut, " ,.;:") + "…"
}

// finish orders the lists (scope, then name), drops duplicates (the nearest declaration wins, as the agents resolve
// them) and caps them.
func finish(tk Toolkit) Toolkit {
	tk.Supported = true
	seenServer := map[string]bool{}
	var servers []McpServer
	for _, s := range tk.Servers {
		key := s.Plugin + "\x00" + s.Name
		if s.Name == "" || seenServer[key] {
			continue
		}
		seenServer[key] = true
		servers = append(servers, s)
	}
	sort.SliceStable(servers, func(i, j int) bool { return less(servers[i].Scope, servers[i].Name, servers[j].Scope, servers[j].Name) })
	tk.Servers = capped(servers, maxServers)
	seenSkill := map[string]bool{}
	var skills []Skill
	for _, s := range tk.Skills {
		key := s.Plugin + "\x00" + s.Name
		if seenSkill[key] {
			continue
		}
		seenSkill[key] = true
		skills = append(skills, s)
	}
	sort.SliceStable(skills, func(i, j int) bool { return less(skills[i].Scope, skills[i].Name, skills[j].Scope, skills[j].Name) })
	tk.Skills = capped(skills, maxSkills)
	sort.SliceStable(tk.Plugins, func(i, j int) bool { return strings.ToLower(tk.Plugins[i].Name) < strings.ToLower(tk.Plugins[j].Name) })
	tk.Plugins = capped(tk.Plugins, maxPlugins)
	return tk
}

func less(scopeA, nameA, scopeB, nameB string) bool {
	if scopeOrder[scopeA] != scopeOrder[scopeB] {
		return scopeOrder[scopeA] < scopeOrder[scopeB]
	}
	return strings.ToLower(nameA) < strings.ToLower(nameB)
}

func capped[T any](list []T, max int) []T {
	if len(list) > max {
		return list[:max]
	}
	return list
}

// splitPluginKey reads "name@marketplace".
func splitPluginKey(key string) (string, string) {
	name, source, _ := strings.Cut(key, "@")
	return name, source
}
