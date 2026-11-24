// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"context"
	"fmt"
	"os"
	"time"

	goproc "github.com/shirou/gopsutil/v4/process"
	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/proctree"
)

// `molten agent identity` (#2514) prints the SaaSFoundryAI identity of the coding agent that runs it: the id to pass
// to `saasfoundryai agents route --provider`. The agent is the nearest one among the command's parent processes (the
// agent whose shell tool runs it), else the one MOLTENTERM_SF_AGENT names. The id comes from SaaSFoundryAI's own agent
// catalog when it is installed, else from the catalog wavesrv saved, else from MoltenTerm's built-in mapping. Its
// output is English: agents parse it.

const (
	moltenIdentityFromProcess = "process"
	moltenIdentityFromEnv     = "env"

	moltenCatalogLive    = "saasfoundryai"
	moltenCatalogCached  = "cached"
	moltenCatalogBuiltin = "builtin"

	moltenIdentityArgsTimeout = 2 * time.Second
)

// MoltenAgentIdentity is `molten agent identity --json`.
type MoltenAgentIdentity struct {
	// Identity: the SaaSFoundryAI id. Agent and Name: MoltenTerm's id and name of the agent found by its process.
	Identity string `json:"identity"`
	Agent    string `json:"agent,omitempty"`
	Name     string `json:"name,omitempty"`
	Source   string `json:"source"`
	Catalog  string `json:"catalog"`
}

var moltenAgentIdentityCmd = &cobra.Command{
	Use:   "identity",
	Short: "print the SaaSFoundryAI identity of the coding agent running this command (for saasfoundryai agents route --provider)",
	Long: "Print the SaaSFoundryAI identity of the coding agent that runs this command: the id to pass to " +
		"`saasfoundryai agents route --provider`, never MoltenTerm's own agent name. The agent is the nearest one " +
		"among this command's parent processes, else the one $" + molten.SfAgentEnvVar + " names. The id comes " +
		"from SaaSFoundryAI's agent catalog when it is installed, else from MoltenTerm's built-in mapping " +
		"(claude-code, codex, kimi, gemini-cli, qwen-code). Fails when no agent runs it or the agent has no " +
		"SaaSFoundryAI profile. See agent-integrations.md in the folder `molten docs` prints.",
	Args: cobra.NoArgs,
	RunE: moltenAgentIdentityRun,
}

func init() {
	moltenAgentIdentityCmd.Flags().BoolVar(&moltenJson, "json", false, "print the result as JSON")
	moltenAgentCmd.AddCommand(moltenAgentIdentityCmd)
}

func moltenAgentIdentityRun(cmd *cobra.Command, args []string) error {
	catalog, source := moltenSfCatalog()
	found, ok := moltenCallingAgent()
	identity, err := resolveMoltenAgentIdentity(found, ok, os.Getenv(molten.SfAgentEnvVar), catalog)
	if err != nil {
		return err
	}
	identity.Catalog = source
	if moltenJson {
		return moltenWriteJson(identity)
	}
	WriteStdout("%s\n", identity.Identity)
	return nil
}

// resolveMoltenAgentIdentity names the identity of the agent found by its process, else of the environment's.
func resolveMoltenAgentIdentity(found molten.AgentProcess, ok bool, envValue string, catalog []molten.SfAgentProfile) (MoltenAgentIdentity, error) {
	if ok {
		name := molten.AgentDisplayName(found.Agent)
		id := molten.SfAgentIdIn(found.Agent, catalog)
		if id == "" {
			return MoltenAgentIdentity{}, fmt.Errorf("%s has no SaaSFoundryAI identity: SaaSFoundryAI's agent catalog does not list it", name)
		}
		return MoltenAgentIdentity{Identity: id, Agent: found.Agent, Name: name, Source: moltenIdentityFromProcess}, nil
	}
	if molten.ValidAgentId(envValue) {
		return MoltenAgentIdentity{Identity: envValue, Source: moltenIdentityFromEnv}, nil
	}
	return MoltenAgentIdentity{}, fmt.Errorf("no coding agent runs this command, and %s is not set: ask the user which coding agent this session is", molten.SfAgentEnvVar)
}

// moltenSfCatalog reads SaaSFoundryAI's catalog with the pane's PATH, else the one wavesrv saved; nil for the built-in
// mapping.
func moltenSfCatalog() ([]molten.SfAgentProfile, string) {
	if profiles, err := molten.LoadSfCatalog(context.Background(), os.Getenv("PATH")); err == nil {
		return profiles, moltenCatalogLive
	}
	if dataDir, err := moltenGetPath("data"); err == nil {
		if profiles, err := molten.ReadSfCatalogCache(dataDir); err == nil && len(profiles) > 0 {
			return profiles, moltenCatalogCached
		}
	}
	return nil, moltenCatalogBuiltin
}

// moltenCallingAgent finds the agent among this command's parent processes.
func moltenCallingAgent() (molten.AgentProcess, bool) {
	table, err := proctree.Read()
	if err != nil {
		return molten.AgentProcess{}, false
	}
	return molten.FindCallingAgent(table, int32(os.Getpid()), moltenReadIdentityArgs)
}

// The executable comes from proctree: gopsutil hands libproc a buffer on the goroutine's stack on macOS (#249).
func moltenReadIdentityArgs(pid int32) (string, []string) {
	ctx, cancel := context.WithTimeout(context.Background(), moltenIdentityArgsTimeout)
	defer cancel()
	args, _ := (&goproc.Process{Pid: pid}).CmdlineSliceWithContext(ctx)
	return proctree.Exe(pid), args
}
