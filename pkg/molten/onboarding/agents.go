// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package onboarding

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/wavetermdev/waveterm/pkg/molten"
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

// The pages the step links to when no agent is found; checked on 2026-10-12.
var agentInstallPages = map[string]string{
	"claude-code": "https://code.claude.com/docs/en/setup",
	"codex":       "https://developers.openai.com/codex/cli",
	"gemini-cli":  "https://github.com/google-gemini/gemini-cli",
	"qwen-code":   "https://github.com/QwenLM/qwen-code",
	"kimi":        "https://github.com/MoonshotAI/kimi-cli",
}

type AgentEntry struct {
	molten.AgentStatus
	Executable  string `json:"executable,omitempty"`
	Found       bool   `json:"found"`
	FoundPath   string `json:"foundpath,omitempty"`
	InstallPage string `json:"installpage,omitempty"`
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
			AgentStatus: profile.Status(env),
			Executable:  profile.Executable,
			InstallPage: agentInstallPages[profile.Id],
		}
		if profile.Executable != "" {
			entry.FoundPath = molten.LookPathIn(profile.Executable, pathList)
			entry.Found = entry.FoundPath != ""
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
		return molten.AgentStatus{}, fmt.Errorf("%s was not declined: MoltenTerm installs its guides at start", profile.Name)
	}
	_, installErr := profile.Install(env, version)
	if err := molten.SetAgentDeclined(env.DataDir, profile.Id, false); err != nil {
		installErr = errors.Join(installErr, err)
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
	env, err := agentEnv()
	if err != nil {
		return nil, err
	}
	return ListAgents(env, molten.LoginPath(), wavebase.WaveVersion), nil
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
