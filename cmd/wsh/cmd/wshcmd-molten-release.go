// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten/release"
	"github.com/wavetermdev/waveterm/pkg/molten/versions"
)

// `molten release` (FR-REL-002, DS-REL-002): the generic commands a project's release.rc and release.public steps call
// (.molten/project.json), so that Mission Control, or a terminal, cuts a release of any standalone app. They need no
// MoltenTerm session: only git, and gh for a project on GitHub.

var moltenReleaseRc bool
var moltenReleasePublic bool
var moltenReleaseVersion string
var moltenReleaseWorkflows []string
var moltenReleaseDryRun bool

var moltenReleaseCmd = &cobra.Command{
	Use:   "release",
	Short: "cut a release of this project from its .molten/project.json",
}

var moltenReleasePlanCmd = &cobra.Command{
	Use:   "plan",
	Short: "the next release candidate and public release, with the milestone each ships and its open issues",
	Args:  cobra.NoArgs,
	RunE:  moltenWrap(moltenReleasePlanRun),
}

var moltenReleasePromoteCmd = &cobra.Command{
	Use:   "promote",
	Short: "bring the trunk onto the release branch once its CI is green (fast-forward or merge commit)",
	Args:  cobra.NoArgs,
	RunE: moltenWrap(func(cmd *cobra.Command, args []string) error {
		return moltenReleaseEnv().Promote(context.Background(), release.PromoteOptions{Workflows: moltenReleaseWorkflows, DryRun: moltenReleaseDryRun})
	}),
}

var moltenReleasePrepareCmd = &cobra.Command{
	Use:   "prepare <tag>",
	Short: "bump the version and draft the notes of a release in the release worktree, without committing",
	Args:  cobra.ExactArgs(1),
	RunE: moltenWrap(func(cmd *cobra.Command, args []string) error {
		return moltenReleaseEnv().Prepare(context.Background(), args[0])
	}),
}

var moltenReleaseFinalizeCmd = &cobra.Command{
	Use:   "finalize <tag>",
	Short: "commit the prepared release, tag it and push both atomically",
	Args:  cobra.ExactArgs(1),
	RunE: moltenWrap(func(cmd *cobra.Command, args []string) error {
		return moltenReleaseEnv().Finalize(context.Background(), args[0])
	}),
}

var moltenReleaseSyncBackCmd = &cobra.Command{
	Use:   "sync-back <tag>",
	Short: "carry the release commit back to the trunk by pull request",
	Args:  cobra.ExactArgs(1),
	RunE: moltenWrap(func(cmd *cobra.Command, args []string) error {
		return moltenReleaseEnv().SyncBack(context.Background(), args[0])
	}),
}

var moltenReleaseCloseMilestoneCmd = &cobra.Command{
	Use:   "close-milestone <tag>",
	Short: "close the milestone of a published public release (its open issues are listed, never blocking)",
	Args:  cobra.ExactArgs(1),
	RunE: moltenWrap(func(cmd *cobra.Command, args []string) error {
		return moltenReleaseEnv().CloseMilestone(context.Background(), args[0])
	}),
}

func init() {
	moltenReleasePlanCmd.Flags().BoolVar(&moltenReleaseRc, "rc", false, "only the release candidate")
	moltenReleasePlanCmd.Flags().BoolVar(&moltenReleasePublic, "public", false, "only the public release")
	moltenReleasePlanCmd.Flags().StringVar(&moltenReleaseVersion, "version", "", "the public version to release instead of the computed one (X.Y.Z)")
	moltenReleasePlanCmd.Flags().BoolVar(&moltenJson, "json", false, "print the result as JSON")
	moltenReleasePromoteCmd.Flags().StringArrayVar(&moltenReleaseWorkflows, "workflow", nil, "a GitHub workflow that must be green on the trunk's commit (repeatable)")
	moltenReleasePromoteCmd.Flags().BoolVar(&moltenReleaseDryRun, "dry-run", false, "check everything, push nothing and start no workflow")
	for _, cmd := range []*cobra.Command{moltenReleasePlanCmd, moltenReleasePromoteCmd, moltenReleasePrepareCmd,
		moltenReleaseFinalizeCmd, moltenReleaseSyncBackCmd, moltenReleaseCloseMilestoneCmd} {
		moltenReleaseCmd.AddCommand(cmd)
	}
	moltenCmd.AddCommand(moltenReleaseCmd)
}

func moltenReleaseEnv() *release.Env {
	dir, err := os.Getwd()
	if err != nil {
		dir = "."
	}
	return &release.Env{Dir: dir, Out: WrappedStdout}
}

func moltenReleaseChannels() []string {
	if moltenReleaseRc == moltenReleasePublic {
		return []string{versions.ChannelRc, versions.ChannelPublic}
	}
	if moltenReleaseRc {
		return []string{versions.ChannelRc}
	}
	return []string{versions.ChannelPublic}
}

func moltenReleasePlanRun(cmd *cobra.Command, args []string) error {
	env := moltenReleaseEnv()
	if moltenJson {
		env.Out = nil
	}
	reports, err := env.Plan(context.Background(), moltenReleaseChannels(), moltenReleaseVersion)
	if err != nil {
		return err
	}
	if moltenJson {
		return moltenWriteJson(reports)
	}
	WriteStdout("%s", formatMoltenReleasePlan(reports))
	return nil
}

func formatMoltenReleasePlan(reports []release.PlanReport) string {
	var sb strings.Builder
	for i, r := range reports {
		if i > 0 {
			sb.WriteString("\n")
		}
		name := "Release candidate"
		if r.Channel == versions.ChannelPublic {
			name = "Public release"
		}
		if r.Tag == "" {
			fmt.Fprintf(&sb, "%s: none. %s\n", name, r.Reason)
			continue
		}
		fmt.Fprintf(&sb, "%s: %s. %s\n", name, r.Tag, r.Reason)
		switch {
		case r.MilestoneError != "":
			fmt.Fprintf(&sb, "  Milestone not read: %s\n", r.MilestoneError)
		case r.Milestone == nil:
			fmt.Fprintf(&sb, "  No open milestone for %s.\n", r.Base)
		default:
			fmt.Fprintf(&sb, "  Ships milestone %s (%s).\n", r.Milestone.Title, r.Milestone.Url)
			if len(r.Milestone.Issues) > 0 {
				fmt.Fprintf(&sb, "  Warning: %d open issue(s), reported, not blocking:\n", len(r.Milestone.Issues))
				for _, issue := range r.Milestone.Issues {
					fmt.Fprintf(&sb, "    #%d %s\n", issue.Number, issue.Title)
				}
			}
		}
	}
	return sb.String()
}
