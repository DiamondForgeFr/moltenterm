// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/agentdocs"
)

// The molten guides for every coding agent (FR-MORPH-006, DS-MORPH-006; FR-MC-008): `/molten-feature` turns a request
// into a mod, `/molten-pipeline` connects a project to Mission Control. The agents follow the SaaSFoundryAI agent
// catalog (`sf agents catalog`). Each guide (agentdocs/*.md) is rendered into each agent's own format, at user level
// so it works in every folder. Paths and invocations were checked against each agent's documentation on 2026-10-01;
// they change with the agents, so each profile keeps them in one place.

const AgentGuideName = "molten-feature"
const PipelineGuideName = "molten-pipeline"
const agentRequestPlaceholder = "{{REQUEST}}"
const agentDescription = "Turn a plain-language request into a Moltenterm mod with the molten command"

type AgentGuide struct {
	Name         string
	Description  string
	File         string
	ArgumentHint string
}

var AgentGuides = []AgentGuide{
	{
		Name:         AgentGuideName,
		Description:  agentDescription,
		File:         agentdocs.GuideFile,
		ArgumentHint: "<what you want in your workspace>",
	},
	{
		Name:         PipelineGuideName,
		Description:  "Connect this project to Moltenterm's Mission Control: reuse its scripts and CI, create what is missing, write .molten/project.json",
		File:         agentdocs.PipelineGuideFile,
		ArgumentHint: "[what to connect or create]",
	},
}

// Every file molten writes carries this marker, so that `molten agent remove` only deletes its own files.
var agentMarkerRegex = regexp.MustCompile(`molten-[a-z]+ v(\S+), installed by molten agent install`)

type AgentEnv struct {
	Home    string
	DataDir string
	Getenv  func(string) string
}

type AgentProfile struct {
	Id   string
	Name string
	// {name} is the guide's name, <request> what the user adds.
	Invocation string
	Format     string
	path       func(env AgentEnv, name string) string
	render     func(guide AgentGuide, body string, marker string) string
}

type AgentGuideStatus struct {
	Name       string `json:"name"`
	Path       string `json:"path"`
	Invocation string `json:"invocation"`
	Installed  bool   `json:"installed"`
	Version    string `json:"version,omitempty"`
	// A file molten did not write is at the install path; molten leaves it alone.
	Foreign bool `json:"foreign,omitempty"`
}

// The top-level fields describe molten-feature, the first guide; Guides lists every guide.
type AgentStatus struct {
	Id         string             `json:"id"`
	Name       string             `json:"name"`
	Path       string             `json:"path"`
	Invocation string             `json:"invocation"`
	Format     string             `json:"format"`
	Installed  bool               `json:"installed"`
	Version    string             `json:"version,omitempty"`
	Foreign    bool               `json:"foreign,omitempty"`
	Guides     []AgentGuideStatus `json:"guides"`
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

func skillFrontmatter(guide AgentGuide, extra ...string) []string {
	return append([]string{"name: " + guide.Name, "description: " + guide.Description}, extra...)
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
		Invocation: "/{name} <request>",
		Format:     "skill",
		path: func(env AgentEnv, name string) string {
			return filepath.Join(envOr(env, "CLAUDE_CONFIG_DIR", filepath.Join(env.Home, ".claude")), "skills", name, "SKILL.md")
		},
		render: func(guide AgentGuide, body string, marker string) string {
			body = strings.ReplaceAll(body, agentRequestPlaceholder, "$ARGUMENTS")
			return markdownWithFrontmatter(skillFrontmatter(guide, "argument-hint: "+guide.ArgumentHint, "disable-model-invocation: true"), marker, body)
		},
	},
	{
		Id:         "codex",
		Name:       "Codex",
		Invocation: "${name} <request>",
		Format:     "skill",
		path: func(env AgentEnv, name string) string {
			return filepath.Join(env.Home, ".agents", "skills", name, "SKILL.md")
		},
		render: func(guide AgentGuide, body string, marker string) string {
			body = strings.ReplaceAll(body, agentRequestPlaceholder, "The request is the text the user wrote after `$"+guide.Name+"` in their message.")
			return markdownWithFrontmatter(skillFrontmatter(guide), marker, body)
		},
	},
	{
		Id:         "gemini-cli",
		Name:       "Gemini CLI",
		Invocation: "/{name} <request>",
		Format:     "custom command",
		path: func(env AgentEnv, name string) string {
			return filepath.Join(env.Home, ".gemini", "commands", name+".toml")
		},
		render: func(guide AgentGuide, body string, marker string) string {
			body = strings.ReplaceAll(body, agentRequestPlaceholder, "{{args}}")
			return fmt.Sprintf("# %s\ndescription = %q\nprompt = \"\"\"\n%s\"\"\"\n", marker, guide.Description, tomlMultiline(body))
		},
	},
	{
		Id:         "qwen-code",
		Name:       "Qwen Code",
		Invocation: "/{name} <request>",
		Format:     "custom command",
		path: func(env AgentEnv, name string) string {
			return filepath.Join(env.Home, ".qwen", "commands", name+".md")
		},
		render: func(guide AgentGuide, body string, marker string) string {
			body = strings.ReplaceAll(body, agentRequestPlaceholder, "{{args}}")
			return markdownWithFrontmatter([]string{"description: " + guide.Description}, marker, body)
		},
	},
	{
		Id:         "kimi",
		Name:       "Kimi Code",
		Invocation: "/skill:{name} <request>",
		Format:     "skill",
		path: func(env AgentEnv, name string) string {
			return filepath.Join(envOr(env, "KIMI_CODE_HOME", filepath.Join(env.Home, ".kimi-code")), "skills", name, "SKILL.md")
		},
		render: func(guide AgentGuide, body string, marker string) string {
			body = strings.ReplaceAll(body, agentRequestPlaceholder, "$ARGUMENTS")
			return markdownWithFrontmatter(skillFrontmatter(guide), marker, body)
		},
	},
	{
		Id:         "generic",
		Name:       "Generic coding agent",
		Invocation: "Read <path> and follow it with my request: <request>",
		Format:     "instruction file",
		path: func(env AgentEnv, name string) string {
			return filepath.Join(env.DataDir, "molten", "agents", name+".md")
		},
		render: func(guide AgentGuide, body string, marker string) string {
			body = strings.ReplaceAll(body, agentRequestPlaceholder, "The request is in the message that pointed you to this file.")
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

func agentMarker(guide string, version string, agentId string) string {
	return fmt.Sprintf("%s v%s, installed by molten agent install %s; molten agent remove %s deletes it", guide, version, agentId, agentId)
}

func FindGuide(name string) (AgentGuide, error) {
	for _, guide := range AgentGuides {
		if guide.Name == name {
			return guide, nil
		}
	}
	return AgentGuide{}, fmt.Errorf("unknown guide %q", name)
}

func GuideSource() (string, error) {
	return guideSource(AgentGuides[0])
}

func guideSource(guide AgentGuide) (string, error) {
	data, err := agentdocs.Files.ReadFile(guide.File)
	return string(data), err
}

// Path is where molten-feature goes; GuidePath where any guide goes.
func (p AgentProfile) Path(env AgentEnv) string {
	return p.path(env, AgentGuideName)
}

func (p AgentProfile) GuidePath(env AgentEnv, guide AgentGuide) string {
	return p.path(env, guide.Name)
}

func (p AgentProfile) Render(version string) (string, error) {
	return p.RenderGuide(AgentGuides[0], version)
}

func (p AgentProfile) RenderGuide(guide AgentGuide, version string) (string, error) {
	body, err := guideSource(guide)
	if err != nil {
		return "", err
	}
	return p.render(guide, body, agentMarker(guide.Name, version, p.Id)), nil
}

func (p AgentProfile) guideInvocation(guide AgentGuide, path string) string {
	invocation := strings.ReplaceAll(p.Invocation, "{name}", guide.Name)
	return strings.ReplaceAll(invocation, "<path>", path)
}

func (p AgentProfile) GuideStatus(env AgentEnv, guide AgentGuide) AgentGuideStatus {
	path := p.GuidePath(env, guide)
	status := AgentGuideStatus{Name: guide.Name, Path: path, Invocation: p.guideInvocation(guide, path)}
	data, err := os.ReadFile(path)
	if err != nil {
		return status
	}
	match := agentMarkerRegex.FindSubmatch(data)
	if match == nil || !strings.Contains(string(data), guide.Name+" v") {
		status.Foreign = true
		return status
	}
	status.Installed = true
	status.Version = string(match[1])
	return status
}

func (p AgentProfile) Status(env AgentEnv) AgentStatus {
	status := AgentStatus{Id: p.Id, Name: p.Name, Format: p.Format}
	for _, guide := range AgentGuides {
		status.Guides = append(status.Guides, p.GuideStatus(env, guide))
	}
	first := status.Guides[0]
	status.Path = first.Path
	status.Invocation = first.Invocation
	status.Installed = first.Installed
	status.Version = first.Version
	status.Foreign = first.Foreign
	return status
}

func (p AgentProfile) installGuide(env AgentEnv, guide AgentGuide, version string) error {
	path := p.GuidePath(env, guide)
	if status := p.GuideStatus(env, guide); status.Foreign {
		return fmt.Errorf("%s exists and was not written by molten; move it away first", path)
	}
	content, err := p.RenderGuide(guide, version)
	if err != nil {
		return err
	}
	err = os.MkdirAll(filepath.Dir(path), 0755)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	err = os.WriteFile(tmp, []byte(content), 0644)
	if err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Install writes every guide for the agent; a guide whose path holds someone else's file is skipped and reported.
func (p AgentProfile) Install(env AgentEnv, version string) (string, error) {
	var errs []error
	for _, guide := range AgentGuides {
		if err := p.installGuide(env, guide, version); err != nil {
			errs = append(errs, err)
		}
	}
	return p.Path(env), errors.Join(errs...)
}

func (p AgentProfile) removeGuide(env AgentEnv, guide AgentGuide) (bool, error) {
	path := p.GuidePath(env, guide)
	status := p.GuideStatus(env, guide)
	if status.Foreign {
		return false, fmt.Errorf("%s was not written by molten; it is left alone", path)
	}
	if !status.Installed {
		return false, nil
	}
	if err := os.Remove(path); err != nil {
		return false, err
	}
	// A skill lives in its own folder: remove it too once empty.
	if p.Format == "skill" {
		os.Remove(filepath.Dir(path))
	}
	return true, nil
}

// Remove deletes every guide molten wrote for the agent; removed is true when one was there.
func (p AgentProfile) Remove(env AgentEnv) (string, bool, error) {
	var errs []error
	removed := false
	for _, guide := range AgentGuides {
		ok, err := p.removeGuide(env, guide)
		if err != nil {
			errs = append(errs, err)
		}
		removed = removed || ok
	}
	return p.Path(env), removed, errors.Join(errs...)
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
		if path == agentdocs.GuideFile || path == agentdocs.PipelineGuideFile {
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
