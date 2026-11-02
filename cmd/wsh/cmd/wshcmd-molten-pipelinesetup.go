// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// `molten pipeline setup show|propose|flag|explain|withdraw` (FR-MC-045, #1163): the coding agent in a pipeline tab's
// terminal keeps the setup panel in step with the conversation. wavesrv answers only this terminal's own tab's setup
// (pkg/molten/mission/setupboard.go); the panel shows each proposal and the developer decides it there. Nothing here
// writes a file.

// must match pkg/molten/mission/setupboard.go
const (
	moltenSetupAgentShowCommand     = "moltenmissionsetupagentshow"
	moltenSetupAgentProposeCommand  = "moltenmissionsetupagentpropose"
	moltenSetupAgentFlagCommand     = "moltenmissionsetupagentflag"
	moltenSetupAgentExplainCommand  = "moltenmissionsetupagentexplain"
	moltenSetupAgentWithdrawCommand = "moltenmissionsetupagentwithdraw"
	moltenSetupRpcTimeoutMs         = 20000
	moltenSetupMaxChangeBytes       = 256 * 1024
)

type moltenSetupStep struct {
	Channel string   `json:"channel"`
	N       int      `json:"n"`
	Ids     []string `json:"ids"`
	Text    string   `json:"text"`
}

type moltenSetupChange struct {
	Key     string `json:"key"`
	Op      string `json:"op"`
	Channel string `json:"channel,omitempty"`
	Id      string `json:"id,omitempty"`
	Title   string `json:"title,omitempty"`
}

type moltenSetupItem struct {
	Key    string             `json:"key"`
	Kind   string             `json:"kind"`
	State  string             `json:"state"`
	By     string             `json:"by,omitempty"`
	Change *moltenSetupChange `json:"change,omitempty"`
	Why    string             `json:"why,omitempty"`
	Step   string             `json:"step,omitempty"`
	Point  string             `json:"point,omitempty"`
	Answer string             `json:"answer,omitempty"`
}

type moltenSetupExplain struct {
	Channel string `json:"channel"`
	N       int    `json:"n"`
	Note    string `json:"note,omitempty"`
}

type moltenSetupState struct {
	Dir     string              `json:"dir"`
	Open    bool                `json:"open"`
	Screen  string              `json:"screen,omitempty"`
	Steps   []moltenSetupStep   `json:"steps"`
	Items   []moltenSetupItem   `json:"items"`
	Explain *moltenSetupExplain `json:"explain,omitempty"`
}

type moltenSetupAnswer struct {
	State moltenSetupState `json:"state"`
	Item  *moltenSetupItem `json:"item,omitempty"`
}

var (
	moltenSetupWhy     string
	moltenSetupSay     string
	moltenSetupWho     string
	moltenSetupStepF   string
	moltenSetupAnswerF string
	moltenSetupClear   bool
)

var moltenPipelineCmd = &cobra.Command{
	Use:   "pipeline",
	Short: "the project's pipeline setup, as the developer sees it in the pipeline tab",
}

var moltenPipelineSetupCmd = &cobra.Command{
	Use:   "setup",
	Short: "read the open pipeline setup and propose changes in its panel (from the pipeline tab's terminal)",
}

var moltenPipelineSetupShowCmd = &cobra.Command{
	Use:     "show",
	Short:   "the screen the developer is on, the numbered steps in plain words, the open proposals and flags",
	Args:    cobra.NoArgs,
	RunE:    moltenWrap(moltenPipelineSetupShowRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenPipelineSetupProposeCmd = &cobra.Command{
	Use:     "propose [change-json] --why <reason>",
	Short:   "propose one change in the panel: {\"op\":\"add|change|remove|versions\",…} as the pipeline setup's contract (stdin when no argument)",
	Args:    cobra.MaximumNArgs(1),
	RunE:    moltenWrap(moltenPipelineSetupProposeRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenPipelineSetupFlagCmd = &cobra.Command{
	Use:     "flag <point> [--step rc/<n>] [--answer <proposed answer>]",
	Short:   "flag a point to check in the panel, with your proposed answer",
	Args:    cobra.ExactArgs(1),
	RunE:    moltenWrap(moltenPipelineSetupFlagRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenPipelineSetupExplainCmd = &cobra.Command{
	Use:     "explain <rc/n|public/n> [note] | --clear",
	Short:   "highlight a step in the panel while you explain it (--clear removes the highlight)",
	Args:    cobra.MaximumNArgs(2),
	RunE:    moltenWrap(moltenPipelineSetupExplainRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenPipelineSetupWithdrawCmd = &cobra.Command{
	Use:     "withdraw <key>",
	Short:   "take back one of your open proposals or flags",
	Args:    cobra.ExactArgs(1),
	RunE:    moltenWrap(moltenPipelineSetupWithdrawRun),
	PreRunE: preRunSetupRpcClient,
}

func init() {
	moltenPipelineSetupProposeCmd.Flags().StringVar(&moltenSetupWhy, "why", "", "why, in one line of plain words the developer reads on the card")
	moltenPipelineSetupProposeCmd.Flags().StringVar(&moltenSetupSay, "say", "", "the changed or added step in one plain-words sentence, as the panel should read it")
	moltenPipelineSetupProposeCmd.Flags().StringVar(&moltenSetupWho, "who", "", "who does the step once changed: molten, you, confirm, approve or validate")
	moltenPipelineSetupFlagCmd.Flags().StringVar(&moltenSetupStepF, "step", "", "the step the point is about: rc/<n> or public/<n> (see show)")
	moltenPipelineSetupFlagCmd.Flags().StringVar(&moltenSetupAnswerF, "answer", "", "your proposed answer")
	moltenPipelineSetupExplainCmd.Flags().BoolVar(&moltenSetupClear, "clear", false, "remove the highlight")
	moltenCmd.AddCommand(moltenPipelineCmd)
	moltenPipelineCmd.AddCommand(moltenPipelineSetupCmd)
	for _, cmd := range []*cobra.Command{moltenPipelineSetupShowCmd, moltenPipelineSetupProposeCmd, moltenPipelineSetupFlagCmd, moltenPipelineSetupExplainCmd, moltenPipelineSetupWithdrawCmd} {
		cmd.Flags().BoolVar(&moltenJson, "json", false, "print the result as JSON")
		moltenPipelineSetupCmd.AddCommand(cmd)
	}
}

func moltenSetupAsk(command string, data any) (moltenSetupAnswer, any, error) {
	var answer moltenSetupAnswer
	if RpcContext.Conn != "" {
		return answer, nil, fmt.Errorf("the pipeline setup is changed from a local terminal (this one runs on %s)", RpcContext.Conn)
	}
	resp, err := RpcClient.SendRpcRequest(command, data, &wshrpc.RpcOpts{Route: moltenMissionRoute, Timeout: moltenSetupRpcTimeoutMs})
	if err != nil {
		return answer, nil, err
	}
	return answer, resp, utilfn.ReUnmarshal(&answer, resp)
}

func moltenSetupDone(command string, data any, said func(answer moltenSetupAnswer) string) error {
	answer, raw, err := moltenSetupAsk(command, data)
	if err != nil {
		return err
	}
	if moltenJson {
		return moltenWriteJson(raw)
	}
	WriteStdout("%s", said(answer))
	return nil
}

func moltenPipelineSetupShowRun(cmd *cobra.Command, args []string) error {
	return moltenSetupDone(moltenSetupAgentShowCommand, map[string]any{}, func(a moltenSetupAnswer) string {
		return formatMoltenSetupState(a.State)
	})
}

func moltenSetupReadChange(args []string) (json.RawMessage, error) {
	var data []byte
	if len(args) == 1 && args[0] != "-" {
		data = []byte(args[0])
	} else {
		read, err := io.ReadAll(io.LimitReader(os.Stdin, moltenSetupMaxChangeBytes+1))
		if err != nil {
			return nil, fmt.Errorf("reading the change from stdin: %w", err)
		}
		data = read
	}
	if len(data) > moltenSetupMaxChangeBytes {
		return nil, fmt.Errorf("the change is too large")
	}
	if !json.Valid(data) {
		return nil, fmt.Errorf("the change is not JSON: write one object such as {\"op\":\"add\",\"channel\":\"rc\",\"id\":\"…\",\"step\":{…}}")
	}
	return json.RawMessage(data), nil
}

func moltenPipelineSetupProposeRun(cmd *cobra.Command, args []string) error {
	change, err := moltenSetupReadChange(args)
	if err != nil {
		return err
	}
	return moltenSetupDone(moltenSetupAgentProposeCommand, map[string]any{"change": change, "why": moltenSetupWhy, "say": moltenSetupSay, "who": moltenSetupWho}, func(a moltenSetupAnswer) string {
		return fmt.Sprintf("proposed in the panel as #%s: the developer accepts or declines it there\n", a.Item.Key)
	})
}

func moltenPipelineSetupFlagRun(cmd *cobra.Command, args []string) error {
	data := map[string]any{"point": args[0], "step": moltenSetupStepF, "answer": moltenSetupAnswerF}
	return moltenSetupDone(moltenSetupAgentFlagCommand, data, func(a moltenSetupAnswer) string {
		return fmt.Sprintf("flagged in the panel as #%s\n", a.Item.Key)
	})
}

func moltenPipelineSetupExplainRun(cmd *cobra.Command, args []string) error {
	if moltenSetupClear {
		return moltenSetupDone(moltenSetupAgentExplainCommand, map[string]any{}, func(a moltenSetupAnswer) string {
			return "the highlight is removed\n"
		})
	}
	if len(args) == 0 {
		return fmt.Errorf("name the step: rc/<n> or public/<n> (see show), or --clear")
	}
	data := map[string]any{"step": args[0]}
	if len(args) == 2 {
		data["note"] = args[1]
	}
	return moltenSetupDone(moltenSetupAgentExplainCommand, data, func(a moltenSetupAnswer) string {
		return fmt.Sprintf("%s is highlighted in the panel\n", args[0])
	})
}

func moltenPipelineSetupWithdrawRun(cmd *cobra.Command, args []string) error {
	key := strings.TrimPrefix(args[0], "#")
	return moltenSetupDone(moltenSetupAgentWithdrawCommand, map[string]any{"key": key}, func(a moltenSetupAnswer) string {
		return fmt.Sprintf("#%s is withdrawn from the panel\n", key)
	})
}

var moltenSetupChannelWords = map[string]string{"rc": "release candidate", "public": "public release"}

func formatMoltenSetupState(s moltenSetupState) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "pipeline setup of %s, the developer is on the %q screen\n", moltenPrintable(s.Dir), s.Screen)
	for _, channel := range []string{"rc", "public"} {
		first := true
		for _, step := range s.Steps {
			if step.Channel != channel {
				continue
			}
			if first {
				fmt.Fprintf(&sb, "%s (%s):\n", moltenSetupChannelWords[channel], channel)
				first = false
			}
			fmt.Fprintf(&sb, "  %s/%d  %s  [%s]\n", channel, step.N, moltenPrintable(step.Text), strings.Join(step.Ids, ", "))
		}
	}
	open := 0
	for _, it := range s.Items {
		if it.State == "open" {
			open++
		}
	}
	fmt.Fprintf(&sb, "proposals: %d open\n", open)
	for _, it := range s.Items {
		switch {
		case it.Kind == "flag":
			step := it.Step
			if step == "" {
				step = "-"
			}
			fmt.Fprintf(&sb, "  #%s  %s  flag %s: %s", it.Key, it.State, step, moltenPrintable(it.Point))
			if it.Answer != "" {
				fmt.Fprintf(&sb, " (proposed answer: %s)", moltenPrintable(it.Answer))
			}
			sb.WriteString("\n")
		case it.Change != nil:
			target := it.Change.Channel + "/" + it.Change.Id
			if it.Change.Op == "versions" {
				target = "versions"
			}
			fmt.Fprintf(&sb, "  #%s  %s  %s %s: %s\n", it.Key, it.State, it.Change.Op, target, moltenPrintable(it.Why))
		}
	}
	if s.Explain != nil {
		fmt.Fprintf(&sb, "highlighted: %s/%d\n", s.Explain.Channel, s.Explain.N)
	}
	return sb.String()
}
