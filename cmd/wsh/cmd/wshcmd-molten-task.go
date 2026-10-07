// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

// `molten task` (FR-CONT-007, DS-CONT-008): the workspace task checkpoint of the terminal it runs in, kept by wavesrv in
// MoltenTerm's data folder. Writing it from an agent (`molten task checkpoint`) and the briefing come with #330 and
// #180.

const moltenTaskTimeoutMs = 5000

var moltenTaskSection string

var moltenTaskCmd = &cobra.Command{
	Use:     "task",
	Short:   "the task checkpoint of this terminal's workspace: what every agent continues from",
	Args:    cobra.NoArgs,
	RunE:    moltenWrap(moltenTaskShowRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenTaskShowCmd = &cobra.Command{
	Use:     "show",
	Short:   "print the workspace's task checkpoint (secrets redacted)",
	Args:    cobra.NoArgs,
	RunE:    moltenWrap(moltenTaskShowRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenTaskEditCmd = &cobra.Command{
	Use:     "edit",
	Short:   "open the task checkpoint in MoltenTerm's editor; automatic updates never overwrite what you write",
	Args:    cobra.NoArgs,
	RunE:    moltenWrap(moltenTaskEditRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenTaskHistoryCmd = &cobra.Command{
	Use:     "history",
	Short:   "list the earlier versions of the task checkpoint, 1 being the newest",
	Args:    cobra.NoArgs,
	RunE:    moltenWrap(moltenTaskHistoryRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenTaskRestoreCmd = &cobra.Command{
	Use:     "restore <n>",
	Short:   "restore version n of the history; the current checkpoint goes to the history",
	Args:    cobra.ExactArgs(1),
	RunE:    moltenWrap(moltenTaskRestoreRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenTaskClearCmd = &cobra.Command{
	Use:     "clear",
	Short:   "start a new task; the current checkpoint stays in the history",
	Args:    cobra.NoArgs,
	RunE:    moltenWrap(moltenTaskClearRun),
	PreRunE: preRunSetupRpcClient,
}

func init() {
	moltenCmd.AddCommand(moltenTaskCmd)
	moltenTaskCmd.Flags().BoolVar(&moltenJson, "json", false, "print the result as JSON")
	moltenTaskCmd.Flags().StringVar(&moltenTaskSection, "section", "", "print one section only (Goal, Ticket, Plan and progress, …)")
	moltenTaskShowCmd.Flags().StringVar(&moltenTaskSection, "section", "", "print one section only (Goal, Ticket, Plan and progress, …)")
	for _, cmd := range []*cobra.Command{moltenTaskShowCmd, moltenTaskEditCmd, moltenTaskHistoryCmd, moltenTaskRestoreCmd, moltenTaskClearCmd} {
		cmd.Flags().BoolVar(&moltenJson, "json", false, "print the result as JSON")
		moltenTaskCmd.AddCommand(cmd)
	}
}

func moltenTaskBlockId() (string, error) {
	blockId := RpcContext.BlockId
	if blockId == "" {
		blockId = os.Getenv("WAVETERM_BLOCKID")
	}
	if blockId == "" {
		return "", fmt.Errorf("not in a MoltenTerm terminal: molten task works on the workspace of the terminal it runs in")
	}
	return blockId, nil
}

func moltenTaskCall(command string, req molten.TaskRequest, out any) error {
	blockId, err := moltenTaskBlockId()
	if err != nil {
		return err
	}
	req.BlockId = blockId
	resp, err := RpcClient.SendRpcRequest(command, req, &wshrpc.RpcOpts{Route: molten.TaskRoute, Timeout: moltenTaskTimeoutMs})
	if err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	return utilfn.ReUnmarshal(out, resp)
}

func moltenTaskShowRun(cmd *cobra.Command, args []string) error {
	var view molten.TaskView
	if err := moltenTaskCall(molten.TaskReadCommand, molten.TaskRequest{Section: moltenTaskSection}, &view); err != nil {
		return err
	}
	if moltenJson {
		return moltenWriteJson(view)
	}
	if moltenTaskSection != "" {
		if len(view.Sections) == 1 {
			WriteStdout("%s\n", view.Sections[0].Text)
		}
		return nil
	}
	if !view.Exists {
		WriteStdout("No task recorded yet for this workspace: it fills in at the end of the agent's next turn.\n")
		WriteStdout("File: %s\n", view.Path)
		return nil
	}
	WriteStdout("%s", view.Markdown)
	WriteStdout("\nFile: %s\n", view.Path)
	return nil
}

func moltenTaskEditRun(cmd *cobra.Command, args []string) error {
	var view molten.TaskView
	if err := moltenTaskCall(molten.TaskReadCommand, molten.TaskRequest{Create: true}, &view); err != nil {
		return err
	}
	tabId := getTabIdFromEnv()
	if tabId == "" {
		return fmt.Errorf("no WAVETERM_TABID env var set")
	}
	data := wshrpc.CommandCreateBlockData{
		TabId: tabId,
		BlockDef: &waveobj.BlockDef{
			Meta: map[string]any{
				waveobj.MetaKey_View: "preview",
				waveobj.MetaKey_File: view.Path,
				waveobj.MetaKey_Edit: true,
			},
		},
		Focused: true,
	}
	if _, err := wshclient.CreateBlockCommand(RpcClient, data, &wshrpc.RpcOpts{Timeout: moltenTaskTimeoutMs}); err != nil {
		return fmt.Errorf("opening the editor: %w", err)
	}
	if moltenJson {
		return moltenWriteJson(map[string]string{"path": view.Path})
	}
	WriteStdout("Opened %s in the editor.\n", view.Path)
	return nil
}

func moltenTaskHistoryRun(cmd *cobra.Command, args []string) error {
	var versions []molten.TaskVersion
	if err := moltenTaskCall(molten.TaskHistoryCommand, molten.TaskRequest{}, &versions); err != nil {
		return err
	}
	if moltenJson {
		if versions == nil {
			versions = []molten.TaskVersion{}
		}
		return moltenWriteJson(versions)
	}
	if len(versions) == 0 {
		WriteStdout("No earlier version of the task checkpoint.\n")
		return nil
	}
	for _, v := range versions {
		by := v.UpdatedBy
		if by == "" {
			by = "-"
		}
		goal := v.Goal
		if goal == "" {
			goal = "(no goal)"
		}
		WriteStdout("%3d  %s  %-10s  %s\n", v.N, time.UnixMilli(v.At).Local().Format("2006-01-02 15:04"), by, goal)
	}
	WriteStdout("Restore one with: molten task restore <n>\n")
	return nil
}

func moltenTaskRestoreRun(cmd *cobra.Command, args []string) error {
	n, err := strconv.Atoi(strings.TrimSpace(args[0]))
	if err != nil || n < 1 {
		return fmt.Errorf("give the number of a version from molten task history")
	}
	var view molten.TaskView
	if err := moltenTaskCall(molten.TaskRestoreCommand, molten.TaskRequest{N: n}, &view); err != nil {
		return err
	}
	if moltenJson {
		return moltenWriteJson(view)
	}
	WriteStdout("Restored version %d; the previous checkpoint is now version 1 of molten task history.\n", n)
	return nil
}

func moltenTaskClearRun(cmd *cobra.Command, args []string) error {
	var view molten.TaskView
	if err := moltenTaskCall(molten.TaskClearCommand, molten.TaskRequest{}, &view); err != nil {
		return err
	}
	if moltenJson {
		return moltenWriteJson(view)
	}
	if view.Versions == 0 {
		WriteStdout("Started a new task.\n")
		return nil
	}
	WriteStdout("Started a new task; the previous checkpoint is version 1 of molten task history.\n")
	return nil
}
