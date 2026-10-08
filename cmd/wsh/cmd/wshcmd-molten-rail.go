// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// `molten rail group` (FR-MC-032-AC10): the rail's local groups from a terminal, the same commands as the link bud and
// the rail's menus (DS-MC-028). wavesrv writes them; nothing is written in any project.

package cmd

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// must match pkg/molten/railorder/order.go and localgroups.go
const (
	moltenRailRoute          = "molten:railorder"
	moltenRailJoinCommand    = "railgroupjoin"
	moltenRailLeaveCommand   = "railgroupleave"
	moltenRailRenameCommand  = "railgrouprename"
	moltenRailUngroupCommand = "railgroupungroup"
	moltenRailListCommand    = "railgrouplist"
	moltenRailRpcTimeoutMs   = 10000
)

type moltenRailWorkspace struct {
	Id      string `json:"id"`
	Name    string `json:"name"`
	Group   string `json:"group,omitempty"`
	Product string `json:"product,omitempty"`
}

type moltenRailGroup struct {
	Id      string   `json:"id"`
	Name    string   `json:"name"`
	Renamed bool     `json:"renamed,omitempty"`
	Members []string `json:"members"`
}

type MoltenRailList struct {
	Workspaces []moltenRailWorkspace `json:"workspaces"`
	Groups     []moltenRailGroup     `json:"groups"`
}

var moltenRailGroupTo string

var moltenRailCmd = &cobra.Command{
	Use:     "rail",
	Short:   "the workspace rail",
	RunE:    moltenModRun,
	PreRunE: preRunSetupRpcClient,
}

var moltenRailGroupCmd = &cobra.Command{
	Use:     "group",
	Short:   "group workspaces in the rail (MoltenTerm's own groups, never written in a project)",
	RunE:    moltenModRun,
	PreRunE: preRunSetupRpcClient,
}

var moltenRailGroupListCmd = &cobra.Command{
	Use:     "list",
	Short:   "list the rail's groups and their workspaces",
	Args:    cobra.NoArgs,
	RunE:    moltenWrap(moltenRailGroupListRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenRailGroupAddCmd = &cobra.Command{
	Use:     "add [workspace] --to <workspace|group>",
	Short:   "group a workspace (default: this terminal's) with another workspace, or add it to a group",
	Args:    cobra.MaximumNArgs(1),
	RunE:    moltenWrap(moltenRailGroupAddRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenRailGroupRemoveCmd = &cobra.Command{
	Use:     "remove [workspace]",
	Short:   "take a workspace (default: this terminal's) out of its group; it then sits right after the group",
	Args:    cobra.MaximumNArgs(1),
	RunE:    moltenWrap(moltenRailGroupRemoveRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenRailGroupRenameCmd = &cobra.Command{
	Use:     "rename <group> [name]",
	Short:   "name a group (1 to 64 characters); without a name it takes its first workspace's name again",
	Args:    cobra.RangeArgs(1, 2),
	RunE:    moltenWrap(moltenRailGroupRenameRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenRailGroupUngroupCmd = &cobra.Command{
	Use:     "ungroup <group>",
	Short:   "dissolve a group; its workspaces stay where they are",
	Args:    cobra.ExactArgs(1),
	RunE:    moltenWrap(moltenRailGroupUngroupRun),
	PreRunE: preRunSetupRpcClient,
}

func init() {
	moltenRailGroupAddCmd.Flags().StringVar(&moltenRailGroupTo, "to", "", "the workspace or group to join (name or id)")
	moltenCmd.AddCommand(moltenRailCmd)
	moltenRailCmd.AddCommand(moltenRailGroupCmd)
	for _, cmd := range []*cobra.Command{moltenRailGroupListCmd, moltenRailGroupAddCmd, moltenRailGroupRemoveCmd, moltenRailGroupRenameCmd, moltenRailGroupUngroupCmd} {
		cmd.Flags().BoolVar(&moltenJson, "json", false, "print the result as JSON")
		moltenRailGroupCmd.AddCommand(cmd)
	}
}

func moltenRailRequest(command string, data any) (MoltenRailList, error) {
	var list MoltenRailList
	if RpcContext.Conn != "" {
		return list, fmt.Errorf("the rail is grouped from a local terminal (this one runs on %s)", RpcContext.Conn)
	}
	resp, err := RpcClient.SendRpcRequest(command, data, &wshrpc.RpcOpts{Route: moltenRailRoute, Timeout: moltenRailRpcTimeoutMs})
	if err != nil {
		return list, err
	}
	err = utilfn.ReUnmarshal(&list, resp)
	return list, err
}

// moltenRailFindWorkspace finds a saved workspace by id or name (case ignored); a name two workspaces share is refused.
func moltenRailFindWorkspace(list MoltenRailList, ref string) (moltenRailWorkspace, error) {
	ref = strings.TrimSpace(ref)
	var found []moltenRailWorkspace
	for _, ws := range list.Workspaces {
		if ws.Id == ref {
			return ws, nil
		}
		if strings.EqualFold(ws.Name, ref) {
			found = append(found, ws)
		}
	}
	switch len(found) {
	case 0:
		return moltenRailWorkspace{}, fmt.Errorf("no saved workspace named %q (molten rail group list shows them)", ref)
	case 1:
		return found[0], nil
	}
	return moltenRailWorkspace{}, fmt.Errorf("%d workspaces are named %q: name one by its id (molten rail group list --json)", len(found), ref)
}

// moltenRailFindGroup finds a group by id or shown name (case ignored).
func moltenRailFindGroup(list MoltenRailList, ref string) (moltenRailGroup, error) {
	ref = strings.TrimSpace(ref)
	var found []moltenRailGroup
	for _, group := range list.Groups {
		if group.Id == ref {
			return group, nil
		}
		if strings.EqualFold(group.Name, ref) {
			found = append(found, group)
		}
	}
	switch len(found) {
	case 0:
		return moltenRailGroup{}, fmt.Errorf("no group named %q in the rail (molten rail group list shows them)", ref)
	case 1:
		return found[0], nil
	}
	return moltenRailGroup{}, fmt.Errorf("%d groups are named %q: name one by its id (molten rail group list --json)", len(found), ref)
}

// moltenRailFindTarget finds what a workspace joins: a workspace first (a group named after its first workspace is
// that workspace's group anyway), else a group.
func moltenRailFindTarget(list MoltenRailList, ref string) (string, error) {
	if ws, err := moltenRailFindWorkspace(list, ref); err == nil {
		return ws.Id, nil
	} else if !strings.HasPrefix(err.Error(), "no saved workspace") {
		return "", err
	}
	group, err := moltenRailFindGroup(list, ref)
	if err != nil {
		return "", fmt.Errorf("no saved workspace or group named %q (molten rail group list shows them)", strings.TrimSpace(ref))
	}
	return group.Id, nil
}

// moltenRailWorkspaceArg is the named workspace, or this terminal's.
func moltenRailWorkspaceArg(list MoltenRailList, args []string) (moltenRailWorkspace, error) {
	if len(args) > 0 {
		return moltenRailFindWorkspace(list, args[0])
	}
	oref, err := resolveSimpleId("workspace")
	if err != nil {
		return moltenRailWorkspace{}, fmt.Errorf("finding this terminal's workspace: %w", err)
	}
	return moltenRailFindWorkspace(list, oref.OID)
}

func moltenRailDone(list MoltenRailList, message string) error {
	if moltenJson {
		return moltenWriteJson(list)
	}
	WriteStdout("%s\n", message)
	return nil
}

func moltenRailGroupListRun(cmd *cobra.Command, args []string) error {
	list, err := moltenRailRequest(moltenRailListCommand, nil)
	if err != nil {
		return err
	}
	if moltenJson {
		return moltenWriteJson(list)
	}
	WriteStdout("%s", formatMoltenRailList(list))
	return nil
}

func moltenRailGroupAddRun(cmd *cobra.Command, args []string) error {
	if strings.TrimSpace(moltenRailGroupTo) == "" {
		return fmt.Errorf("say which workspace or group to join with --to")
	}
	list, err := moltenRailRequest(moltenRailListCommand, nil)
	if err != nil {
		return err
	}
	ws, err := moltenRailWorkspaceArg(list, args)
	if err != nil {
		return err
	}
	targetId, err := moltenRailFindTarget(list, moltenRailGroupTo)
	if err != nil {
		return err
	}
	list, err = moltenRailRequest(moltenRailJoinCommand, map[string]any{"workspaceid": ws.Id, "targetid": targetId})
	if err != nil {
		return err
	}
	return moltenRailDone(list, fmt.Sprintf("%s is in the group %s", ws.Name, moltenRailGroupNameOf(list, ws.Id)))
}

func moltenRailGroupRemoveRun(cmd *cobra.Command, args []string) error {
	list, err := moltenRailRequest(moltenRailListCommand, nil)
	if err != nil {
		return err
	}
	ws, err := moltenRailWorkspaceArg(list, args)
	if err != nil {
		return err
	}
	group := moltenRailGroupNameOf(list, ws.Id)
	list, err = moltenRailRequest(moltenRailLeaveCommand, map[string]any{"workspaceid": ws.Id})
	if err != nil {
		return err
	}
	return moltenRailDone(list, fmt.Sprintf("%s left the group %s", ws.Name, group))
}

func moltenRailGroupRenameRun(cmd *cobra.Command, args []string) error {
	list, err := moltenRailRequest(moltenRailListCommand, nil)
	if err != nil {
		return err
	}
	group, err := moltenRailFindGroup(list, args[0])
	if err != nil {
		return err
	}
	name := ""
	if len(args) > 1 {
		name = args[1]
	}
	list, err = moltenRailRequest(moltenRailRenameCommand, map[string]any{"groupid": group.Id, "name": name})
	if err != nil {
		return err
	}
	for _, g := range list.Groups {
		if g.Id == group.Id {
			if !g.Renamed {
				return moltenRailDone(list, fmt.Sprintf("the group is named after its first workspace again: %s", g.Name))
			}
			return moltenRailDone(list, fmt.Sprintf("the group is named %s", g.Name))
		}
	}
	return moltenRailDone(list, "the group is gone")
}

func moltenRailGroupUngroupRun(cmd *cobra.Command, args []string) error {
	list, err := moltenRailRequest(moltenRailListCommand, nil)
	if err != nil {
		return err
	}
	group, err := moltenRailFindGroup(list, args[0])
	if err != nil {
		return err
	}
	list, err = moltenRailRequest(moltenRailUngroupCommand, map[string]any{"groupid": group.Id})
	if err != nil {
		return err
	}
	return moltenRailDone(list, fmt.Sprintf("the group %s is dissolved; its workspaces stay in place", group.Name))
}

func moltenRailGroupNameOf(list MoltenRailList, wsId string) string {
	for _, group := range list.Groups {
		for _, id := range group.Members {
			if id == wsId {
				return group.Name
			}
		}
	}
	return "(none)"
}

func formatMoltenRailList(list MoltenRailList) string {
	var sb strings.Builder
	names := map[string]string{}
	for _, ws := range list.Workspaces {
		names[ws.Id] = ws.Name
	}
	if len(list.Groups) == 0 {
		sb.WriteString("no groups in the rail; make one with: molten rail group add <workspace> --to <workspace>\n")
	}
	for _, group := range list.Groups {
		members := make([]string, 0, len(group.Members))
		for _, id := range group.Members {
			members = append(members, names[id])
		}
		label := group.Name
		if !group.Renamed {
			label += " (named after its first workspace)"
		}
		fmt.Fprintf(&sb, "%s: %s\n", label, strings.Join(members, ", "))
	}
	var products []string
	seen := map[string]bool{}
	for _, ws := range list.Workspaces {
		if ws.Product != "" && !seen[ws.Product] {
			seen[ws.Product] = true
			products = append(products, ws.Product)
		}
	}
	if len(products) > 0 {
		fmt.Fprintf(&sb, "project groups (declared in their projects, not changed here): %s\n", strings.Join(products, ", "))
	}
	return sb.String()
}
