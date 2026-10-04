// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

// `molten worktree` (FR-SHELL-016): an agent that made a git worktree for its task links it to the terminal it runs
// in, without a prompt; the pane header shows it and closing the terminal offers to remove it. Linking writes the
// block's meta only: MoltenTerm never creates, moves or removes a worktree from here (pkg/molten/agentdocs/worktrees.md).

type MoltenWorktreeStatus struct {
	Terminal string `json:"terminal"`
	Linked   string `json:"linked,omitempty"`
	Missing  bool   `json:"missing,omitempty"`
	// The tree of the terminal's current folder: a linked worktree, or empty for a main tree or no repository.
	Folder   string `json:"folder"`
	Worktree string `json:"worktree,omitempty"`
	Branch   string `json:"branch,omitempty"`
}

var moltenWorktreeCmd = &cobra.Command{
	Use:     "worktree",
	Short:   "link this terminal to the git worktree its task runs in",
	Args:    cobra.NoArgs,
	RunE:    moltenWrap(moltenWorktreeShowRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenWorktreeLinkCmd = &cobra.Command{
	Use:     "link [folder]",
	Short:   "link this terminal to the worktree holding a folder (default: this terminal's folder)",
	Args:    cobra.MaximumNArgs(1),
	RunE:    moltenWrap(moltenWorktreeLinkRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenWorktreeUnlinkCmd = &cobra.Command{
	Use:     "unlink",
	Short:   "remove this terminal's worktree link (the worktree is not touched)",
	Args:    cobra.NoArgs,
	RunE:    moltenWrap(moltenWorktreeUnlinkRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenWorktreeShowCmd = &cobra.Command{
	Use:     "show",
	Short:   "show this terminal's worktree link and the tree of its folder",
	Args:    cobra.NoArgs,
	RunE:    moltenWrap(moltenWorktreeShowRun),
	PreRunE: preRunSetupRpcClient,
}

func init() {
	moltenCmd.AddCommand(moltenWorktreeCmd)
	moltenWorktreeCmd.Flags().BoolVar(&moltenJson, "json", false, "print the result as JSON")
	for _, cmd := range []*cobra.Command{moltenWorktreeLinkCmd, moltenWorktreeUnlinkCmd, moltenWorktreeShowCmd} {
		cmd.Flags().BoolVar(&moltenJson, "json", false, "print the result as JSON")
		moltenWorktreeCmd.AddCommand(cmd)
	}
}

func moltenWorktreeBlock() (waveobj.ORef, error) {
	if RpcContext.Conn != "" {
		return waveobj.ORef{}, fmt.Errorf("worktrees are linked from a local terminal (this one runs on %s)", RpcContext.Conn)
	}
	blockId := RpcContext.BlockId
	if blockId == "" {
		blockId = os.Getenv("WAVETERM_BLOCKID")
	}
	if blockId == "" {
		return waveobj.ORef{}, fmt.Errorf("not in a MoltenTerm terminal")
	}
	return waveobj.ORef{OType: waveobj.OType_Block, OID: blockId}, nil
}

func moltenWorktreeSetMeta(oref waveobj.ORef, meta map[string]any) error {
	err := wshclient.SetMetaCommand(RpcClient, wshrpc.CommandSetMetaData{ORef: oref, Meta: meta}, &wshrpc.RpcOpts{Timeout: MoltenRpcTimeoutMs})
	if err != nil {
		return fmt.Errorf("saving the terminal's link: %w", err)
	}
	return nil
}

func moltenWorktreeFolder(arg string) (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	if arg == "" {
		return cwd, nil
	}
	if !filepath.IsAbs(arg) {
		arg = filepath.Join(cwd, arg)
	}
	return filepath.Clean(arg), nil
}

func moltenWorktreeLinkRun(cmd *cobra.Command, args []string) error {
	oref, err := moltenWorktreeBlock()
	if err != nil {
		return err
	}
	arg := ""
	if len(args) > 0 {
		arg = args[0]
	}
	folder, err := moltenWorktreeFolder(arg)
	if err != nil {
		return err
	}
	info, err := molten.ResolveWorktree(folder)
	if err != nil {
		return err
	}
	if err := moltenWorktreeSetMeta(oref, map[string]any{molten.WorktreeMetaKey: info.Path}); err != nil {
		return err
	}
	if moltenJson {
		return moltenWriteJson(map[string]any{"terminal": oref.OID, "linked": info.Path, "branch": info.Branch, "main": info.Main})
	}
	branch := info.Branch
	if branch == "" {
		branch = "detached HEAD"
	}
	WriteStdout("linked this terminal to the worktree %s (%s) of %s\n", info.Path, branch, info.Main)
	return nil
}

func moltenWorktreeUnlinkRun(cmd *cobra.Command, args []string) error {
	oref, err := moltenWorktreeBlock()
	if err != nil {
		return err
	}
	meta, err := wshclient.GetMetaCommand(RpcClient, wshrpc.CommandGetMetaData{ORef: oref}, &wshrpc.RpcOpts{Timeout: MoltenRpcTimeoutMs})
	if err != nil {
		return fmt.Errorf("reading the terminal: %w", err)
	}
	linked := moltenMetaString(meta, molten.WorktreeMetaKey)
	if err := moltenWorktreeSetMeta(oref, map[string]any{molten.WorktreeMetaKey: nil}); err != nil {
		return err
	}
	if moltenJson {
		return moltenWriteJson(map[string]any{"terminal": oref.OID, "unlinked": linked})
	}
	if linked == "" {
		WriteStdout("this terminal was not linked to a worktree\n")
		return nil
	}
	WriteStdout("unlinked this terminal from %s (the worktree is untouched)\n", linked)
	return nil
}

func moltenWorktreeShowRun(cmd *cobra.Command, args []string) error {
	oref, err := moltenWorktreeBlock()
	if err != nil {
		return err
	}
	meta, err := wshclient.GetMetaCommand(RpcClient, wshrpc.CommandGetMetaData{ORef: oref}, &wshrpc.RpcOpts{Timeout: MoltenRpcTimeoutMs})
	if err != nil {
		return fmt.Errorf("reading the terminal: %w", err)
	}
	folder, err := moltenWorktreeFolder("")
	if err != nil {
		return err
	}
	status := MoltenWorktreeStatus{Terminal: oref.OID, Folder: folder, Linked: moltenMetaString(meta, molten.WorktreeMetaKey)}
	if status.Linked != "" {
		status.Missing = molten.WorktreeMissing(status.Linked)
	}
	if info, err := molten.ResolveWorktree(folder); err == nil {
		status.Worktree, status.Branch = info.Path, info.Branch
	}
	if moltenJson {
		return moltenWriteJson(status)
	}
	switch {
	case status.Linked == "":
		WriteStdout("this terminal is not linked to a worktree\n")
	case status.Missing:
		WriteStdout("this terminal is linked to %s, which no longer exists (molten worktree unlink)\n", status.Linked)
	default:
		WriteStdout("this terminal is linked to the worktree %s\n", status.Linked)
	}
	switch {
	case status.Worktree == "":
		WriteStdout("its folder is not in a linked worktree (main tree, or no repository)\n")
	case status.Worktree != status.Linked:
		WriteStdout("its folder is in the worktree %s (%s), not linked: molten worktree link\n", status.Worktree, status.Branch)
	}
	return nil
}
