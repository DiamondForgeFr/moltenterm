// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package agentchoice is the coding agent MoltenTerm starts for a project (#845): every flow that starts or runs an
// agent on its own (the reviews' investigate, rebase, restart and batch merge, the assisted review, the release notes)
// asks Resolve instead of keeping its own order. The developer chooses in a panel's options: per project, with a global
// default; with no choice the registry's order applies (the first installed). A chosen agent that is not installed is
// reported, never replaced by another one behind the developer's back.
package agentchoice

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

const (
	// SettingKey is the global default (settings.json), ProjectsMetaKey the client meta that holds each project's
	// choice by folder ({"/path/to/project": "codex"}).
	SettingKey      = "moltenterm:codingagent"
	ProjectsMetaKey = "moltenterm:codingagents"

	// Where the agent of a resolution comes from.
	SourceRun     = "run"
	SourceProject = "project"
	SourceGlobal  = "global"
	SourceOrder   = "order"

	// EnvVar names the resolved agent for the commands Mission Control runs (a project's release steps call `molten
	// release notes`); MissingEnvVar names the chosen agent when it is not installed.
	EnvVar        = "MOLTEN_CODING_AGENT"
	MissingEnvVar = "MOLTEN_CODING_AGENT_MISSING"
)

// Supported lists the agents the flows can start, in the default order: the ones with a non-interactive form and a
// review flow today.
var Supported = []string{molten.AgentIdClaude, molten.AgentIdCodex}

// Agent is one agent the flows can start, and whether it is installed on this computer.
type Agent struct {
	Id        string `json:"id"`
	Name      string `json:"name"`
	Installed bool   `json:"installed"`
}

// Choice is the agent a flow starts for a project. Agent is "" when none can start: none is installed, or the chosen
// one is not (Missing, Chosen names it).
type Choice struct {
	Agent      string  `json:"agent,omitempty"`
	AgentName  string  `json:"agentname,omitempty"`
	Source     string  `json:"source,omitempty"`
	Chosen     string  `json:"chosen,omitempty"`
	ChosenName string  `json:"chosenname,omitempty"`
	Missing    bool    `json:"missing,omitempty"`
	Project    string  `json:"project,omitempty"`
	Global     string  `json:"global,omitempty"`
	Order      string  `json:"order,omitempty"`
	Agents     []Agent `json:"agents"`
}

// Resolver reads the choices and what is installed; the tests give fakes.
type Resolver struct {
	// Order: the agent ids in the preferred order (agentcontinuity's registry); Supported when empty.
	Order     []string
	Installed func(id string) bool
	Global    func() string
	Project   func(dir string) string
}

// IsSupported tells whether the flows can start the agent.
func IsSupported(id string) bool {
	for _, s := range Supported {
		if s == id {
			return true
		}
	}
	return false
}

func (r Resolver) installed(id string) bool {
	return r.Installed != nil && r.Installed(id)
}

func (r Resolver) order() []string {
	var rtn []string
	for _, id := range r.Order {
		if IsSupported(id) {
			rtn = append(rtn, id)
		}
	}
	if len(rtn) == 0 {
		return Supported
	}
	return rtn
}

func validChoice(id string) string {
	id = strings.TrimSpace(id)
	if IsSupported(id) {
		return id
	}
	return ""
}

// Resolve is the agent to start in dir: run (the developer's pick for this run), else the project's choice, else the
// global default, else the first installed in the order.
func (r Resolver) Resolve(dir string, run string) Choice {
	c := Choice{Agents: []Agent{}}
	for _, id := range r.order() {
		ok := r.installed(id)
		c.Agents = append(c.Agents, Agent{Id: id, Name: molten.AgentDisplayName(id), Installed: ok})
		if ok && c.Order == "" {
			c.Order = id
		}
	}
	if r.Project != nil && dir != "" {
		c.Project = validChoice(r.Project(dir))
	}
	if r.Global != nil {
		c.Global = validChoice(r.Global())
	}
	switch {
	case validChoice(run) != "":
		c.Chosen, c.Source = validChoice(run), SourceRun
	case c.Project != "":
		c.Chosen, c.Source = c.Project, SourceProject
	case c.Global != "":
		c.Chosen, c.Source = c.Global, SourceGlobal
	default:
		c.Source = SourceOrder
		c.Agent = c.Order
	}
	if c.Chosen != "" {
		c.ChosenName = molten.AgentDisplayName(c.Chosen)
		if r.installed(c.Chosen) {
			c.Agent = c.Chosen
		} else {
			c.Missing = true
		}
	}
	if c.Agent != "" {
		c.AgentName = molten.AgentDisplayName(c.Agent)
	}
	return c
}

// Explicit: the developer chose the agent (for the project, everywhere or for this run), not the order.
func (c Choice) Explicit() bool {
	return c.Chosen != ""
}

// InstalledNames lists the installed agents' names.
func (c Choice) InstalledNames() []string {
	var rtn []string
	for _, a := range c.Agents {
		if a.Installed {
			rtn = append(rtn, a.Name)
		}
	}
	return rtn
}

// MissingText says, in English, that the chosen agent is not installed and what is.
func (c Choice) MissingText() string {
	where := "chosen for this project"
	switch c.Source {
	case SourceGlobal:
		where = "chosen as the default agent"
	case SourceRun:
		where = "chosen for this run"
	}
	text := fmt.Sprintf("%s, the coding agent %s, is not installed on this computer", c.ChosenName, where)
	if names := c.InstalledNames(); len(names) > 0 {
		return text + ": choose " + strings.Join(names, " or ") + " in the panel's options (Agent), or install " + c.ChosenName
	}
	return text + ", and no other supported agent is"
}

// NoneText says that no supported agent is installed.
func NoneText() string {
	return "No supported coding agent is installed on this computer"
}

// PrintArgv is the agent's non-interactive form, prompt on its standard input and answer on its standard output.
func PrintArgv(id string) []string {
	switch id {
	case molten.AgentIdClaude:
		return []string{"claude", "-p"}
	case molten.AgentIdCodex:
		return []string{"codex", "exec", "-"}
	}
	return nil
}

// ProjectKeys are the folders a project's choice may be stored under for dir: dir itself and, for a linked worktree,
// the main checkout it belongs to (an agent's worktree follows its project's choice).
func ProjectKeys(dir string) []string {
	if dir == "" {
		return nil
	}
	dir = filepath.Clean(dir)
	keys := []string{dir}
	if main := mainCheckout(dir); main != "" && main != dir {
		keys = append(keys, main)
	}
	return keys
}

// mainCheckout: the main checkout of the linked worktree that holds dir, "" when dir is not in one. A linked
// worktree's .git is a file "gitdir: <main>/.git/worktrees/<name>".
func mainCheckout(dir string) string {
	for d := dir; ; {
		info, err := os.Lstat(filepath.Join(d, ".git"))
		if err == nil {
			if info.IsDir() {
				return ""
			}
			data, err := os.ReadFile(filepath.Join(d, ".git"))
			if err != nil {
				return ""
			}
			gitdir, ok := strings.CutPrefix(strings.TrimSpace(string(data)), "gitdir:")
			if !ok {
				return ""
			}
			gitdir = strings.TrimSpace(gitdir)
			if !filepath.IsAbs(gitdir) {
				gitdir = filepath.Join(d, gitdir)
			}
			worktrees := filepath.Dir(filepath.Clean(gitdir))
			if filepath.Base(worktrees) != "worktrees" {
				return ""
			}
			return filepath.Dir(filepath.Dir(worktrees))
		}
		parent := filepath.Dir(d)
		if parent == d {
			return ""
		}
		d = parent
	}
}

// ProjectChoiceIn reads a project's choice from the client meta's map, by dir then by its main checkout.
func ProjectChoiceIn(projects map[string]any, dir string) string {
	if projects == nil {
		return ""
	}
	for _, key := range ProjectKeys(dir) {
		if id, ok := projects[key].(string); ok && validChoice(id) != "" {
			return id
		}
	}
	return ""
}

// RunEnv is what a command Mission Control runs is told of the project's agent: EnvVar when one can start,
// MissingEnvVar when the chosen one is not installed.
func (c Choice) RunEnv() []string {
	if c.Missing {
		return []string{MissingEnvVar + "=" + c.Chosen}
	}
	if c.Agent != "" {
		return []string{EnvVar + "=" + c.Agent}
	}
	return nil
}
