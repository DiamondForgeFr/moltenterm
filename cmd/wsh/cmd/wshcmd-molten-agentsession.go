// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// A coding agent's hook tells the pane it runs in which session transcript is its own (FR-SHELL-018): the agent
// companion then follows that file instead of guessing it from the folder. Claude Code's SessionStart hook passes
// transcript_path on stdin (pkg/molten/agentdocs/agent-states.md).

var moltenAgentSessionAgent string
var moltenAgentSessionStdin bool

var moltenAgentSessionCmd = &cobra.Command{
	Use:   "session [transcript-path]",
	Short: "report the session transcript of the coding agent running in this terminal (for the agent's hooks)",
	Long: "Report the session transcript of the coding agent running in this terminal, so its companion follows " +
		"that session. The path must be in the agent's own session folder. Meant for the agents' hooks: with " +
		"--stdin the path is the transcript_path field of the hook's JSON input. See agent-states.md in the folder " +
		"`molten docs` prints.",
	Args:    cobra.MaximumNArgs(1),
	RunE:    moltenWrap(moltenAgentSessionRun),
	PreRunE: preRunSetupRpcClient,
}

func init() {
	moltenAgentSessionCmd.Flags().StringVar(&moltenAgentSessionAgent, "agent", "", "the agent: claude or codex")
	moltenAgentSessionCmd.Flags().BoolVar(&moltenAgentSessionStdin, "stdin", false, "read the hook's JSON input on stdin and use its transcript_path")
	moltenAgentCmd.AddCommand(moltenAgentSessionCmd)
}

// moltenHookTranscript reads the transcript_path field of a hook's JSON input.
func moltenHookTranscript(r io.Reader) string {
	data, err := io.ReadAll(io.LimitReader(r, moltenAgentStateMaxStdin))
	if err != nil {
		return ""
	}
	var input struct {
		TranscriptPath string `json:"transcript_path"`
	}
	if json.Unmarshal(data, &input) != nil {
		return ""
	}
	return input.TranscriptPath
}

func moltenAgentSessionRun(cmd *cobra.Command, args []string) error {
	if moltenAgentSessionAgent != "" && !molten.ValidAgentId(moltenAgentSessionAgent) {
		return fmt.Errorf("invalid agent name %q (lowercase letters, digits and dashes)", moltenAgentSessionAgent)
	}
	path := ""
	if len(args) > 0 {
		path = args[0]
	}
	if path == "" && moltenAgentSessionStdin {
		path = moltenHookTranscript(os.Stdin)
	}
	if path == "" {
		return fmt.Errorf("no transcript path (give it, or use --stdin in a hook)")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	blockId := RpcContext.BlockId
	if blockId == "" {
		blockId = os.Getenv("WAVETERM_BLOCKID")
	}
	if blockId == "" {
		return fmt.Errorf("not in a MoltenTerm terminal")
	}
	req := molten.AgentSessionRequest{BlockId: blockId, Agent: moltenAgentSessionAgent, Path: abs}
	_, err = RpcClient.SendRpcRequest(molten.CompanionSessionCommand, req, &wshrpc.RpcOpts{Route: molten.CompanionRoute, Timeout: moltenAgentStateTimeoutMs})
	return err
}
