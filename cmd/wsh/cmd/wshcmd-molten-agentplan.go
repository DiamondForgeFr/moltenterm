// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentplan"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// The plan an agent publishes (#2430): `molten agent plan` keeps the steps of the agent's work in its session, whatever
// the agent is. The companion shows them as "Plan of <name>" when the agent keeps no native task list. The command
// names no agent and no provider's tool, so it is the same for every agent CLI.

const moltenAgentPlanTimeoutMs = 15000

var moltenAgentPlanCmd = &cobra.Command{
	Use:   "plan",
	Short: "publish the plan of the agent's work in this terminal, shown in the agent companion",
	Args:  cobra.NoArgs,
	RunE:  func(cmd *cobra.Command, args []string) error { return cmd.Help() },
}

var moltenAgentPlanSetCmd = moltenAgentPlanCommand("set \"<step>\" \"<step>\" ...", "replace the plan with these steps, all to do",
	"  molten agent plan set \"Read the spec\" \"Write the tests\" \"Open the PR\"", cobra.MinimumNArgs(1),
	func(args []string) (molten.AgentPlanRequest, error) {
		return molten.AgentPlanRequest{Op: agentplan.OpSet, Steps: args}, nil
	})

var moltenAgentPlanStartCmd = moltenAgentPlanCommand("start <n>", "make step n the current one (1 is the first)",
	"  molten agent plan start 2", cobra.ExactArgs(1),
	func(args []string) (molten.AgentPlanRequest, error) {
		n, err := moltenPlanIndex(args[0])
		return molten.AgentPlanRequest{Op: agentplan.OpStart, Index: n}, err
	})

var moltenAgentPlanDoneCmd = moltenAgentPlanCommand("done <n>", "mark step n done",
	"  molten agent plan done 1", cobra.ExactArgs(1),
	func(args []string) (molten.AgentPlanRequest, error) {
		n, err := moltenPlanIndex(args[0])
		return molten.AgentPlanRequest{Op: agentplan.OpDone, Index: n}, err
	})

var moltenAgentPlanAddCmd = moltenAgentPlanCommand("add \"<step>\"", "append a step to do",
	"  molten agent plan add \"Update the changelog\"", cobra.ExactArgs(1),
	func(args []string) (molten.AgentPlanRequest, error) {
		return molten.AgentPlanRequest{Op: agentplan.OpAdd, Text: args[0]}, nil
	})

var moltenAgentPlanClearCmd = moltenAgentPlanCommand("clear", "empty the plan",
	"  molten agent plan clear", cobra.NoArgs,
	func(args []string) (molten.AgentPlanRequest, error) {
		return molten.AgentPlanRequest{Op: agentplan.OpClear}, nil
	})

var moltenAgentPlanShowCmd = moltenAgentPlanCommand("show", "print the plan, its done steps and its current step",
	"  molten agent plan show --json", cobra.NoArgs,
	func(args []string) (molten.AgentPlanRequest, error) {
		return molten.AgentPlanRequest{Op: agentplan.OpShow}, nil
	})

// moltenAgentPlanSubagent: the sub-agent the call comes from (#2585). MoltenTerm's PreToolUse hook adds it to a Claude
// Code sub-agent's call (agenthook.SubagentPlanInput), since that shell has its lead's environment.
var moltenAgentPlanSubagent string

// Codex sets it in every command's environment, per thread: a sub-agent's is its own.
const codexThreadIdVar = "CODEX_THREAD_ID"

func init() {
	moltenAgentPlanCmd.PersistentFlags().StringVar(&moltenAgentPlanSubagent, agentplan.SubagentFlag, "", "the sub-agent whose own plan this is (MoltenTerm's hook sets it in a sub-agent)")
	moltenAgentPlanShowCmd.Flags().BoolVar(&moltenJson, "json", false, "print the plan as JSON")
	for _, c := range []*cobra.Command{moltenAgentPlanSetCmd, moltenAgentPlanStartCmd, moltenAgentPlanDoneCmd, moltenAgentPlanAddCmd, moltenAgentPlanClearCmd, moltenAgentPlanShowCmd} {
		moltenAgentPlanCmd.AddCommand(c)
	}
	moltenAgentCmd.AddCommand(moltenAgentPlanCmd)
}

func moltenAgentPlanCommand(use string, short string, example string, args cobra.PositionalArgs, build func([]string) (molten.AgentPlanRequest, error)) *cobra.Command {
	return &cobra.Command{
		Use:     use,
		Short:   short,
		Example: example,
		Args:    args,
		RunE: moltenWrap(func(cmd *cobra.Command, args []string) error {
			req, err := build(args)
			if err != nil {
				return err
			}
			return moltenAgentPlanRun(req)
		}),
		PreRunE: preRunSetupRpcClient,
	}
}

func moltenPlanIndex(arg string) (int, error) {
	n, err := strconv.Atoi(arg)
	if err != nil || n < 1 {
		return 0, fmt.Errorf("a step number starts at 1, not %q", arg)
	}
	return n, nil
}

// moltenAgentPlanBlock is the terminal the command runs in: the block of the pane, as `molten agent session` finds it.
func moltenAgentPlanBlock() string {
	blockId := RpcContext.BlockId
	if blockId == "" {
		blockId = os.Getenv("WAVETERM_BLOCKID")
	}
	return blockId
}

func moltenAgentPlanRun(req molten.AgentPlanRequest) error {
	req.BlockId = moltenAgentPlanBlock()
	if req.BlockId == "" {
		return fmt.Errorf("not in a MoltenTerm terminal")
	}
	if moltenAgentPlanSubagent != "" && !agentplan.ValidSubagentId(moltenAgentPlanSubagent) {
		return fmt.Errorf("invalid sub-agent id %q (letters, digits, dashes and underscores)", moltenAgentPlanSubagent)
	}
	req.Subagent = moltenAgentPlanSubagent
	if thread := os.Getenv(codexThreadIdVar); agentplan.ValidSubagentId(thread) {
		req.Thread = thread
	}
	resp, err := RpcClient.SendRpcRequest(molten.CompanionPlanCommand, req, &wshrpc.RpcOpts{Route: molten.CompanionRoute, Timeout: moltenAgentPlanTimeoutMs})
	if err != nil {
		return err
	}
	var plan agentplan.Plan
	if err := utilfn.ReUnmarshal(&plan, resp); err != nil {
		return err
	}
	if req.Op == agentplan.OpShow && moltenJson {
		return moltenWriteJson(plan)
	}
	WriteStdout("%s\n", formatMoltenPlan(req, plan))
	return nil
}

// formatMoltenPlan says what the operation did, in English (agents parse it). A sub-agent is told that the plan is its
// own: its lead's plan, the one the companion shows, is unchanged.
func formatMoltenPlan(req molten.AgentPlanRequest, plan agentplan.Plan) string {
	text := formatMoltenPlanOp(req, plan)
	if plan.Subagent == "" {
		return text
	}
	return text + "\n" + moltenSubagentPlanNote
}

const moltenSubagentPlanNote = "This is your own plan as a sub-agent: your lead's plan in the companion is unchanged."

func formatMoltenPlanOp(req molten.AgentPlanRequest, plan agentplan.Plan) string {
	done, total := plan.Counts()
	switch req.Op {
	case agentplan.OpSet:
		return fmt.Sprintf("Plan set: %d %s, all to do.", total, moltenPlural(total, "step", "steps"))
	case agentplan.OpStart:
		return fmt.Sprintf("Step %d is in progress: %s.", req.Index, plan.Steps[req.Index-1].Text)
	case agentplan.OpDone:
		return fmt.Sprintf("Step %d is done: %s (%d of %d done).", req.Index, plan.Steps[req.Index-1].Text, done, total)
	case agentplan.OpAdd:
		return fmt.Sprintf("Step %d added: %s.", total, plan.Steps[total-1].Text)
	case agentplan.OpClear:
		return "Plan cleared."
	}
	return formatMoltenPlanSteps(plan, done, total)
}

func formatMoltenPlanSteps(plan agentplan.Plan, done int, total int) string {
	if plan.Empty() {
		return "The plan is empty. Set it with: molten agent plan set \"<step>\" ..."
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Plan: %d of %d %s done.", done, total, moltenPlural(total, "step", "steps"))
	marks := map[string]string{agentplan.StatusCompleted: "x", agentplan.StatusInProgress: ">", agentplan.StatusPending: " "}
	for i, s := range plan.Steps {
		fmt.Fprintf(&b, "\n%d. [%s] %s", i+1, marks[s.Status], s.Text)
	}
	return b.String()
}

func moltenPlural(n int, one string, many string) string {
	if n == 1 {
		return one
	}
	return many
}
