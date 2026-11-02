// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// `molten material` (FR-MAT-001 signal 5): declare what you produce for the developer outside the repository, and list
// the materials of this terminal's project, kept by wavesrv in MoltenTerm's data folder. The output is for agents:
// English, one material per line, or JSON.

const moltenMaterialTimeoutMs = 30000

var moltenMaterialTitle string

var moltenMaterialCmd = &cobra.Command{
	Use:   "material",
	Short: "the materials of this terminal's project: what agents produced for the developer outside the repository",
}

var moltenMaterialAddCmd = &cobra.Command{
	Use:     "add <path|url>",
	Short:   "declare a page, report, capture or link you produced for the developer outside the repository (a file is copied)",
	Args:    cobra.ExactArgs(1),
	RunE:    moltenWrap(moltenMaterialAddRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenMaterialListCmd = &cobra.Command{
	Use:     "list",
	Short:   "list the project's materials: id, title, kind, form, size, origin, date",
	Args:    cobra.NoArgs,
	RunE:    moltenWrap(moltenMaterialListRun),
	PreRunE: preRunSetupRpcClient,
}

func init() {
	moltenCmd.AddCommand(moltenMaterialCmd)
	moltenMaterialAddCmd.Flags().StringVar(&moltenMaterialTitle, "title", "", "the material's title (otherwise found from the page, the file or its name)")
	for _, cmd := range []*cobra.Command{moltenMaterialAddCmd, moltenMaterialListCmd} {
		cmd.Flags().BoolVar(&moltenJson, "json", false, "print the result as JSON")
		moltenMaterialCmd.AddCommand(cmd)
	}
}

func moltenMaterialCall(command string, req molten.MaterialsRequest, out any) error {
	blockId := RpcContext.BlockId
	if blockId == "" {
		blockId = os.Getenv("WAVETERM_BLOCKID")
	}
	if blockId == "" {
		return fmt.Errorf("not in a MoltenTerm terminal: molten material works on the project of the terminal it runs in")
	}
	req.BlockId = blockId
	resp, err := RpcClient.SendRpcRequest(command, req, &wshrpc.RpcOpts{Route: molten.MaterialsRoute, Timeout: moltenMaterialTimeoutMs})
	if err != nil {
		return err
	}
	return utilfn.ReUnmarshal(out, resp)
}

func moltenMaterialAddRun(cmd *cobra.Command, args []string) error {
	cwd, _ := os.Getwd()
	var m molten.Material
	if err := moltenMaterialCall(molten.MaterialAddCommand, molten.MaterialsRequest{Target: args[0], Title: moltenMaterialTitle, Cwd: cwd}, &m); err != nil {
		return err
	}
	if moltenJson {
		return moltenWriteJson(m)
	}
	WriteStdout("Kept in Materials: %s (%s, %s)\n", m.Title, m.Id, moltenMaterialFormText(m))
	return nil
}

func moltenMaterialListRun(cmd *cobra.Command, args []string) error {
	var view molten.MaterialsView
	if err := moltenMaterialCall(molten.MaterialsListCommand, molten.MaterialsRequest{}, &view); err != nil {
		return err
	}
	if moltenJson {
		if view.Materials == nil {
			view.Materials = []molten.Material{}
		}
		return moltenWriteJson(view.Materials)
	}
	if len(view.Materials) == 0 {
		WriteStdout("No material kept for this project yet. Declare one with: molten material add <path|url> --title \"...\"\n")
		return nil
	}
	for _, m := range view.Materials {
		WriteStdout("%s\t%s\t%s\t%s\t%s\t%s\t%s\n", m.Id, oneLineTitle(m.Title), m.Kind, molten.MaterialForm(m), moltenMaterialSize(m), moltenMaterialOrigin(m), time.UnixMilli(m.Created).Local().Format("2006-01-02 15:04"))
	}
	return nil
}

func oneLineTitle(title string) string {
	return strings.Join(strings.Fields(title), " ")
}

// moltenMaterialFormText says what was kept, and why there is no copy when there is none.
func moltenMaterialFormText(m molten.Material) string {
	switch m.Copy {
	case molten.MaterialCopyTooLarge:
		return "not copied: too large"
	case molten.MaterialCopySpaceFull:
		return "not copied: space full"
	case molten.MaterialCopySecret:
		return "not copied: may contain a secret"
	case molten.MaterialCopyMissing:
		return "not copied: the file is gone"
	case molten.MaterialCopyFailed:
		return "not copied: the copy failed"
	}
	return molten.MaterialForm(m)
}

func moltenMaterialSize(m molten.Material) string {
	if m.Size <= 0 {
		return "-"
	}
	const unit = 1024
	size := float64(m.Size)
	for _, suffix := range []string{"B", "KB", "MB"} {
		if size < unit {
			if suffix == "B" {
				return fmt.Sprintf("%d B", m.Size)
			}
			return fmt.Sprintf("%.1f %s", size, suffix)
		}
		size /= unit
	}
	return fmt.Sprintf("%.1f GB", size)
}

func moltenMaterialOrigin(m molten.Material) string {
	who := m.Agent
	if who == "" {
		who = m.Tool
	}
	if who == "" {
		return m.Source
	}
	return m.Source + " by " + who
}
