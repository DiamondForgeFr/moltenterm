// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/agentdocs"
)

// `/molten-feature` for every coding agent (FR-MORPH-006, DS-MORPH-006). The agents follow the SaaSFoundryAI agent
// catalog (`sf agents catalog`). One guide (agentdocs/molten-feature.md) is rendered into each agent's own format,
// at user level so it works in every folder. Paths and invocations were checked against each agent's documentation
// on 2026-10-01; they change with the agents, so each profile keeps them in one place.

const AgentGuideName = "molten-feature"
const agentRequestPlaceholder = "{{REQUEST}}"
const agentDescription = "Turn a plain-language request into a Moltenterm mod with the molten command"

// Every file molten writes carries this marker, so that `molten agent remove` only deletes its own files.
var agentMarkerRegex = regexp.MustCompile(`molten-feature v(\S+), installed by molten agent install`)

type AgentEnv struct {
	Home    string
	DataDir string
	Getenv  func(string) string
}

type AgentProfile struct {
	Id         string
	Name       string
	Invocation string
	Format     string
	path       func(env AgentEnv) string
	render     func(guide string, marker string) string
}

type AgentStatus struct {
	Id         string `json:"id"`
	Name       string `json:"name"`
	Path       string `json:"path"`
	Invocation string `json:"invocation"`
	Format     string `json:"format"`
	Installed  bool   `json:"installed"`
	Version    string `json:"version,omitempty"`
	// A file molten did not write is at the install path; molten leaves it alone.
	Foreign bool `json:"foreign,omitempty"`
}

func envOr(env AgentEnv, name string, fallback string) string {
	if env.Getenv != nil {
		if value := env.Getenv(name); value != "" {
			return value
		}
	}
	return fallback
}

func markdownWithFrontmatter(frontmatter []string, marker string, body string) string {
	return "---\n" + strings.Join(frontmatter, "\n") + "\n---\n\n<!-- " + marker + " -->\n\n" + body
}

func skillFrontmatter(extra ...string) []string {
	return append([]string{"name: " + AgentGuideName, "description: " + agentDescription}, extra...)
}

// TOML multi-line basic strings treat backslashes as escapes and end at three quotes.
func tomlMultiline(text string) string {
	text = strings.ReplaceAll(text, `\`, `\\`)
	return strings.ReplaceAll(text, `"""`, `""\"`)
}

var AgentProfiles = []AgentProfile{
	{
		Id:         "claude-code",
		Name:       "Claude Code",
		Invocation: "/molten-feature <request>",
		Format:     "skill",
		path: func(env AgentEnv) string {
			return filepath.Join(envOr(env, "CLAUDE_CONFIG_DIR", filepath.Join(env.Home, ".claude")), "skills", AgentGuideName, "SKILL.md")
		},
		render: func(guide string, marker string) string {
			body := strings.ReplaceAll(guide, agentRequestPlaceholder, "$ARGUMENTS")
			return markdownWithFrontmatter(skillFrontmatter("argument-hint: <what you want in your workspace>", "disable-model-invocation: true"), marker, body)
		},
	},
	{
		Id:         "codex",
		Name:       "Codex",
		Invocation: "$molten-feature <request>",
		Format:     "skill",
		path: func(env AgentEnv) string {
			return filepath.Join(env.Home, ".agents", "skills", AgentGuideName, "SKILL.md")
		},
		render: func(guide string, marker string) string {
			body := strings.ReplaceAll(guide, agentRequestPlaceholder, "The request is the text the user wrote after `$molten-feature` in their message.")
			return markdownWithFrontmatter(skillFrontmatter(), marker, body)
		},
	},
	{
		Id:         "gemini-cli",
		Name:       "Gemini CLI",
		Invocation: "/molten-feature <request>",
		Format:     "custom command",
		path: func(env AgentEnv) string {
			return filepath.Join(env.Home, ".gemini", "commands", AgentGuideName+".toml")
		},
		render: func(guide string, marker string) string {
			body := strings.ReplaceAll(guide, agentRequestPlaceholder, "{{args}}")
			return fmt.Sprintf("# %s\ndescription = %q\nprompt = \"\"\"\n%s\"\"\"\n", marker, agentDescription, tomlMultiline(body))
		},
	},
	{
		Id:         "qwen-code",
		Name:       "Qwen Code",
		Invocation: "/molten-feature <request>",
		Format:     "custom command",
		path: func(env AgentEnv) string {
			return filepath.Join(env.Home, ".qwen", "commands", AgentGuideName+".md")
		},
		render: func(guide string, marker string) string {
			body := strings.ReplaceAll(guide, agentRequestPlaceholder, "{{args}}")
			return markdownWithFrontmatter([]string{"description: " + agentDescription}, marker, body)
		},
	},
	{
		Id:         "kimi",
		Name:       "Kimi Code",
		Invocation: "/skill:molten-feature <request>",
		Format:     "skill",
		path: func(env AgentEnv) string {
			return filepath.Join(envOr(env, "KIMI_CODE_HOME", filepath.Join(env.Home, ".kimi-code")), "skills", AgentGuideName, "SKILL.md")
		},
		render: func(guide string, marker string) string {
			body := strings.ReplaceAll(guide, agentRequestPlaceholder, "$ARGUMENTS")
			return markdownWithFrontmatter(skillFrontmatter(), marker, body)
		},
	},
	{
		Id:         "generic",
		Name:       "Generic coding agent",
		Invocation: "Read <path> and follow it with my request: <request>",
		Format:     "instruction file",
		path: func(env AgentEnv) string {
			return filepath.Join(env.DataDir, "molten", "agents", AgentGuideName+".md")
		},
		render: func(guide string, marker string) string {
			body := strings.ReplaceAll(guide, agentRequestPlaceholder, "The request is in the message that pointed you to this file.")
			return "<!-- " + marker + " -->\n\n" + body
		},
	},
}

func FindAgent(id string) (AgentProfile, error) {
	ids := []string{}
	for _, profile := range AgentProfiles {
		if profile.Id == id {
			return profile, nil
		}
		ids = append(ids, profile.Id)
	}
	return AgentProfile{}, fmt.Errorf("unknown agent %q; supported: %s", id, strings.Join(ids, ", "))
}

func agentMarker(version string, agentId string) string {
	return fmt.Sprintf("molten-feature v%s, installed by molten agent install %s; molten agent remove %s deletes it", version, agentId, agentId)
}

func GuideSource() (string, error) {
	data, err := agentdocs.Files.ReadFile(agentdocs.GuideFile)
	return string(data), err
}

func (p AgentProfile) Path(env AgentEnv) string {
	return p.path(env)
}

func (p AgentProfile) Render(version string) (string, error) {
	guide, err := GuideSource()
	if err != nil {
		return "", err
	}
	return p.render(guide, agentMarker(version, p.Id)), nil
}

func (p AgentProfile) Status(env AgentEnv) AgentStatus {
	path := p.Path(env)
	status := AgentStatus{Id: p.Id, Name: p.Name, Path: path, Invocation: p.Invocation, Format: p.Format}
	if p.Id == "generic" {
		status.Invocation = strings.ReplaceAll(p.Invocation, "<path>", path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return status
	}
	match := agentMarkerRegex.FindSubmatch(data)
	if match == nil {
		status.Foreign = true
		return status
	}
	status.Installed = true
	status.Version = string(match[1])
	return status
}

func (p AgentProfile) Install(env AgentEnv, version string) (string, error) {
	path := p.Path(env)
	if status := p.Status(env); status.Foreign {
		return path, fmt.Errorf("%s exists and was not written by molten; move it away first", path)
	}
	content, err := p.Render(version)
	if err != nil {
		return path, err
	}
	err = os.MkdirAll(filepath.Dir(path), 0755)
	if err != nil {
		return path, err
	}
	tmp := path + ".tmp"
	err = os.WriteFile(tmp, []byte(content), 0644)
	if err != nil {
		return path, err
	}
	return path, os.Rename(tmp, path)
}

func (p AgentProfile) Remove(env AgentEnv) (string, bool, error) {
	path := p.Path(env)
	status := p.Status(env)
	if status.Foreign {
		return path, false, fmt.Errorf("%s was not written by molten; it is left alone", path)
	}
	if !status.Installed {
		return path, false, nil
	}
	err := os.Remove(path)
	if err != nil {
		return path, false, err
	}
	// A skill lives in its own folder: remove it too once empty.
	if p.Format == "skill" {
		os.Remove(filepath.Dir(path))
	}
	return path, true, nil
}

// WriteDocs writes the embedded documentation into dir, replacing what a previous run left there.
func WriteDocs(dir string) error {
	return fs.WalkDir(agentdocs.Files, ".", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		target := filepath.Join(dir, filepath.FromSlash(path))
		if entry.IsDir() {
			return os.MkdirAll(target, 0755)
		}
		data, err := agentdocs.Files.ReadFile(path)
		if err != nil {
			return err
		}
		if path == agentdocs.GuideFile {
			data = []byte(strings.ReplaceAll(string(data), agentRequestPlaceholder, "(the user's request)"))
		}
		return os.WriteFile(target, data, 0644)
	})
}

func DocsDir(dataDir string, version string) string {
	if version == "" {
		version = "dev"
	}
	return filepath.Join(dataDir, "molten", "docs", version)
}
