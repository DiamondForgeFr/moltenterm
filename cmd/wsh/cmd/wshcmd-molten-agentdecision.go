// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten/handoffwire"
)

// Settling an agent's stop (#1876, FR-REV-022 AC20): an agent that stopped for a decision shows "waits for you" in the
// Integration panel. When the lead (or the developer, from a terminal) has decided it without that agent's terminal,
// `molten agent decision settle` says so: the panel stops asking the developer and keeps a "settled by" line. The
// command names a ticket or an agent's first name and nothing of any agent's own tooling, so it is the same for every
// agent CLI. It carries this pane's WAVETERM_JWT to wavesrv's handoff route, which takes the settler from it.

const moltenSettleTimeoutMs = 15000

var moltenDecisionSettleNote string

var moltenAgentDecisionCmd = &cobra.Command{
	Use:   "decision",
	Short: "the decisions an agent's stop asks for: settle one the lead or you already made",
	Args:  cobra.NoArgs,
	RunE:  func(cmd *cobra.Command, args []string) error { return cmd.Help() },
}

var moltenAgentDecisionSettleCmd = &cobra.Command{
	Use:   "settle <ticket|agent>",
	Short: "say that the stop question of an agent (or of the agents on a ticket) is decided, so the Integration panel stops asking the developer",
	Long: "An agent that stopped for a decision (\"stopped for a decision: …\") shows as waiting for the developer in the\n" +
		"Integration panel. When you, the lead, decided it without that agent's terminal (you marked its pull request\n" +
		"ready, you fixed what it asked about, you told it in another way), settle it: the card leaves \"Needs you\" for the\n" +
		"section its pull request belongs to and keeps one line, \"settled by <you>: <note>\".\n\n" +
		"<ticket> is the ticket number the card shows (1872 or #1872): the agents of your project working on that\n" +
		"ticket's branch whose stop is open. <agent> is an agent's first name (see molten agent list). --note says why in\n" +
		"one line (200 characters at most), shown as written. A settlement belongs to the stop it answers: if the agent\n" +
		"works again or stops for another reason, the developer is asked again. It fails, saying why, when nothing waits\n" +
		"on the target or when the agent is blocked on a prompt of its own terminal (answer that one there, or with\n" +
		"molten agent send). You cannot settle your own stop. Run it from a MoltenTerm terminal.",
	Example: "  molten agent decision settle 1872 --note \"Backend is flaky, #1874 fixes it: go on\"\n" +
		"  molten agent decision settle Julien --note \"marked the PR ready myself\"",
	Args:    cobra.ExactArgs(1),
	RunE:    moltenWrap(moltenAgentDecisionSettleRun),
	PreRunE: preRunSetupRpcClient,
}

func init() {
	moltenAgentDecisionSettleCmd.Flags().StringVar(&moltenDecisionSettleNote, "note", "", "why it is decided, in one line")
	moltenAgentDecisionSettleCmd.Flags().BoolVar(&moltenJson, "json", false, "print the result as JSON")
	moltenAgentDecisionCmd.AddCommand(moltenAgentDecisionSettleCmd)
	moltenAgentCmd.AddCommand(moltenAgentDecisionCmd)
}

// formatMoltenSettled: what the settle did, in English (agents parse it).
func formatMoltenSettled(res handoffwire.SettleResult) string {
	names := make([]string, 0, len(res.Settled))
	for _, a := range res.Settled {
		names = append(names, a.FirstName)
	}
	who := "you"
	if res.By != "" {
		who = res.By
	}
	text := fmt.Sprintf("Settled the stop of %s, as %s.", strings.Join(names, ", "), who)
	if res.Note != "" {
		text += " Note: " + res.Note
	}
	return text + " The Integration panel no longer asks the developer about it; a new stop asks again."
}

func moltenAgentDecisionSettleRun(cmd *cobra.Command, args []string) error {
	token, err := moltenHandoffToken()
	if err != nil {
		return err
	}
	var result handoffwire.SettleResult
	err = moltenHandoffRequest(handoffwire.SettleCommand, handoffwire.SettleRequest{Token: token, Target: args[0], Note: moltenDecisionSettleNote}, moltenSettleTimeoutMs, &result)
	if err != nil {
		return fmt.Errorf("%s", moltenHandoffError(err))
	}
	if moltenJson {
		return moltenWriteJson(result)
	}
	WriteStdout("%s\n", formatMoltenSettled(result))
	return nil
}
