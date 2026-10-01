// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The molten command group (FR-MORPH-005, DS-MORPH-004). The mod host runs in each tab's renderer, so molten asks
// the tab it runs in. It sends a plain command name over the tab route instead of declaring an RPC type in
// pkg/wshrpc, the package upstream changes most.

package cmd

import (
	"encoding/json"
	"fmt"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// must match MoltenModListRpcCommand in frontend/molten/molten-start.ts
const MoltenModListRpcCommand = "moltenmodlist"

const MoltenRpcTimeoutMs = 5000

type MoltenModStatus struct {
	Id       string   `json:"id"`
	Name     string   `json:"name,omitempty"`
	Version  string   `json:"version,omitempty"`
	Path     string   `json:"path"`
	State    string   `json:"state"`
	Error    string   `json:"error,omitempty"`
	Commands []string `json:"commands"`
}

type MoltenModList struct {
	ApiVersions []int             `json:"apiversions"`
	SafeMode    bool              `json:"safemode"`
	ModsDir     string            `json:"modsdir"`
	Mods        []MoltenModStatus `json:"mods"`
}

var moltenModListJson bool

var moltenCmd = &cobra.Command{
	Use:   "molten",
	Short: "drive Moltenterm mods",
}

var moltenModCmd = &cobra.Command{
	Use:   "mod",
	Short: "manage mods",
}

var moltenModListCmd = &cobra.Command{
	Use:     "list",
	Short:   "list the mods of this tab and their state",
	Args:    cobra.NoArgs,
	RunE:    moltenModListRun,
	PreRunE: preRunSetupRpcClient,
}

func init() {
	moltenModListCmd.Flags().BoolVar(&moltenModListJson, "json", false, "print the list as JSON")
	rootCmd.AddCommand(moltenCmd)
	moltenCmd.AddCommand(moltenModCmd)
	moltenModCmd.AddCommand(moltenModListCmd)
}

func moltenModListRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("molten", rtnErr == nil)
	}()
	list, err := moltenGetModList()
	if err != nil {
		return err
	}
	if moltenModListJson {
		out, err := json.MarshalIndent(list, "", "  ")
		if err != nil {
			return fmt.Errorf("encoding the mod list: %w", err)
		}
		WriteStdout("%s\n", out)
		return nil
	}
	WriteStdout("%s", formatMoltenModList(list))
	return nil
}

func moltenGetModList() (*MoltenModList, error) {
	tabId := getTabIdFromEnv()
	if tabId == "" {
		return nil, fmt.Errorf("molten must run in a Moltenterm terminal (WAVETERM_TABID is not set)")
	}
	resp, err := RpcClient.SendRpcRequest(MoltenModListRpcCommand, nil, &wshrpc.RpcOpts{
		Route:   wshutil.MakeTabRouteId(tabId),
		Timeout: MoltenRpcTimeoutMs,
	})
	if err != nil {
		return nil, fmt.Errorf("asking this tab for its mods: %w", err)
	}
	if resp == nil {
		return nil, fmt.Errorf("this tab did not answer: its mod host has not started")
	}
	var list MoltenModList
	err = utilfn.ReUnmarshal(&list, resp)
	if err != nil {
		return nil, fmt.Errorf("reading the mod list: %w", err)
	}
	return &list, nil
}

func formatMoltenModList(list *MoltenModList) string {
	var sb strings.Builder
	if list.SafeMode {
		sb.WriteString("safe mode: no mod is loaded\n")
	}
	if len(list.Mods) == 0 {
		fmt.Fprintf(&sb, "no mods in %s\n", list.ModsDir)
		return sb.String()
	}
	tw := tabwriter.NewWriter(&sb, 0, 0, 2, ' ', 0)
	fmt.Fprintf(tw, "ID\tSTATE\tVERSION\tCOMMANDS\tERROR\n")
	for _, mod := range list.Mods {
		version := mod.Version
		if version == "" {
			version = "-"
		}
		commands := strings.Join(mod.Commands, ",")
		if commands == "" {
			commands = "-"
		}
		errText := strings.ReplaceAll(mod.Error, "\n", " ")
		if errText == "" {
			errText = "-"
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", mod.Id, mod.State, version, commands, errText)
	}
	tw.Flush()
	return sb.String()
}
