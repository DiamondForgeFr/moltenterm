// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

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

// `molten bookmarks list` (FR-BRW-020, #2531): the web page bookmarks visible from this terminal, each once, with the
// places it has there (the terminal's project, workspace and context, and the app), its folder in each and the
// description the developer wrote. Agents only read them; the developer writes them in a window. The output is for
// agents: English, plain text, or JSON.

const moltenBookmarksTimeoutMs = 15000

var moltenBookmarksCmd = &cobra.Command{
	Use:   "bookmarks",
	Short: "the web page bookmarks visible from this terminal (read-only)",
}

var moltenBookmarksListCmd = &cobra.Command{
	Use:     "list",
	Short:   "list the bookmarks visible from here: title, address, places and description",
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
		return view, fmt.Errorf("not in a MoltenTerm terminal: molten bookmarks reads the bookmarks visible from the terminal it runs in")
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

// moltenBookmarksFrom names the places the list is read from: the project when the workspace has one, the workspace and
// its context.
func moltenBookmarksFrom(view molten.BookmarksView) string {
	var parts []string
	if name := oneLineTitle(view.Project.Name); name != "" {
		parts = append(parts, "project "+name)
	}
	if name := oneLineTitle(view.Workspace); name != "" {
		parts = append(parts, "workspace "+name)
	}
	if name := oneLineTitle(view.Context); name != "" {
		parts = append(parts, "context "+name)
	}
	if len(parts) == 0 {
		return "here"
	}
	return strings.Join(parts, ", ")
}

// moltenBookmarkPlace is one place of a bookmark: its level, the place's name (the app has none) and its folder there.
func moltenBookmarkPlace(p molten.BookmarkPlace) string {
	rtn := oneLineTitle(p.Level)
	if name := oneLineTitle(p.Name); name != "" {
		rtn += " " + name
	}
	if folder := oneLineTitle(p.Folder); folder != "" {
		rtn += " (folder " + folder + ")"
	}
	return rtn
}

// formatMoltenBookmarks lists the bookmarks in the order wavesrv gave them (the most specific place first), each with its
// places and the developer's note.
func formatMoltenBookmarks(view molten.BookmarksView) string {
	from := moltenBookmarksFrom(view)
	if len(view.Bookmarks) == 0 {
		return fmt.Sprintf("No bookmark is visible from %s yet. The developer adds one with the bookmark icon after Reload in the web page panel.\n", from)
	}
	var sb strings.Builder
	fmt.Fprintf(&sb, "Bookmarks visible from %s (%d):\n\n", from, len(view.Bookmarks))
	for _, b := range view.Bookmarks {
		address := b.Url
		if b.Withheld {
			address = "(address withheld: it carries a credential)"
		}
		title := oneLineTitle(b.Title)
		if title == "" {
			title = "(untitled)"
		}
		fmt.Fprintf(&sb, "- %s: %s\n", title, address)
		if len(b.Places) > 0 {
			places := make([]string, len(b.Places))
			for i, p := range b.Places {
				places[i] = moltenBookmarkPlace(p)
			}
			fmt.Fprintf(&sb, "  places: %s\n", strings.Join(places, ", "))
		}
		if b.Description != "" {
			fmt.Fprintf(&sb, "  %s\n", oneLineTitle(b.Description))
		}
	}
	return sb.String()
}
