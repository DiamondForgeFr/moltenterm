// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// `molten project group` (FR-MC-026): the product group of this workspace's project, as Mission Control resolves it
// from the workspace links and each member's `.molten/project.json`. It only reads: nothing runs in any member.

package cmd

import (
	"fmt"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten"
)

// must match pkg/molten/mission/group.go
const (
	moltenGroupsCommand   = "moltenmissiongroups"
	moltenGroupWorstRed   = "red"
	moltenGroupWorstAmber = "amber"
)

type moltenGroupMemberState struct {
	Missing     bool   `json:"missing,omitempty"`
	CollectedAt int64  `json:"collectedat,omitempty"`
	Trunk       string `json:"trunk,omitempty"`
	TrunkSha    string `json:"trunksha,omitempty"`
	TrunkCi     string `json:"trunkci,omitempty"`
	RemoteCi    string `json:"remoteci,omitempty"`
	RemoteCiUrl string `json:"remoteciurl,omitempty"`
	Build       string `json:"build,omitempty"`
	BuildId     string `json:"buildid,omitempty"`
	BuildAt     int64  `json:"buildat,omitempty"`
	ReleaseTag  string `json:"releasetag,omitempty"`
	LastTag     string `json:"lasttag,omitempty"`
	Worst       string `json:"worst,omitempty"`
}

type moltenGroupMember struct {
	molten.GroupMember
	State moltenGroupMemberState `json:"state"`
	// This workspace's project.
	Current bool `json:"current,omitempty"`
}

type moltenGroup struct {
	Key     string              `json:"key"`
	Name    string              `json:"name"`
	Members []moltenGroupMember `json:"members"`
	Worst   string              `json:"worst,omitempty"`
}

type MoltenProjectGroupStatus struct {
	Workspace string `json:"workspace"`
	Linked    bool   `json:"linked"`
	Dir       string `json:"dir,omitempty"`
	Project   string `json:"project,omitempty"`
	// The group the project's file declares, even when the project is not read as a member.
	Declared string       `json:"declared,omitempty"`
	Group    *moltenGroup `json:"group"`
}

var moltenProjectGroupCmd = &cobra.Command{
	Use:     "group",
	Short:   "list this workspace's project group: each member with its workspace, folder and state",
	Args:    cobra.NoArgs,
	RunE:    moltenWrap(moltenProjectGroupRun),
	PreRunE: preRunSetupRpcClient,
}

func init() {
	moltenProjectGroupCmd.Flags().BoolVar(&moltenJson, "json", false, "print the result as JSON")
	moltenProjectCmd.AddCommand(moltenProjectGroupCmd)
}

func moltenProjectGroupRun(cmd *cobra.Command, args []string) error {
	oref, err := moltenProjectWorkspace()
	if err != nil {
		return err
	}
	meta, err := moltenProjectGetMeta(oref)
	if err != nil {
		return err
	}
	status := MoltenProjectGroupStatus{Workspace: oref.OID, Dir: moltenMetaString(meta, molten.ProjectMetaKey)}
	status.Linked = status.Dir != ""
	if status.Linked {
		info := molten.ReadProject(status.Dir)
		status.Project = info.Name
		status.Declared = info.Group
		var answer struct {
			Groups []moltenGroup `json:"groups"`
		}
		if err := moltenCiRequest(moltenGroupsCommand, map[string]any{"dir": status.Dir}, &answer); err != nil {
			return fmt.Errorf("asking Mission Control for the group: %w", err)
		}
		if len(answer.Groups) > 0 {
			status.Group = &answer.Groups[0]
			for i := range status.Group.Members {
				status.Group.Members[i].Current = status.Group.Members[i].Dir == status.Dir
			}
		}
	}
	if moltenJson {
		return moltenWriteJson(status)
	}
	WriteStdout("%s", formatMoltenProjectGroup(status))
	return nil
}

func formatMoltenProjectGroup(status MoltenProjectGroupStatus) string {
	var sb strings.Builder
	switch {
	case !status.Linked:
		sb.WriteString("this workspace is not linked to a project; link it with: molten project link [folder]\n")
		return sb.String()
	case status.Group == nil && status.Declared != "":
		fmt.Fprintf(&sb, "%s declares the group %q but is not read as a member: %s is not its repository's root\n", status.Project, status.Declared, status.Dir)
		return sb.String()
	case status.Group == nil:
		fmt.Fprintf(&sb, "%s is in no group; to join one, add \"group\": \"<product>\" to %s in each repository of the product\n", status.Project, molten.ProjectPipelineFile)
		return sb.String()
	}
	group := status.Group
	fmt.Fprintf(&sb, "%s: %s", group.Name, moltenCount(len(group.Members), "member", "members"))
	if badge := formatMoltenGroupWorst(group.Worst); badge != "" {
		fmt.Fprintf(&sb, " (%s)", badge)
	}
	sb.WriteString("\n")
	for _, member := range group.Members {
		name := member.Name
		if member.Current {
			name += " (this workspace)"
		}
		fmt.Fprintf(&sb, "  %s\n", name)
		workspaces := make([]string, 0, len(member.Workspaces))
		for _, ws := range member.Workspaces {
			if ws.Name == "" {
				workspaces = append(workspaces, "unsaved workspace")
				continue
			}
			workspaces = append(workspaces, ws.Name)
		}
		label := "workspace"
		if len(workspaces) > 1 {
			label = "workspaces"
		}
		fmt.Fprintf(&sb, "    %s: %s\n", label, strings.Join(workspaces, ", "))
		fmt.Fprintf(&sb, "    folder: %s\n", member.Dir)
		fmt.Fprintf(&sb, "    state: %s\n", formatMoltenGroupState(member.State))
	}
	if len(group.Members) == 1 {
		sb.WriteString("  no other linked project declares this group yet: the rail shows it as an ordinary workspace\n")
	}
	return sb.String()
}

func formatMoltenGroupWorst(worst string) string {
	switch worst {
	case moltenGroupWorstRed:
		return "red: a CI or a build failed"
	case moltenGroupWorstAmber:
		return "amber: a dependency is stale"
	}
	return ""
}

var moltenGroupCiWords = map[string]string{
	moltenCiStatusGreen:   "green",
	moltenCiStatusRed:     "red",
	moltenCiStatusRunning: "running",
	"missing":             "not run",
}

func formatMoltenGroupState(state moltenGroupMemberState) string {
	if state.Missing {
		return "the folder no longer exists"
	}
	if state.CollectedAt == 0 {
		return "not read yet (open the Project tab of its workspace)"
	}
	var parts []string
	trunk := state.Trunk
	if trunk == "" {
		trunk = "the trunk"
	}
	if word := moltenGroupCiWords[state.TrunkCi]; word != "" {
		parts = append(parts, fmt.Sprintf("local CI %s on %s", word, trunk))
	}
	if word := moltenGroupCiWords[state.RemoteCi]; word != "" {
		parts = append(parts, fmt.Sprintf("GitHub CI %s on %s", word, trunk))
	}
	if state.Build != "" {
		build := strings.Join(strings.Fields("last build "+state.BuildId+" "+state.Build), " ")
		if state.BuildAt > 0 {
			build += time.UnixMilli(state.BuildAt).Format(" (2006-01-02 15:04)")
		}
		parts = append(parts, build)
	}
	switch {
	case state.ReleaseTag != "" && state.LastTag != "" && state.LastTag != state.ReleaseTag:
		parts = append(parts, fmt.Sprintf("release %s, newest tag %s", state.ReleaseTag, state.LastTag))
	case state.ReleaseTag != "":
		parts = append(parts, "release "+state.ReleaseTag)
	case state.LastTag != "":
		parts = append(parts, "no public release, newest tag "+state.LastTag)
	}
	if len(parts) == 0 {
		return "nothing to report"
	}
	text := strings.Join(parts, ", ")
	if badge := formatMoltenGroupWorst(state.Worst); badge != "" {
		text += "; " + badge
	}
	return text
}
