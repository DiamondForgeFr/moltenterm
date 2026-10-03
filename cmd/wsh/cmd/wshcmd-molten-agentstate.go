// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// Coding agents' hooks report their state to the pane they run in (FR-SHELL-011): `molten agent state waiting` from
// Claude Code's Notification hook, `done` from its Stop hook, and so on (pkg/molten/agentdocs/agent-states.md).

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
	RunE:    moltenWrap(moltenAgentStateRun),
	PreRunE: preRunSetupRpcClient,
}

func init() {
	moltenAgentStateCmd.Flags().StringVar(&moltenAgentStateAgent, "agent", "", "the agent: claude, codex, gemini, opencode, or another short name")
	moltenAgentStateCmd.Flags().StringVar(&moltenAgentStateMessage, "message", "", "a short text for the notification")
	moltenAgentStateCmd.Flags().BoolVar(&moltenAgentStateStdin, "stdin", false, "read the hook's JSON input on stdin and use its message")
	moltenAgentCmd.AddCommand(moltenAgentStateCmd)
}

// moltenHookMessage reads the "message" field of a hook's JSON input (Claude Code's Notification hook).
func moltenHookMessage(r io.Reader) string {
	data, err := io.ReadAll(io.LimitReader(r, moltenAgentStateMaxStdin))
	if err != nil {
		return ""
	}
	var input struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(data, &input) != nil {
		return ""
	}
	return input.Message
}

func moltenAgentStateRun(cmd *cobra.Command, args []string) error {
	state := args[0]
	if !molten.ValidAgentState(state) {
		return fmt.Errorf("unknown state %q (working, waiting, done, error or idle)", state)
	}
	if moltenAgentStateAgent != "" && !molten.ValidAgentId(moltenAgentStateAgent) {
		return fmt.Errorf("invalid agent name %q (lowercase letters, digits and dashes)", moltenAgentStateAgent)
	}
	blockId := RpcContext.BlockId
	if blockId == "" {
		blockId = os.Getenv("WAVETERM_BLOCKID")
	}
	if blockId == "" {
		return fmt.Errorf("not in a MoltenTerm terminal")
	}
	message := moltenAgentStateMessage
	if moltenAgentStateStdin && message == "" {
		message = moltenHookMessage(os.Stdin)
	}
	req := molten.AgentStateRequest{BlockId: blockId, State: state, Agent: moltenAgentStateAgent, Message: message}
	_, err := RpcClient.SendRpcRequest(molten.AgentStateSetCommand, req, &wshrpc.RpcOpts{Route: molten.AgentStatesRoute, Timeout: moltenAgentStateTimeoutMs})
	return err
}
