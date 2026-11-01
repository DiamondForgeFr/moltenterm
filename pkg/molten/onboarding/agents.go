// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package onboarding

import (
	"context"
	"errors"
	"os"
	"path/filepath"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

// Step 1 of the first run, "Your agent" (FR-ONB-002, DS-ONB-002): the catalog's agents, which of them the login
// shell's PATH has, and the molten guides MoltenTerm installed for them at start (DS-ONB-006, agentguides.go). The
// step writes only when the user wants a declined agent back. Step 2, "Your first morph" (FR-ONB-003, DS-ONB-003),
// starts the chosen agent in a scratch folder of its own, so a first request never lands in a project.

// must match frontend/moltenterm-onboarding/onboarding-agent-model.ts
const (
	AgentsCommand       = "onboardingagents"
	AgentInstallCommand = "onboardingagentinstall"
	MorphDirCommand     = "onboardingmorphdir"
)

type agentInstall struct {
	Page string
	// The official commands, the first the one Install runs (FR-ONB-007 AC-5): the only commands MoltenTerm ever runs
	// to install an agent, looked up here by agent id.
	Commands []string
	// The vendor's page to sign in or create an account and pick a plan (#1680).
	SignInPage string
	// The files whose mere existence the vendor documents as a sign-in (#1680), relative to the agent's folder; nil when
	// the sign-in lives in the system keychain or nowhere documented. MoltenTerm never opens them and never starts the
	// agent to ask: a file found means signed in, none found means it cannot tell.
	Credentials func(env molten.AgentEnv) []string
}

// credentialsIn is the agent folder's files: under the folder an environment variable names, else under home.
func credentialsIn(envVar string, homeDir string, files ...string) func(env molten.AgentEnv) []string {
	return func(env molten.AgentEnv) []string {
		dir := filepath.Join(env.Home, homeDir)
		if env.Getenv != nil && env.Getenv(envVar) != "" {
			dir = env.Getenv(envVar)
		}
		var rtn []string
		for _, f := range files {
			rtn = append(rtn, filepath.Join(dir, f))
		}
		return rtn
	}
}

// signedIn tells whether one of the agent's documented credentials files exists; a pattern may name several (Kimi
// Code keeps one file per account).
func signedIn(env molten.AgentEnv, install agentInstall) bool {
	if install.Credentials == nil {
		return false
	}
	for _, pattern := range install.Credentials(env) {
		matches, err := filepath.Glob(pattern)
		if err != nil {
			continue
		}
		for _, m := range matches {
			if info, err := os.Stat(m); err == nil && info.Mode().IsRegular() {
				return true
			}
		}
	}
	return false
}

// The install catalog, pages and commands together so they cannot drift; checked against the vendors' pages on
// 2026-10-31 (Kimi Code's page moved off the kimi-cli repository, archived on 2026-09-23), and on 2026-11-01 for the
// subscription CLIs of #1680 (Antigravity CLI replaced Gemini CLI for personal Google accounts on 2026-06-18, Gemini
// CLI's README says; Gemini CLI stays for Code Assist Standard/Enterprise and paid API keys). The scripts come first:
// they need no Node.js or Python.
var agentInstallCatalog = map[string]agentInstall{
	"claude-code": {
		Page:       "https://code.claude.com/docs/en/setup",
		Commands:   []string{"curl -fsSL https://claude.ai/install.sh | bash"},
		SignInPage: "https://claude.com/pricing",
		// macOS keeps it in the keychain: the file only proves a sign-in, its absence nothing.
		Credentials: credentialsIn("CLAUDE_CONFIG_DIR", ".claude", ".credentials.json"),
	},
	"codex": {
		Page:       "https://learn.chatgpt.com/docs/codex/cli",
		Commands:   []string{"curl -fsSL https://chatgpt.com/codex/install.sh | sh", "npm i -g @openai/codex"},
		SignInPage: "https://learn.chatgpt.com/docs/pricing",
		// cli_auth_credentials_store may put it in the keyring instead.
		Credentials: credentialsIn("CODEX_HOME", ".codex", "auth.json"),
	},
	"gemini-cli": {
		Page:       "https://github.com/google-gemini/gemini-cli",
		Commands:   []string{"npm install -g @google/gemini-cli"},
		SignInPage: "https://codeassist.google/products/business",
	},
	"qwen-code": {
		Page: "https://github.com/QwenLM/qwen-code",
		Commands: []string{
			"curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash",
			"npm install -g @qwen-code/qwen-code@latest",
		},
		// Qwen OAuth's free tier ended on 2026-04-15: Alibaba Cloud's Coding Plan or a key, kept in settings files.
		SignInPage: "https://modelstudio.console.alibabacloud.com/?tab=coding-plan#/efm/coding-plan-index",
	},
	"kimi": {
		Page:        "https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started",
		Commands:    []string{"curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash"},
		SignInPage:  "https://www.kimi.com/membership/pricing",
		Credentials: credentialsIn("KIMI_CODE_HOME", ".kimi-code", filepath.Join("credentials", "*.json")),
	},
	molten.AgentIdAntigravity: {
		Page:     "https://antigravity.google/docs/install?tab=cli",
		Commands: []string{"curl -fsSL https://antigravity.google/cli/install.sh | bash"},
		// The sign-in lives in the system keychain only.
		SignInPage: "https://antigravity.google/pricing",
	},
	molten.AgentIdCopilot: {
		Page: "https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli",
		Commands: []string{
			"curl -fsSL https://gh.io/copilot-install | bash",
			"npm install -g @github/copilot",
			"brew install --cask copilot-cli",
		},
		// The keychain by default; config.json exists without a sign-in.
		SignInPage: "https://github.com/features/copilot/plans",
	},
	molten.AgentIdCursor: {
		Page:     "https://cursor.com/docs/cli/installation",
		Commands: []string{"curl https://cursor.com/install -fsS | bash"},
		// "Stored securely" where the docs do not say.
		SignInPage: "https://cursor.com/pricing",
	},
	molten.AgentIdGrok: {
		Page:       "https://docs.x.ai/build/overview",
		Commands:   []string{"curl -fsSL https://x.ai/cli/install.sh | bash"},
		SignInPage: "https://grok.com/plans",
		// GROK_HOME holds the auth (settings reference); the official installer checks auth.json for it.
		Credentials: credentialsIn("GROK_HOME", ".grok", "auth.json"),
	},
	molten.AgentIdVibe: {
		Page:       "https://docs.mistral.ai/mistral-vibe/introduction/install",
		Commands:   []string{"curl -LsSf https://mistral.ai/vibe/install.sh | bash", "uv tool install mistral-vibe"},
		SignInPage: "https://mistral.ai/pricing",
		// An API key goes to the keyring, or to .env without one; the browser sign-in's place is not documented.
		Credentials: credentialsIn("VIBE_HOME", ".vibe", ".env"),
	},
}

type AgentEntry struct {
	molten.AgentStatus
	Executable      string   `json:"executable,omitempty"`
	Found           bool     `json:"found"`
	FoundPath       string   `json:"foundpath,omitempty"`
	InstallPage     string   `json:"installpage,omitempty"`
	InstallCommands []string `json:"installcommands,omitempty"`
	SignInPage      string   `json:"signinpage,omitempty"`
	// A credentials file the vendor documents is there; false when MoltenTerm cannot tell, never proof of the contrary.
	SignedIn bool `json:"signedin,omitempty"`
	// The Library's agent page (#1699): the vendor's links, the profile, and how the copy found comes off.
	Site             string           `json:"site,omitempty"`
	Docs             string           `json:"docs,omitempty"`
	Profile          *AgentFacts      `json:"profile,omitempty"`
	Uninstall        *AgentUninstall  `json:"uninstall,omitempty"`
	UninstallMethods []AgentUninstall `json:"uninstallmethods,omitempty"`
}

type agentsRequest struct {
	// Refresh reads the login shell's PATH again first (Check again, the check after an install).
	Refresh bool `json:"refresh,omitempty"`
}

type AgentsResult struct {
	Agents  []AgentEntry `json:"agents"`
	Version string       `json:"version"`
}

type agentInstallRequest struct {
	Id string `json:"id"`
}

// ListAgents is pure but for reading the guides' files: every profile, in the catalog's order, generic last.
func ListAgents(env molten.AgentEnv, pathList string, version string) AgentsResult {
	rtn := AgentsResult{Agents: []AgentEntry{}, Version: version}
	for _, profile := range molten.AgentProfiles {
		entry := AgentEntry{
			AgentStatus:      profile.Status(env),
			Executable:       profile.Executable,
			InstallPage:      agentInstallCatalog[profile.Id].Page,
			InstallCommands:  installCommands(profile.Id),
			SignInPage:       agentInstallCatalog[profile.Id].SignInPage,
			UninstallMethods: uninstallMethods(profile.Id),
		}
		if facts, ok := agentFactsCatalog[profile.Id]; ok {
			entry.Site = facts.Site
			entry.Docs = facts.Docs
			entry.Profile = &facts
		}
		if profile.Executable != "" {
			entry.FoundPath = molten.LookPathIn(profile.Executable, pathList)
			entry.Found = entry.FoundPath != ""
			entry.SignedIn = entry.Found && signedIn(env, agentInstallCatalog[profile.Id])
			if u, ok := matchUninstall(profile.Id, env.Home, entry.FoundPath); ok {
				entry.Uninstall = &u
			}
		}
		rtn.Agents = append(rtn.Agents, entry)
	}
	return rtn
}

// InstallDeclinedAgent brings back the guides of an agent the user removed with `molten agent remove`, as
// `molten agent install` does. Any other agent is refused: the guides of the agents found are installed at start
// (FR-ONB-006), the step itself installs nothing.
func InstallDeclinedAgent(env molten.AgentEnv, id string, version string) (molten.AgentStatus, error) {
	profile, err := molten.FindAgent(id)
	if err != nil {
		return molten.AgentStatus{}, err
	}
	if !molten.IsAgentDeclined(env.DataDir, profile.Id) {
		return molten.AgentStatus{}, uimsg.Errorf(uimsg.Make("onboarding.notDeclined", "agent", profile.Name),
			"%s was not declined: MoltenTerm installs its guides at start", profile.Name)
	}
	_, installErr := profile.Install(env, version)
	if err := molten.SetAgentDeclined(env.DataDir, profile.Id, false); err != nil {
		installErr = errors.Join(installErr, err)
	}
	if installErr != nil {
		installErr = uimsg.Errorf(uimsg.Make("onboarding.installFailed", "agent", profile.Name, "detail", installErr.Error()),
			"%w", installErr)
	}
	return profile.Status(env), installErr
}

func MorphDir(dataDir string) string {
	return filepath.Join(dataDir, "molten", "first-morph")
}

// EnsureMorphDir creates the scratch folder and returns it.
func EnsureMorphDir(dataDir string) (string, error) {
	dir := MorphDir(dataDir)
	return dir, os.MkdirAll(dir, 0755)
}

func agentEnv() (molten.AgentEnv, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return molten.AgentEnv{}, err
	}
	return molten.AgentEnv{Home: home, DataDir: wavebase.GetWaveDataDir(), Getenv: os.Getenv}, nil
}

func handleAgents(ctx context.Context, source string, data any) (any, error) {
	var req agentsRequest
	if data != nil {
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
	}
	env, err := agentEnv()
	if err != nil {
		return nil, err
	}
	path := molten.LoginPath()
	if req.Refresh {
		path = molten.RefreshLoginPath()
	}
	return ListAgents(env, path, wavebase.WaveVersion), nil
}

func handleAgentInstall(ctx context.Context, source string, data any) (any, error) {
	var req agentInstallRequest
	if err := utilfn.ReUnmarshal(&req, data); err != nil {
		return nil, err
	}
	env, err := agentEnv()
	if err != nil {
		return nil, err
	}
	return InstallDeclinedAgent(env, req.Id, wavebase.WaveVersion)
}

func handleMorphDir(ctx context.Context, source string, data any) (any, error) {
	dir, err := EnsureMorphDir(wavebase.GetWaveDataDir())
	if err != nil {
		return nil, err
	}
	return map[string]any{"path": dir}, nil
}

func init() {
	HandleCommand(AgentsCommand, handleAgents)
	HandleCommand(AgentInstallCommand, handleAgentInstall)
	HandleCommand(MorphDirCommand, handleMorphDir)
}
