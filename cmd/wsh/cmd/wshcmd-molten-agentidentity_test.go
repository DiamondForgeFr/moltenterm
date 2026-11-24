// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentlaunch"
)

func sfAgentEntries(env []string) []string {
	var rtn []string
	for _, entry := range env {
		if strings.HasPrefix(entry, molten.SfAgentEnvVar+"=") {
			rtn = append(rtn, entry)
		}
	}
	return rtn
}

// #2514: the launcher hands Claude Code and Codex their SaaSFoundryAI identity, replacing the one an agent whose shell
// started them carries.
func TestMoltenLaunchHandsTheSfIdentity(t *testing.T) {
	env, data := launchEnv(t)
	getenv := func(name string) string { return env[name] }
	t.Setenv(molten.SfAgentEnvVar, "kimi")
	_, _, procEnv := planMoltenAgentLaunch(agentlaunch.FindAdapter("claude"), "/real/claude", []string{"-p", "hi"}, getenv, time.Now())
	if got := sfAgentEntries(procEnv); !slices.Equal(got, []string{molten.SfAgentEnvVar + "=claude-code"}) {
		t.Errorf("Claude Code's identity: %q", got)
	}
	_, _, procEnv = planMoltenAgentLaunch(agentlaunch.FindAdapter("codex"), "/real/codex", []string{"hi"}, getenv, time.Now())
	if got := sfAgentEntries(procEnv); !slices.Equal(got, []string{molten.SfAgentEnvVar + "=codex"}) {
		t.Errorf("Codex's identity: %q", got)
	}
	stepAside := moltenLaunchIdentityEnv([]string{"HOME=/h", molten.SfAgentEnvVar + "=kimi"}, "codex", getenv)
	if !slices.Equal(stepAside, []string{"HOME=/h", molten.SfAgentEnvVar + "=codex"}) {
		t.Errorf("a run that gets nothing added still gets its identity: %q", stepAside)
	}
	if err := molten.WriteSfCatalogCache(data, []molten.SfAgentProfile{{Id: "claude", DisplayName: "Claude Code"}}); err != nil {
		t.Fatal(err)
	}
	if got := sfAgentEntries(moltenLaunchIdentityEnv(nil, "claude", getenv)); !slices.Equal(got, []string{molten.SfAgentEnvVar + "=claude"}) {
		t.Errorf("the catalog wavesrv saved wins over the built-in mapping: %q", got)
	}
}

func TestResolveMoltenAgentIdentity(t *testing.T) {
	kimi := molten.AgentProcess{Agent: molten.AgentIdKimi, Pid: 30}
	got, err := resolveMoltenAgentIdentity(kimi, true, "claude-code", nil)
	if err != nil || got.Identity != "kimi" || got.Agent != "kimi" || got.Name != "Kimi Code" || got.Source != moltenIdentityFromProcess {
		t.Errorf("Kimi Code by its process: %+v, %v", got, err)
	}
	for agent, want := range map[string]string{molten.AgentIdClaude: "claude-code", molten.AgentIdCodex: "codex"} {
		got, err := resolveMoltenAgentIdentity(molten.AgentProcess{Agent: agent}, true, "", nil)
		if err != nil || got.Identity != want {
			t.Errorf("%s: %+v, %v", agent, got, err)
		}
	}
	got, err = resolveMoltenAgentIdentity(molten.AgentProcess{}, false, "codex", nil)
	if err != nil || got.Identity != "codex" || got.Source != moltenIdentityFromEnv {
		t.Errorf("by the environment: %+v, %v", got, err)
	}
	if _, err := resolveMoltenAgentIdentity(molten.AgentProcess{}, false, "", nil); err == nil || !strings.Contains(err.Error(), "ask the user") {
		t.Errorf("no agent: %v", err)
	}
	if _, err := resolveMoltenAgentIdentity(molten.AgentProcess{}, false, "Kimi Code", nil); err == nil {
		t.Errorf("an invalid environment value is no identity")
	}
	if _, err := resolveMoltenAgentIdentity(molten.AgentProcess{Agent: molten.AgentIdOpenCode}, true, "codex", nil); err == nil || !strings.Contains(err.Error(), "OpenCode") {
		t.Errorf("an agent SaaSFoundryAI does not know: %v", err)
	}
	found, _, err := rootCmd.Find([]string{"molten", "agent", "identity"})
	if err != nil || found != moltenAgentIdentityCmd {
		t.Fatalf("identity routes to %v (%v)", found.Name(), err)
	}
}
