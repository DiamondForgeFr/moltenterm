// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package onboarding

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
)

// The Library's agent pages (FR-SHELL-088 #1699, FR-ONB-002): the catalog's links and profile (agentfacts.go) and
// Uninstall. Uninstall runs only the vendor's documented command for the way the copy found was installed, recognised
// from where its executable lives, through the install's job (clinstall.go): the window sends the agent's id and a
// tick, never a command, and the first-run route answers windows only. The user's own settings and sign-in folders go
// only when ticked, only where the vendor documents deleting them, and to the system trash (trash.go), never deleted.

// must match frontend/moltenterm-onboarding/onboarding-install-model.ts
const CliUninstallCommand = "onboardingcliuninstall"

// TestUninstallDirEnv names a folder of fake uninstallers, <agent id>.sh, run in place of the catalog's commands, as
// TestInstallDirEnv does for installs. The script gets --config when the settings folders are ticked.
const TestUninstallDirEnv = "MOLTENTERM_TEST_AGENT_UNINSTALL_DIR"

const (
	UninstallNative = "native"
	UninstallNpm    = "npm"
	UninstallBrew   = "brew"
	UninstallUv     = "uv"
	UninstallScript = "script"
	UninstallTest   = "test"
)

// uninstallMethod is one way an agent gets installed and how its vendor removes it. A method matches the copy found
// when its resolved path contains Resolved (a "~/" prefix is the home folder and must start the path), or when the
// found path is Found and Has exists. Command is the vendor's, verbatim; empty when the vendor documents none
// (Documented false: the page shows the reverse of the install as a manual way, never as a button).
type uninstallMethod struct {
	Method     string
	Resolved   string
	Found      string
	Has        string
	Command    string
	Documented bool
	Removes    []string
	Source     string
}

type agentRemoval struct {
	Methods []uninstallMethod
	// The settings and sign-in folders the vendor says to delete for a full removal: never touched unticked.
	Config       []string
	ConfigSource string
	// the i18n key saying in plain words what those folders hold
	ConfigHolds string
}

// Checked on 2026-11-01 (#1697's research, the vendors' pages and install scripts): only Claude Code, Gemini CLI,
// Kimi Code and Qwen Code document an uninstall (Kimi's script install only in words). The others' methods are the
// reverse of their install, shown by hand only. Qwen's standalone qwen is a wrapper script, not a link: its runtime
// folder is checked instead.
var agentRemovalCatalog = map[string]agentRemoval{
	"claude-code": {
		Methods: []uninstallMethod{
			{Method: UninstallNative, Resolved: "~/.local/share/claude/", Documented: true,
				Command: "rm -f ~/.local/bin/claude && rm -rf ~/.local/share/claude",
				Removes: []string{"~/.local/bin/claude", "~/.local/share/claude"},
				Source:  "https://code.claude.com/docs/en/setup#uninstall-claude-code"},
			{Method: UninstallBrew, Resolved: "/Caskroom/claude-code", Documented: true,
				Command: "brew uninstall --cask claude-code",
				Removes: []string{"Homebrew cask claude-code"},
				Source:  "https://code.claude.com/docs/en/setup#uninstall-claude-code"},
			{Method: UninstallNpm, Resolved: "/node_modules/@anthropic-ai/claude-code/", Documented: true,
				Command: "npm uninstall -g @anthropic-ai/claude-code",
				Removes: []string{"npm package @anthropic-ai/claude-code"},
				Source:  "https://code.claude.com/docs/en/setup#uninstall-claude-code"},
		},
		Config:       []string{"~/.claude", "~/.claude.json"},
		ConfigSource: "https://code.claude.com/docs/en/setup#uninstall-claude-code",
		ConfigHolds:  "library.agents.uninstall.holds.claude-code",
	},
	"qwen-code": {
		Methods: []uninstallMethod{
			{Method: UninstallNative, Found: "~/.local/bin/qwen", Has: "~/.local/lib/qwen-code", Documented: true,
				Command: "curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/uninstall-qwen-standalone.sh | bash",
				Removes: []string{"~/.local/bin/qwen", "~/.local/lib/qwen-code"},
				Source:  "https://qwenlm.github.io/qwen-code-docs/en/users/support/Uninstall/"},
			{Method: UninstallNpm, Resolved: "/node_modules/@qwen-code/qwen-code/", Documented: true,
				Command: "npm uninstall -g @qwen-code/qwen-code",
				Removes: []string{"npm package @qwen-code/qwen-code"},
				Source:  "https://qwenlm.github.io/qwen-code-docs/en/users/support/Uninstall/"},
		},
		// The uninstaller keeps ~/.qwen; the page says to delete it by hand for a full removal.
		Config:       []string{"~/.qwen"},
		ConfigSource: "https://qwenlm.github.io/qwen-code-docs/en/users/support/Uninstall/",
		ConfigHolds:  "library.agents.uninstall.holds.qwen-code",
	},
	"kimi": {
		Methods: []uninstallMethod{
			{Method: UninstallNpm, Resolved: "/node_modules/@moonshot-ai/kimi-code/", Documented: true,
				Command: "npm uninstall -g @moonshot-ai/kimi-code",
				Removes: []string{"npm package @moonshot-ai/kimi-code"},
				Source:  "https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started"},
			// "Delete the kimi executable": documented, but as words, not a command.
			{Method: UninstallScript, Resolved: "~/.kimi-code/", Documented: true,
				Source: "https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started"},
		},
		Config:       []string{"~/.kimi-code"},
		ConfigSource: "https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/data-locations.html",
		ConfigHolds:  "library.agents.uninstall.holds.kimi",
	},
	"codex": {
		Methods: []uninstallMethod{
			{Method: UninstallNpm, Resolved: "/node_modules/@openai/codex/", Command: "npm uninstall -g @openai/codex"},
			{Method: UninstallBrew, Resolved: "/Caskroom/codex", Command: "brew uninstall --cask codex"},
		},
	},
	// ~/.gemini is shared with Antigravity CLI: never offered as Gemini CLI's own settings.
	"gemini-cli": {
		Methods: []uninstallMethod{
			{Method: UninstallNpm, Resolved: "/node_modules/@google/gemini-cli/", Documented: true,
				Command: "npm uninstall -g @google/gemini-cli",
				Removes: []string{"npm package @google/gemini-cli"},
				Source:  "https://www.geminicli.com/docs/resources/uninstall"},
			{Method: UninstallBrew, Resolved: "/Cellar/gemini-cli/", Documented: true,
				Command: "brew uninstall gemini-cli",
				Removes: []string{"Homebrew formula gemini-cli"},
				Source:  "https://www.geminicli.com/docs/resources/uninstall"},
		},
	},
	molten.AgentIdCopilot: {
		Methods: []uninstallMethod{
			{Method: UninstallNpm, Resolved: "/node_modules/@github/copilot/", Command: "npm uninstall -g @github/copilot"},
			{Method: UninstallBrew, Resolved: "/Caskroom/copilot-cli", Command: "brew uninstall --cask copilot-cli"},
		},
	},
	molten.AgentIdVibe: {
		Methods: []uninstallMethod{
			{Method: UninstallUv, Resolved: "/uv/tools/mistral-vibe/", Command: "uv tool uninstall mistral-vibe"},
		},
	},
}

// AgentUninstall is one way out, as the page shows it; Available only for the method that matches the copy found
// and has a documented command.
type AgentUninstall struct {
	Method         string   `json:"method"`
	Command        string   `json:"command,omitempty"`
	Documented     bool     `json:"documented,omitempty"`
	Removes        []string `json:"removes,omitempty"`
	Source         string   `json:"source,omitempty"`
	Config         []string `json:"config,omitempty"`
	ConfigSource   string   `json:"configsource,omitempty"`
	ConfigHoldsKey string   `json:"configholdskey,omitempty"`
	Available      bool     `json:"available,omitempty"`
}

type cliUninstallRequest struct {
	Id           string `json:"id"`
	RemoveConfig bool   `json:"removeconfig,omitempty"`
}

func homePath(home string, p string) string {
	if p == "~" {
		return home
	}
	if strings.HasPrefix(p, "~/") {
		return filepath.Join(home, p[2:])
	}
	return p
}

func (m uninstallMethod) matches(home string, foundPath string, resolved string) bool {
	if m.Resolved != "" {
		if strings.HasPrefix(m.Resolved, "~/") {
			prefix := homePath(home, m.Resolved)
			// the resolved path goes through the home folder's own links too (/var is /private/var)
			realPrefix := prefix
			if realHome, err := filepath.EvalSymlinks(home); err == nil {
				realPrefix = homePath(realHome, m.Resolved)
			}
			if strings.HasPrefix(resolved, prefix) || strings.HasPrefix(resolved, realPrefix) ||
				strings.HasPrefix(foundPath, prefix) {
				return true
			}
		} else if strings.Contains(filepath.ToSlash(resolved), m.Resolved) {
			return true
		}
	}
	if m.Found != "" && foundPath == homePath(home, m.Found) {
		if m.Has == "" {
			return true
		}
		_, err := os.Stat(homePath(home, m.Has))
		return err == nil
	}
	return false
}

func (r agentRemoval) view(m uninstallMethod) AgentUninstall {
	rtn := AgentUninstall{
		Method:     m.Method,
		Command:    m.Command,
		Documented: m.Documented,
		Removes:    m.Removes,
		Source:     m.Source,
	}
	if m.Documented {
		rtn.Config = r.Config
		rtn.ConfigSource = r.ConfigSource
		rtn.ConfigHoldsKey = r.ConfigHolds
	}
	return rtn
}

func testUninstallScript(id string) string {
	dir := os.Getenv(TestUninstallDirEnv)
	if dir == "" {
		return ""
	}
	script := filepath.Join(dir, id+".sh")
	if _, err := os.Stat(script); err != nil {
		return ""
	}
	return script
}

// matchUninstall is the method of the copy found at foundPath; ok false when none matches.
func matchUninstall(id string, home string, foundPath string) (AgentUninstall, bool) {
	if foundPath == "" {
		return AgentUninstall{}, false
	}
	if script := testUninstallScript(id); script != "" {
		return AgentUninstall{
			Method:         UninstallTest,
			Command:        "sh " + shellQuote(script),
			Documented:     true,
			Removes:        []string{foundPath},
			Config:         agentRemovalCatalog[id].Config,
			ConfigHoldsKey: agentRemovalCatalog[id].ConfigHolds,
			Available:      true,
		}, true
	}
	resolved, err := filepath.EvalSymlinks(foundPath)
	if err != nil {
		resolved = foundPath
	}
	removal := agentRemovalCatalog[id]
	for _, m := range removal.Methods {
		if !m.matches(home, foundPath, resolved) {
			continue
		}
		rtn := removal.view(m)
		rtn.Available = m.Documented && m.Command != ""
		return rtn, true
	}
	return AgentUninstall{}, false
}

// uninstallMethods lists every way the catalog knows, for the manual instructions.
func uninstallMethods(id string) []AgentUninstall {
	removal := agentRemovalCatalog[id]
	var rtn []AgentUninstall
	for _, m := range removal.Methods {
		rtn = append(rtn, removal.view(m))
	}
	return rtn
}

// configTrash is what runs once the command succeeded when the settings folders are ticked: they go to the system
// trash, never deleted. A fake uninstaller's settings live in its own folder's home, never the developer's.
func configTrash(u AgentUninstall, home string, removeConfig bool) func() ([]string, *trashFailure) {
	if !removeConfig || len(u.Config) == 0 {
		return nil
	}
	if u.Method == UninstallTest {
		home = filepath.Join(os.Getenv(TestUninstallDirEnv), "home")
	}
	return func() ([]string, *trashFailure) {
		return trashAll(home, u.Config)
	}
}

// StartCliUninstall finds the agent's copy again on the login PATH and runs its method's documented command. The
// window's word is only the id: what runs is decided here.
func StartCliUninstall(id string, removeConfig bool) (CliInstallStatus, error) {
	profile, err := molten.FindAgent(id)
	if err != nil {
		return CliInstallStatus{}, err
	}
	if runtime.GOOS == "windows" {
		return CliInstallStatus{}, uimsg.Errorf(uimsg.Make("onboarding.uninstallUnsupported", "agent", profile.Name),
			"uninstalling %s from MoltenTerm is not available on this system", profile.Name)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return CliInstallStatus{}, err
	}
	foundPath := ""
	if profile.Executable != "" {
		foundPath = molten.LookPathIn(profile.Executable, molten.LoginPath())
	}
	u, ok := matchUninstall(profile.Id, home, foundPath)
	if !ok || !u.Available {
		return CliInstallStatus{}, uimsg.Errorf(uimsg.Make("onboarding.noUninstallCommand", "agent", profile.Name),
			"MoltenTerm has no documented uninstall for this copy of %s", profile.Name)
	}
	return startCliJob(profile.Id, CliJobUninstall, u.Command, configTrash(u, home, removeConfig))
}

func handleCliUninstall(ctx context.Context, source string, data any) (any, error) {
	var req cliUninstallRequest
	if err := utilfn.ReUnmarshal(&req, data); err != nil {
		return nil, err
	}
	if req.Id == "" {
		return nil, fmt.Errorf("no agent id")
	}
	return StartCliUninstall(req.Id, req.RemoveConfig)
}

func init() {
	HandleCommand(CliUninstallCommand, handleCliUninstall)
}
