// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agenthook"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// Coding agents' hooks report their state to the pane they run in (FR-SHELL-011): `molten agent state waiting` from
// Claude Code's Notification hook, `done` from its Stop hook, and so on (pkg/molten/agentdocs/agent-states.md).
// The small molten program (cmd/molten) runs this command itself and hands wsh only the forms it does not read the
// same way (help, mistakes); both send with pkg/molten/agenthook (FR-PERF-012).

const moltenAgentStateTimeoutMs = 5000
const moltenAgentStateMaxStdin = 64 * 1024

var moltenAgentStateAgent string
var moltenAgentStateMessage string
var moltenAgentStateStdin bool

var moltenAgentStateCmd = &cobra.Command{
	Use:   "state <working|waiting|done|error|idle> [payload]",
	Short: "report the state of the coding agent running in this terminal (for the agent's hooks)",
	Long: "Report the state of the coding agent running in this terminal; its pane header, tab and workspace show it, " +
		"and waiting or done raise a notification. Meant for the agents' hooks: see agent-states.md in the folder " +
		"`molten docs` prints. A trailing payload (Codex's notify argument) is ignored.",
	Args:    cobra.RangeArgs(1, 2),
	RunE:    moltenHookWrap(moltenAgentStateRun),
	PreRunE: preRunCheckJwt,
}

func init() {
	moltenAgentStateCmd.Flags().StringVar(&moltenAgentStateAgent, "agent", "", "the agent: claude, codex, gemini, opencode, or another short name")
	moltenAgentStateCmd.Flags().StringVar(&moltenAgentStateMessage, "message", "", "a short text for the notification")
	moltenAgentStateCmd.Flags().BoolVar(&moltenAgentStateStdin, "stdin", false, "read the hook's JSON input on stdin and use its message")
	moltenAgentCmd.AddCommand(moltenAgentStateCmd)
}

func moltenAgentStateRun(cmd *cobra.Command, args []string) error {
	state := args[0]
	if !molten.ValidAgentState(state) {
		return fmt.Errorf("unknown state %q (working, waiting, done, error or idle)", state)
	}
	if moltenAgentStateAgent != "" && !molten.ValidAgentId(moltenAgentStateAgent) {
		return fmt.Errorf("invalid agent name %q (lowercase letters, digits and dashes)", moltenAgentStateAgent)
	}
	token := os.Getenv(wshutil.WaveJwtTokenVarName)
	blockId := os.Getenv("WAVETERM_BLOCKID")
	if claims, err := agenthook.ParseTokenClaims(token); err == nil && claims.BlockId != "" {
		blockId = claims.BlockId
	}
	if blockId == "" {
		return fmt.Errorf("not in a MoltenTerm terminal")
	}
	message := moltenAgentStateMessage
	if moltenAgentStateStdin {
		// A Notification that asks nothing (#784: idle_prompt) leaves the state as it is.
		var send bool
		if message, send = agenthook.StateReport(state, message, os.Stdin); !send {
			return nil
		}
	}
	req := agenthook.AgentStateRequest{BlockId: blockId, State: state, Agent: moltenAgentStateAgent, Message: message}
	return agenthook.SendAgentState(token, req)
}
