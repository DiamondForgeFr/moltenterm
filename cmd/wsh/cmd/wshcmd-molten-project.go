// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// `molten project` (FR-MC-001): the workspace the terminal belongs to is linked to one project folder, stored in the
// workspace's meta. Mission Control shows the project of the active workspace. Nothing is written in the project.

package cmd

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

var moltenProjectLogo string
var moltenProjectNoLogo bool
var moltenProjectLogoClear bool

type MoltenProjectStatus struct {
	Workspace string              `json:"workspace"`
	Linked    bool                `json:"linked"`
	Logo      string              `json:"logo,omitempty"`
	Project   *molten.ProjectInfo `json:"project,omitempty"`
	Logos     []string            `json:"logos,omitempty"`
}

var moltenProjectCmd = &cobra.Command{
	Use:     "project",
	Short:   "link this workspace to its project",
	RunE:    moltenModRun,
	PreRunE: preRunSetupRpcClient,
}

var moltenProjectLinkCmd = &cobra.Command{
	Use:     "link [folder]",
	Short:   "link this workspace to a project folder (default: this terminal's folder, raised to its git root)",
	Args:    cobra.MaximumNArgs(1),
	RunE:    moltenWrap(moltenProjectLinkRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenProjectUnlinkCmd = &cobra.Command{
	Use:     "unlink",
	Short:   "remove this workspace's project link (the project's files are not touched)",
	Args:    cobra.NoArgs,
	RunE:    moltenWrap(moltenProjectUnlinkRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenProjectShowCmd = &cobra.Command{
	Use:     "show",
	Short:   "show this workspace's project",
	Args:    cobra.NoArgs,
	RunE:    moltenWrap(moltenProjectShowRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenProjectLogoCmd = &cobra.Command{
	Use:     "logo [file]",
	Short:   "use an image of the project as the workspace icon (no file: list the images found)",
	Args:    cobra.MaximumNArgs(1),
	RunE:    moltenWrap(moltenProjectLogoRun),
	PreRunE: preRunSetupRpcClient,
}

func init() {
	moltenProjectLinkCmd.Flags().StringVar(&moltenProjectLogo, "logo", "", "use this image as the workspace icon")
	moltenProjectLinkCmd.Flags().BoolVar(&moltenProjectNoLogo, "no-logo", false, "keep the workspace's icon")
	moltenProjectLogoCmd.Flags().BoolVar(&moltenProjectLogoClear, "clear", false, "go back to the workspace's icon")
	moltenCmd.AddCommand(moltenProjectCmd)
	for _, cmd := range []*cobra.Command{moltenProjectLinkCmd, moltenProjectUnlinkCmd, moltenProjectShowCmd, moltenProjectLogoCmd} {
		cmd.Flags().BoolVar(&moltenJson, "json", false, "print the result as JSON")
		moltenProjectCmd.AddCommand(cmd)
	}
}

func moltenProjectWorkspace() (waveobj.ORef, error) {
	if RpcContext.Conn != "" {
		return waveobj.ORef{}, fmt.Errorf("projects are linked from a local terminal (this one runs on %s)", RpcContext.Conn)
	}
	oref, err := resolveSimpleId("workspace")
	if err != nil {
		return waveobj.ORef{}, fmt.Errorf("finding this terminal's workspace: %w", err)
	}
	return *oref, nil
}

func moltenProjectGetMeta(oref waveobj.ORef) (map[string]any, error) {
	meta, err := wshclient.GetMetaCommand(RpcClient, wshrpc.CommandGetMetaData{ORef: oref}, &wshrpc.RpcOpts{Timeout: MoltenRpcTimeoutMs})
	if err != nil {
		return nil, fmt.Errorf("reading the workspace: %w", err)
	}
	return meta, nil
}

func moltenProjectSetMeta(oref waveobj.ORef, meta map[string]any) error {
	err := wshclient.SetMetaCommand(RpcClient, wshrpc.CommandSetMetaData{ORef: oref, Meta: meta}, &wshrpc.RpcOpts{Timeout: MoltenRpcTimeoutMs})
	if err != nil {
		return fmt.Errorf("saving the workspace: %w", err)
	}
	return nil
}

func moltenMetaString(meta map[string]any, key string) string {
	value, _ := meta[key].(string)
	return value
}

// moltenProjectCheckLogo accepts an image inside the project or anywhere else the user points to; it must exist.
func moltenProjectCheckLogo(file string, projectDir string) (string, error) {
	if !filepath.IsAbs(file) {
		cwd, _ := os.Getwd()
		if _, err := os.Stat(filepath.Join(projectDir, file)); err == nil {
			file = filepath.Join(projectDir, file)
		} else {
			file = filepath.Join(cwd, file)
		}
	}
	file = filepath.Clean(file)
	if !molten.IsProjectLogoFile(file) {
		return "", fmt.Errorf("%s is not an image (svg, png, ico, jpg, webp or gif)", file)
	}
	stat, err := os.Stat(file)
	if err != nil {
		return "", err
	}
	if !stat.Mode().IsRegular() {
		return "", fmt.Errorf("%s is not a file", file)
	}
	return file, nil
}

func moltenProjectLinkRun(cmd *cobra.Command, args []string) error {
	if moltenProjectLogo != "" && moltenProjectNoLogo {
		return fmt.Errorf("--logo and --no-logo cannot be used together")
	}
	oref, err := moltenProjectWorkspace()
	if err != nil {
		return err
	}
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}
	arg := ""
	if len(args) > 0 {
		arg = args[0]
	}
	dir, err := molten.ResolveProjectDir(arg, cwd)
	if err != nil {
		return err
	}
	meta, err := moltenProjectGetMeta(oref)
	if err != nil {
		return err
	}
	update := map[string]any{molten.ProjectMetaKey: dir}
	logo := moltenMetaString(meta, molten.ProjectLogoMetaKey)
	// A logo chosen for another project would now stand for the wrong one.
	if moltenMetaString(meta, molten.ProjectMetaKey) != dir || moltenProjectNoLogo {
		logo = ""
	}
	if moltenProjectLogo != "" {
		logo, err = moltenProjectCheckLogo(moltenProjectLogo, dir)
		if err != nil {
			return err
		}
	}
	update[molten.ProjectLogoMetaKey] = moltenMetaOrNil(logo)
	err = moltenProjectSetMeta(oref, update)
	if err != nil {
		return err
	}
	status := moltenMakeProjectStatus(oref, dir, logo)
	if moltenJson {
		return moltenWriteJson(status)
	}
	WriteStdout("linked this workspace to %s (%s)\n", status.Project.Name, dir)
	WriteStdout("%s", formatMoltenProjectDetails(status))
	return nil
}

func moltenMetaOrNil(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func moltenMakeProjectStatus(oref waveobj.ORef, dir string, logo string) MoltenProjectStatus {
	status := MoltenProjectStatus{Workspace: oref.OID, Linked: dir != "", Logo: logo}
	if dir == "" {
		return status
	}
	info := molten.ReadProject(dir)
	status.Project = &info
	if info.Exists {
		status.Logos = molten.FindProjectLogos(dir)
	}
	return status
}

func moltenProjectUnlinkRun(cmd *cobra.Command, args []string) error {
	oref, err := moltenProjectWorkspace()
	if err != nil {
		return err
	}
	meta, err := moltenProjectGetMeta(oref)
	if err != nil {
		return err
	}
	dir := moltenMetaString(meta, molten.ProjectMetaKey)
	err = moltenProjectSetMeta(oref, map[string]any{molten.ProjectMetaKey: nil, molten.ProjectLogoMetaKey: nil})
	if err != nil {
		return err
	}
	if moltenJson {
		return moltenWriteJson(map[string]any{"workspace": oref.OID, "unlinked": dir})
	}
	if dir == "" {
		WriteStdout("this workspace was not linked to a project\n")
		return nil
	}
	WriteStdout("unlinked this workspace from %s (the project's files are untouched)\n", dir)
	return nil
}

func moltenProjectShowRun(cmd *cobra.Command, args []string) error {
	oref, err := moltenProjectWorkspace()
	if err != nil {
		return err
	}
	meta, err := moltenProjectGetMeta(oref)
	if err != nil {
		return err
	}
	status := moltenMakeProjectStatus(oref, moltenMetaString(meta, molten.ProjectMetaKey), moltenMetaString(meta, molten.ProjectLogoMetaKey))
	if moltenJson {
		return moltenWriteJson(status)
	}
	if !status.Linked {
		WriteStdout("this workspace is not linked to a project; link it with: molten project link [folder]\n")
		return nil
	}
	WriteStdout("%s (%s)\n", status.Project.Name, status.Project.Dir)
	WriteStdout("%s", formatMoltenProjectDetails(status))
	return nil
}

func moltenProjectLogoRun(cmd *cobra.Command, args []string) error {
	oref, err := moltenProjectWorkspace()
	if err != nil {
		return err
	}
	meta, err := moltenProjectGetMeta(oref)
	if err != nil {
		return err
	}
	dir := moltenMetaString(meta, molten.ProjectMetaKey)
	if dir == "" {
		return fmt.Errorf("this workspace is not linked to a project; link it with: molten project link [folder]")
	}
	if moltenProjectLogoClear && len(args) > 0 {
		return fmt.Errorf("give a file or --clear, not both")
	}
	if len(args) == 0 && !moltenProjectLogoClear {
		status := moltenMakeProjectStatus(oref, dir, moltenMetaString(meta, molten.ProjectLogoMetaKey))
		if moltenJson {
			return moltenWriteJson(map[string]any{"logo": status.Logo, "logos": status.Logos})
		}
		WriteStdout("%s", formatMoltenProjectLogos(status))
		return nil
	}
	logo := ""
	if len(args) > 0 {
		logo, err = moltenProjectCheckLogo(args[0], dir)
		if err != nil {
			return err
		}
	}
	err = moltenProjectSetMeta(oref, map[string]any{molten.ProjectLogoMetaKey: moltenMetaOrNil(logo)})
	if err != nil {
		return err
	}
	if moltenJson {
		return moltenWriteJson(map[string]any{"logo": logo})
	}
	if logo == "" {
		WriteStdout("the workspace shows its own icon again\n")
		return nil
	}
	WriteStdout("the workspace shows %s as its icon\n", logo)
	return nil
}

func formatMoltenProjectDetails(status MoltenProjectStatus) string {
	var sb strings.Builder
	info := status.Project
	if info == nil {
		return ""
	}
	if !info.Exists {
		sb.WriteString("  the folder no longer exists: link the workspace again or unlink it\n")
		return sb.String()
	}
	switch {
	case info.HasPipeline:
		fmt.Fprintf(&sb, "  pipeline: %s\n", molten.ProjectPipelineFile)
	case info.PipelineError != "":
		fmt.Fprintf(&sb, "  pipeline: %s cannot be read (%s)\n", molten.ProjectPipelineFile, info.PipelineError)
	default:
		sb.WriteString("  pipeline: none yet (Mission Control will offer to have your agent create it)\n")
	}
	if conv := info.Conventions; conv != nil {
		fmt.Fprintf(&sb, "  harness: SaaSFoundryAI (%s)\n", molten.ProjectSaaSFoundryFile)
		if conv.WorkingBranch != "" {
			fmt.Fprintf(&sb, "  working branch: %s, pull requests into %s\n", conv.WorkingBranch, conv.PrTargetBranch)
		}
		if len(conv.BranchNaming) > 0 {
			kinds := make([]string, 0, len(conv.BranchNaming))
			for kind := range conv.BranchNaming {
				kinds = append(kinds, kind)
			}
			sort.Strings(kinds)
			for _, kind := range kinds {
				fmt.Fprintf(&sb, "  %s branches: %s\n", kind, conv.BranchNaming[kind])
			}
		}
		if conv.CommitPattern != "" {
			fmt.Fprintf(&sb, "  commits: %s\n", conv.CommitPattern)
		}
	}
	sb.WriteString(formatMoltenProjectLogos(status))
	return sb.String()
}

func formatMoltenProjectLogos(status MoltenProjectStatus) string {
	var sb strings.Builder
	if status.Logo != "" {
		fmt.Fprintf(&sb, "  icon: %s (back to the workspace's icon: molten project logo --clear)\n", status.Logo)
		return sb.String()
	}
	if len(status.Logos) == 0 {
		sb.WriteString("  icon: the workspace's own (no project image found; use one with: molten project logo <file>)\n")
		return sb.String()
	}
	sb.WriteString("  icon: the workspace's own; images of the project that could replace it:\n")
	for _, logo := range status.Logos {
		fmt.Fprintf(&sb, "    %s\n", logo)
	}
	sb.WriteString("  use one with: molten project logo <file> (or from the workspace editor)\n")
	return sb.String()
}
