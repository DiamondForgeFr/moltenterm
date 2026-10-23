// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"bytes"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agenthook"
)

// The one hook handler of Claude Code and Codex (#988, FR-SHELL-036, FR-SHELL-038): every state, session and
// sub-agent hook MoltenTerm gives them runs `molten agent hook --agent <id>`, which reads hook_event_name from the
// hook's JSON input. The small molten program (cmd/molten) runs it itself; wsh runs it the same way, through
// pkg/molten/agenthook, where molten is wsh (Windows) and for help and mistakes.

var moltenAgentHookAgent string

var moltenAgentHookCmd = &cobra.Command{
	Use:   "hook [--agent <name>]",
	Short: "report what a coding agent's hook event means for this terminal (for the agent's hooks)",
	Long: "Read a coding agent's hook input on stdin and report what its event means for this terminal: " +
		"SessionStart links the session and makes the states precise, UserPromptSubmit and PostToolUse report " +
		"working, Notification waiting, Stop done, SubagentStart and SubagentStop the sub-agents. Claude Code and " +
		"Codex send the same input. It prints nothing. See agent-states.md in the folder `molten docs` prints.",
	Args:    cobra.NoArgs,
	RunE:    moltenHookWrap(moltenAgentHookRun),
	PreRunE: preRunCheckJwt,
}

func init() {
	moltenAgentHookCmd.Flags().StringVar(&moltenAgentHookAgent, "agent", "", "the agent: claude, codex, or another short name")
	moltenAgentCmd.AddCommand(moltenAgentHookCmd)
}

func moltenAgentHookRun(cmd *cobra.Command, args []string) error {
	if moltenAgentHookAgent != "" && !molten.ValidAgentId(moltenAgentHookAgent) {
		return fmt.Errorf("invalid agent name %q (lowercase letters, digits and dashes)", moltenAgentHookAgent)
	}
	var stderr bytes.Buffer
	env := agenthook.Env{Getenv: os.Getenv, Stdin: os.Stdin, Stdout: os.Stdout, Stderr: &stderr}
	handled, code := agenthook.RunFast([]string{"agent", "hook", "--agent=" + moltenAgentHookAgent}, env)
	if !handled {
		return fmt.Errorf("not in a MoltenTerm terminal")
	}
	if code != 0 {
		return fmt.Errorf("%s", strings.TrimPrefix(strings.TrimSpace(stderr.String()), "molten: "))
	}
	return nil
}
