// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// `molten learn` (FR-LRN-002, DS-LRN-003): what a guided workflow learned from the developer, kept on this computer by
// wavesrv (pkg/molten/learning). An agent that drives a workflow reads the learned defaults when the workflow starts
// and records the adjustments the developer makes, so the next run asks less, whichever agent CLI runs it. The output
// is for agents: English, plain text or JSON. Exit codes: 2 for bad usage, 1 for any other failure.

const (
	moltenLearnTimeoutMs = 15000

	moltenLearnExitUsage = 2
)

var (
	moltenLearnAnswer     string
	moltenLearnPreference string
	moltenLearnCorrection string
	moltenLearnProposed   string
	moltenLearnSkip       string
	moltenLearnDone       string
	moltenLearnRun        string
)

var moltenLearnCmd = &cobra.Command{
	Use:   "learn",
	Short: "what the guided workflows learned from the developer: read the learned defaults, record an adjustment",
	Long: "A guided workflow (a pipeline setup, a mod design) remembers what the developer adjusts, so the next run asks " +
		"less. Read `molten learn defaults <workflow>` when you start one: it lists the answers to prefill and the steps " +
		"the developer always skips. Record an adjustment with `molten learn record <workflow>` only when the developer " +
		"made it in this workflow. Details: learning.md in the folder `molten docs` prints.",
}

var moltenLearnDefaultsCmd = &cobra.Command{
	Use:   "defaults <workflow>",
	Short: "print the learned defaults of a workflow: the answers to prefill and the steps to fold",
	Args:  cobra.ExactArgs(1),
	RunE:  moltenLearnWrap(moltenLearnDefaultsRun),
}

var moltenLearnListCmd = &cobra.Command{
	Use:   "list [<workflow>]",
	Short: "print everything learned, for one workflow or all of them",
	Args:  cobra.MaximumNArgs(1),
	RunE:  moltenLearnWrap(moltenLearnListRun),
}

var moltenLearnRecordCmd = &cobra.Command{
	Use:   "record <workflow> (--answer key=value | --preference key=value | --correction key=value [--proposed value] | --skip step | --done step) [--run label]",
	Short: "record one adjustment the developer made in a workflow",
	Long: "Records exactly one adjustment: an --answer to a question, a --preference among options, a --correction of " +
		"what the workflow proposed (with --proposed, the proposal), a step the developer skipped (--skip), or a step " +
		"the developer did (--done, which clears an earlier skip). Never record a secret, a path of the project or " +
		"anything the developer did not decide in this workflow.",
	Args: cobra.ExactArgs(1),
	RunE: moltenLearnWrap(moltenLearnRecordRun),
}

var moltenLearnForgetCmd = &cobra.Command{
	Use:   "forget <workflow> <id>",
	Short: "forget one learned item by its id (as `molten learn list` prints it)",
	Args:  cobra.ExactArgs(2),
	RunE:  moltenLearnWrap(moltenLearnForgetRun),
}

// moltenLearnUsageError: bad usage, exit code 2.
type moltenLearnUsageError struct {
	msg string
}

func (e moltenLearnUsageError) Error() string {
	return e.msg
}

func init() {
	moltenCmd.AddCommand(moltenLearnCmd)
	flags := moltenLearnRecordCmd.Flags()
	flags.StringVar(&moltenLearnAnswer, "answer", "", "an answer the developer gave: key=value")
	flags.StringVar(&moltenLearnPreference, "preference", "", "an option the developer prefers: key=value")
	flags.StringVar(&moltenLearnCorrection, "correction", "", "a proposal the developer changed: key=value (the developer's value)")
	flags.StringVar(&moltenLearnProposed, "proposed", "", "with --correction, what the workflow proposed")
	flags.StringVar(&moltenLearnSkip, "skip", "", "a step the developer skipped")
	flags.StringVar(&moltenLearnDone, "done", "", "a step the developer did (it is no longer skipped)")
	flags.StringVar(&moltenLearnRun, "run", "", "a label for this run, shown as the source (default: none)")
	for _, cmd := range []*cobra.Command{moltenLearnDefaultsCmd, moltenLearnListCmd, moltenLearnRecordCmd, moltenLearnForgetCmd} {
		cmd.Flags().BoolVar(&moltenJson, "json", false, "print the result as JSON")
		cmd.SetFlagErrorFunc(func(_ *cobra.Command, err error) error {
			moltenLearnFail(moltenLearnUsageError{msg: err.Error()})
			return nil
		})
		moltenLearnCmd.AddCommand(cmd)
	}
}

// moltenLearnFail reports err on one line (as JSON with --json) and sets the exit code: 2 for bad usage, 1 otherwise.
func moltenLearnFail(err error) {
	var usage moltenLearnUsageError
	if errors.As(err, &usage) {
		WshExitCode = moltenLearnExitUsage
	}
	moltenReportError(errors.New(strings.ReplaceAll(err.Error(), "\n", " ")))
}

func moltenLearnWrap(fn func(cmd *cobra.Command, args []string) error) func(cmd *cobra.Command, args []string) error {
	return func(cmd *cobra.Command, args []string) error {
		if err := preRunSetupRpcClient(cmd, args); err != nil {
			moltenLearnFail(err)
			return nil
		}
		err := fn(cmd, args)
		sendActivity("molten", err == nil)
		if err != nil {
			moltenLearnFail(err)
		}
		return nil
	}
}

func moltenLearnCall(command string, req molten.LearningRequest, out any) error {
	resp, err := RpcClient.SendRpcRequest(command, req, &wshrpc.RpcOpts{Route: molten.LearningRoute, Timeout: moltenLearnTimeoutMs})
	if err != nil {
		return err
	}
	return utilfn.ReUnmarshal(out, resp)
}

// moltenLearnCaller sends a command to wavesrv; the tests give it a fake.
type moltenLearnCaller func(command string, req molten.LearningRequest, out any) error

func moltenLearnDefaultsRun(cmd *cobra.Command, args []string) error {
	return runMoltenLearnDefaults(moltenLearnCall, args[0], moltenJson, WrappedStdout)
}

func moltenLearnListRun(cmd *cobra.Command, args []string) error {
	workflow := ""
	if len(args) == 1 {
		workflow = args[0]
	}
	return runMoltenLearnList(moltenLearnCall, workflow, moltenJson, WrappedStdout)
}

func moltenLearnRecordRun(cmd *cobra.Command, args []string) error {
	req, err := parseMoltenLearnRecord(args[0], moltenLearnAnswer, moltenLearnPreference, moltenLearnCorrection, moltenLearnProposed, moltenLearnSkip, moltenLearnDone, moltenLearnRun)
	if err != nil {
		return err
	}
	return runMoltenLearnRecord(moltenLearnCall, req, moltenJson, WrappedStdout)
}

func moltenLearnForgetRun(cmd *cobra.Command, args []string) error {
	return runMoltenLearnForget(moltenLearnCall, args[0], args[1], moltenJson, WrappedStdout)
}

func moltenWriteJsonTo(w io.Writer, value any) error {
	out, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	fmt.Fprintf(w, "%s\n", out)
	return nil
}

// splitMoltenLearnPair reads key=value; the value may hold further equal signs.
func splitMoltenLearnPair(flag string, pair string) (string, string, error) {
	key, value, ok := strings.Cut(pair, "=")
	if !ok || key == "" || value == "" {
		return "", "", moltenLearnUsageError{msg: fmt.Sprintf("--%s takes key=value, got %q", flag, pair)}
	}
	return key, value, nil
}

// parseMoltenLearnRecord checks what the command can check alone; every error is bad usage. The rules of the store
// (workflow, key, value) are checked by wavesrv.
func parseMoltenLearnRecord(workflow string, answer string, preference string, correction string, proposed string, skip string, done string, run string) (molten.LearningRequest, error) {
	req := molten.LearningRequest{Workflow: workflow, Run: run}
	chosen := 0
	pairs := []struct {
		flag  string
		value string
		kind  string
	}{
		{"answer", answer, molten.LearningKindAnswer},
		{"preference", preference, molten.LearningKindPreference},
		{"correction", correction, molten.LearningKindCorrection},
	}
	for _, p := range pairs {
		if p.value == "" {
			continue
		}
		chosen++
		key, value, err := splitMoltenLearnPair(p.flag, p.value)
		if err != nil {
			return req, err
		}
		req.Kind, req.Key, req.Value = p.kind, key, value
	}
	steps := []struct {
		value string
		kind  string
	}{{skip, molten.LearningKindSkip}, {done, molten.LearningKindDone}}
	for _, s := range steps {
		if s.value == "" {
			continue
		}
		chosen++
		req.Kind, req.Key = s.kind, s.value
	}
	if chosen != 1 {
		return req, moltenLearnUsageError{msg: "give exactly one of --answer, --preference, --correction, --skip or --done"}
	}
	if proposed != "" && req.Kind != molten.LearningKindCorrection {
		return req, moltenLearnUsageError{msg: "--proposed goes with --correction"}
	}
	req.Proposed = proposed
	return req, nil
}

func runMoltenLearnRecord(call moltenLearnCaller, req molten.LearningRequest, asJson bool, stdout io.Writer) error {
	var recorded molten.LearningRecorded
	if err := call(molten.LearningRecordCommand, req, &recorded); err != nil {
		return err
	}
	if asJson {
		return moltenWriteJsonTo(stdout, recorded)
	}
	fmt.Fprint(stdout, formatMoltenLearnRecorded(req, recorded))
	return nil
}

func formatMoltenLearnRecorded(req molten.LearningRequest, recorded molten.LearningRecorded) string {
	if req.Kind == molten.LearningKindDone {
		if recorded.Cleared {
			return fmt.Sprintf("Noted: %s was done, it is no longer a skipped step of %s.\n", req.Key, req.Workflow)
		}
		return fmt.Sprintf("Nothing to clear: %s was not a skipped step of %s.\n", req.Key, req.Workflow)
	}
	item := recorded.Item
	if item == nil {
		return "Nothing was recorded.\n"
	}
	return fmt.Sprintf("Remembered for %s: %s (%s).\n", req.Workflow, moltenLearnDescribe(*item), moltenLearnSeen(*item))
}

func moltenLearnDescribe(item molten.LearningItem) string {
	switch item.Kind {
	case molten.LearningKindSkip:
		return fmt.Sprintf("the developer skips the step %s", item.Key)
	case molten.LearningKindCorrection:
		if item.Proposed != "" {
			return fmt.Sprintf("%s = %s, a correction of the proposed %s", item.Key, item.Value, item.Proposed)
		}
		return fmt.Sprintf("%s = %s, a correction", item.Key, item.Value)
	case molten.LearningKindAnswer:
		return fmt.Sprintf("%s = %s, an answer", item.Key, item.Value)
	}
	return fmt.Sprintf("%s = %s, a preference", item.Key, item.Value)
}

func moltenLearnSeen(item molten.LearningItem) string {
	times := "times"
	if item.Seen == 1 {
		times = "time"
	}
	return fmt.Sprintf("seen %d %s, %s confidence", item.Seen, times, item.Confidence)
}

func runMoltenLearnDefaults(call moltenLearnCaller, workflow string, asJson bool, stdout io.Writer) error {
	var defaults molten.LearningDefaults
	if err := call(molten.LearningDefaultsCommand, molten.LearningRequest{Workflow: workflow}, &defaults); err != nil {
		return err
	}
	if defaults.Prefill == nil {
		defaults.Prefill = []molten.LearningItem{}
	}
	if defaults.Folded == nil {
		defaults.Folded = []molten.LearningItem{}
	}
	if asJson {
		return moltenWriteJsonTo(stdout, defaults)
	}
	fmt.Fprint(stdout, formatMoltenLearnDefaults(defaults))
	return nil
}

// formatMoltenLearnDefaults: what a workflow starts from. The prefill lines are `key = value`, so an agent reads them
// without guessing; the developer can still change each one.
func formatMoltenLearnDefaults(d molten.LearningDefaults) string {
	if len(d.Prefill) == 0 && len(d.Folded) == 0 {
		return fmt.Sprintf("Nothing learned yet for %s: start from the workflow's own proposals.\n", d.Workflow)
	}
	var sb strings.Builder
	fmt.Fprintf(&sb, "Learned defaults for %s, from the developer's earlier runs (kept on this computer):\n", d.Workflow)
	if len(d.Prefill) > 0 {
		fmt.Fprintf(&sb, "\nPrefill, mark it as based on the developer's earlier choices (%d):\n", len(d.Prefill))
		for _, item := range d.Prefill {
			fmt.Fprintf(&sb, "- %s = %s (%s; %s)\n", item.Key, item.Value, item.Kind, moltenLearnSeen(item))
		}
	}
	if len(d.Folded) > 0 {
		fmt.Fprintf(&sb, "\nFold these steps, the developer always skips them; show them folded, never remove them (%d):\n", len(d.Folded))
		for _, item := range d.Folded {
			fmt.Fprintf(&sb, "- %s (skipped in %d runs in a row)\n", item.Key, item.Seen)
		}
	}
	return sb.String()
}

func runMoltenLearnList(call moltenLearnCaller, workflow string, asJson bool, stdout io.Writer) error {
	var list molten.LearningList
	if err := call(molten.LearningListCommand, molten.LearningRequest{Workflow: workflow}, &list); err != nil {
		return err
	}
	if list.Workflows == nil {
		list.Workflows = []molten.LearningWorkflow{}
	}
	if asJson {
		return moltenWriteJsonTo(stdout, list)
	}
	fmt.Fprint(stdout, formatMoltenLearnList(list))
	return nil
}

func formatMoltenLearnList(list molten.LearningList) string {
	var sb strings.Builder
	for i, w := range list.Workflows {
		if i > 0 {
			sb.WriteString("\n")
		}
		if len(w.Items) == 0 {
			fmt.Fprintf(&sb, "%s: nothing learned yet\n", w.Workflow)
			continue
		}
		fmt.Fprintf(&sb, "%s (%d):\n", w.Workflow, len(w.Items))
		for _, item := range w.Items {
			fmt.Fprintf(&sb, "- %s\t%s\t%s\n", item.Id, moltenLearnValueText(item), moltenLearnSource(item))
		}
	}
	return sb.String()
}

func moltenLearnValueText(item molten.LearningItem) string {
	if item.Kind == molten.LearningKindSkip {
		return "skipped"
	}
	if item.Proposed != "" {
		return fmt.Sprintf("%s (proposed: %s)", item.Value, item.Proposed)
	}
	return item.Value
}

func moltenLearnSource(item molten.LearningItem) string {
	source := fmt.Sprintf("%s, recorded by %s", moltenLearnSeen(item), item.Source.By)
	if item.Source.Run != "" {
		source += " in run " + item.Source.Run
	}
	if item.Edited {
		source += ", edited by the developer"
	}
	return source
}

func runMoltenLearnForget(call moltenLearnCaller, workflow string, id string, asJson bool, stdout io.Writer) error {
	var forgotten molten.LearningRecorded
	if err := call(molten.LearningForgetCommand, molten.LearningRequest{Workflow: workflow, Id: id}, &forgotten); err != nil {
		return err
	}
	if asJson {
		return moltenWriteJsonTo(stdout, map[string]any{"workflow": workflow, "id": id, "forgotten": true})
	}
	fmt.Fprintf(stdout, "Forgot %s of %s.\n", id, workflow)
	return nil
}
