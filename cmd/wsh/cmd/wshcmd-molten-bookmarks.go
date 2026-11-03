// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// `molten bookmarks list` (FR-BRW-020): the bookmarks of this terminal's project in the web page panel, with their
// folder and the description the developer wrote. Agents only read them; the developer writes them in a window. The
// output is for agents: English, plain text, or JSON.

const moltenBookmarksTimeoutMs = 15000

var moltenBookmarksCmd = &cobra.Command{
	Use:   "bookmarks",
	Short: "the web page bookmarks of this terminal's project (read-only)",
}

var moltenBookmarksListCmd = &cobra.Command{
	Use:     "list",
	Short:   "list the project's bookmarks: title, address, folder and description",
	Args:    cobra.NoArgs,
	RunE:    moltenWrap(moltenBookmarksListRun),
	PreRunE: preRunSetupRpcClient,
}

func init() {
	moltenCmd.AddCommand(moltenBookmarksCmd)
	moltenBookmarksListCmd.Flags().BoolVar(&moltenJson, "json", false, "print the bookmarks as a JSON array")
	moltenBookmarksCmd.AddCommand(moltenBookmarksListCmd)
}

func moltenBookmarksView() (molten.BookmarksView, error) {
	var view molten.BookmarksView
	blockId := RpcContext.BlockId
	if blockId == "" {
		blockId = os.Getenv("WAVETERM_BLOCKID")
	}
	if blockId == "" {
		return view, fmt.Errorf("not in a MoltenTerm terminal: molten bookmarks reads the project of the terminal it runs in")
	}
	req := molten.BookmarksRequest{BlockId: blockId}
	resp, err := RpcClient.SendRpcRequest(molten.BookmarksListCommand, req, &wshrpc.RpcOpts{Route: molten.BookmarksRoute, Timeout: moltenBookmarksTimeoutMs})
	if err != nil {
		return view, err
	}
	err = utilfn.ReUnmarshal(&view, resp)
	return view, err
}

func moltenBookmarksListRun(cmd *cobra.Command, args []string) error {
	view, err := moltenBookmarksView()
	if err != nil {
		return err
	}
	if moltenJson {
		if view.Bookmarks == nil {
			view.Bookmarks = []molten.Bookmark{}
		}
		return moltenWriteJson(view.Bookmarks)
	}
	WriteStdout("%s", formatMoltenBookmarks(view))
	return nil
}

// formatMoltenBookmarks groups the bookmarks by folder, in the order wavesrv gave them (those outside folders first).
func formatMoltenBookmarks(view molten.BookmarksView) string {
	if len(view.Bookmarks) == 0 {
		return fmt.Sprintf("No bookmark in project %s yet. The developer adds them from the web page panel's Bookmarks button.\n", view.Project.Name)
	}
	var sb strings.Builder
	fmt.Fprintf(&sb, "Bookmarks of project %s (%d):\n", view.Project.Name, len(view.Bookmarks))
	folder := ""
	for i, b := range view.Bookmarks {
		if i == 0 || b.Folder != folder {
			folder = b.Folder
			if folder != "" {
				fmt.Fprintf(&sb, "\nFolder %s\n", oneLineTitle(folder))
			} else {
				sb.WriteString("\n")
			}
		}
		address := b.Url
		if b.Withheld {
			address = "(address withheld: it carries a credential)"
		}
		fmt.Fprintf(&sb, "- %s: %s\n", oneLineTitle(b.Title), address)
		if b.Description != "" {
			fmt.Fprintf(&sb, "  %s\n", oneLineTitle(b.Description))
		}
	}
	return sb.String()
}
