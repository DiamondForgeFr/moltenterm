// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"io"
	"os"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten/agenthook"
)

// Claude Code's status line relay (FR-SHELL-027, DS-SHELL-031). Claude Code runs it as its statusLine command:
// it runs the user's own status line command with the same input and environment, so what Claude Code shows does not
// change, and in a MoltenTerm terminal it also hands the input's rate limit windows, and nothing else, to the pane's
// companion. Outside MoltenTerm it only runs the command. It never prints anything of its own: any failure of the
// hand-off is ignored, the status line is the user's.
// The relay itself is in pkg/molten/agenthook, which the small molten program (cmd/molten) runs without wsh
// (FR-PERF-012); wsh runs it for `wsh molten agent statusline` and where molten is wsh (Windows).

// The whole hand-off, connection included, never holds the status line longer than this.
const moltenStatusLineSendTimeout = agenthook.StatusLineSendTimeout

var moltenAgentStatusLineCmd = &cobra.Command{
	Use:   "statusline [-- <command> [args...]]",
	Short: "Claude Code's statusLine relay: runs your status line command unchanged and shows the plan limits in the companion",
	Long: "Meant as Claude Code's statusLine command, wrapping your own: it runs <command> (one argument runs through " +
		"sh -c) with the same input and environment and passes its output and exit code through unchanged. In a " +
		"MoltenTerm terminal it also hands the input's rate_limits (5-hour and 7-day windows) to the agent companion's " +
		"plan usage. Without a command it prints nothing. The companion shows the setting to paste when you turn on " +
		"Show plan usage; MoltenTerm never edits Claude Code's settings.",
	DisableFlagParsing: true,
	RunE:               moltenAgentStatusLineRun,
}

func init() {
	moltenAgentCmd.AddCommand(moltenAgentStatusLineCmd)
}

func moltenAgentStatusLineRun(cmd *cobra.Command, args []string) error {
	if len(args) > 0 && (args[0] == "-h" || args[0] == "--help") {
		return cmd.Help()
	}
	if len(args) > 0 && args[0] == "--" {
		args = args[1:]
	}
	WshExitCode = runStatusLineRelay(os.Stdin, os.Stdout, os.Stderr, args, moltenStatusLineSender())
	return nil
}

type statusLineSender = agenthook.StatusLineSender

// moltenStatusLineSender sends to the companion of the terminal the relay runs in, or is nil outside MoltenTerm.
func moltenStatusLineSender() statusLineSender {
	return agenthook.MakeStatusLineSender(os.Getenv, agenthook.StatusLineCacheDir())
}

func runStatusLineRelay(stdin io.Reader, stdout io.Writer, stderr io.Writer, args []string, send statusLineSender) int {
	return agenthook.RunStatusLineRelay(stdin, stdout, stderr, args, send)
}

func runStatusLineCommand(args []string, stdin io.Reader, stdout io.Writer, stderr io.Writer) int {
	return agenthook.RunStatusLineCommand(args, stdin, stdout, stderr)
}
