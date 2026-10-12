// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten/release"
	"github.com/wavetermdev/waveterm/pkg/molten/versions"
	"golang.org/x/term"
)

// `molten release` (FR-REL-002, DS-REL-002): the generic commands a project's release.rc and release.public steps call
// (.molten/project.json), so that Mission Control, or a terminal, cuts a release of any standalone app. They need no
// MoltenTerm session: only git, and gh for a project on GitHub.

var moltenReleaseRc bool
var moltenReleasePublic bool
var moltenReleaseVersion string
var moltenReleaseWorkflows []string
var moltenReleaseDryRun bool
var moltenReleaseNotesPlain bool
var moltenReleaseNotesCheck bool
var moltenReleaseNotesNoReview bool
var moltenReleaseRef string
var moltenReleaseRehearseWorkflow string
var moltenReleaseFields []string
var moltenReleaseDownload string

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

var moltenReleaseNotesCmd = &cobra.Command{
	Use:   "notes <tag>",
	Short: "rewrite the notes of a prepared release with the project's coding agent (or from the commit subjects), or audit them",
	Args:  cobra.ExactArgs(1),
	RunE:  moltenWrap(moltenReleaseNotesRun),
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

var moltenReleaseRehearseCmd = &cobra.Command{
	Use:   "rehearse",
	Short: "build the release files from a branch without a tag, through the release workflow, and publish nothing",
	Args:  cobra.NoArgs,
	RunE: moltenWrap(func(cmd *cobra.Command, args []string) error {
		return moltenReleaseEnv().Rehearse(context.Background(), release.RehearseOptions{
			Workflow: moltenReleaseRehearseWorkflow,
			Ref:      moltenReleaseRef,
			Fields:   moltenReleaseFields,
			Download: moltenReleaseDownload,
		})
	}),
}

func init() {
	moltenReleasePlanCmd.Flags().BoolVar(&moltenReleaseRc, "rc", false, "only the release candidate")
	moltenReleasePlanCmd.Flags().BoolVar(&moltenReleasePublic, "public", false, "only the public release")
	moltenReleasePlanCmd.Flags().StringVar(&moltenReleaseVersion, "version", "", "the public version to release instead of the computed one (X.Y.Z)")
	moltenReleasePlanCmd.Flags().BoolVar(&moltenJson, "json", false, "print the result as JSON")
	moltenReleasePromoteCmd.Flags().StringArrayVar(&moltenReleaseWorkflows, "workflow", nil, "a GitHub workflow that must be green on the trunk's commit (repeatable)")
	moltenReleasePromoteCmd.Flags().BoolVar(&moltenReleaseDryRun, "dry-run", false, "check everything, push nothing and start no workflow")
	moltenReleaseNotesCmd.Flags().BoolVar(&moltenReleaseNotesPlain, "plain", false, "write the public notes from the commit subjects, without the agent")
	moltenReleaseNotesCmd.Flags().BoolVar(&moltenReleaseNotesCheck, "check", false, "only audit the notes as they are, as finalize does")
	moltenReleaseNotesCmd.Flags().BoolVar(&moltenReleaseNotesNoReview, "no-review", false, "never ask to accept, edit or redo, even in a terminal")
	moltenReleaseRehearseCmd.Flags().StringVar(&moltenReleaseRehearseWorkflow, "workflow", "", "the GitHub workflow that rehearses the release on workflow_dispatch")
	moltenReleaseRehearseCmd.Flags().StringVar(&moltenReleaseRef, "ref", "", "the branch to build (default: the trunk)")
	moltenReleaseRehearseCmd.Flags().StringArrayVarP(&moltenReleaseFields, "field", "f", nil, "an input of the workflow, key=value (repeatable)")
	moltenReleaseRehearseCmd.Flags().StringVar(&moltenReleaseDownload, "download", "", "download the artifacts into <folder>/<short commit>")
	for _, cmd := range []*cobra.Command{moltenReleasePlanCmd, moltenReleasePromoteCmd, moltenReleasePrepareCmd,
		moltenReleaseNotesCmd, moltenReleaseFinalizeCmd, moltenReleaseSyncBackCmd, moltenReleaseCloseMilestoneCmd,
		moltenReleaseRehearseCmd} {
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
		if r.Mismatch != "" {
			fmt.Fprintf(&sb, "  Note: %s.\n", r.Mismatch)
		}
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

// moltenReleaseNotesRun rewrites (or audits) the notes; in a terminal, it then offers Notulia's review: accept, edit in
// $EDITOR, redo with the agent, redo from the commit subjects, quit. Mission Control runs it without a terminal: its
// notes editor and its cut are the review there.
func moltenReleaseNotesRun(cmd *cobra.Command, args []string) error {
	ctx := context.Background()
	env := moltenReleaseEnv()
	tag := args[0]
	if err := env.Notes(ctx, tag, release.NotesOptions{Plain: moltenReleaseNotesPlain, Check: moltenReleaseNotesCheck}); err != nil {
		return err
	}
	if moltenReleaseNotesCheck || moltenReleaseNotesNoReview || !term.IsTerminal(int(os.Stdin.Fd())) || !term.IsTerminal(int(os.Stdout.Fd())) {
		return nil
	}
	path, err := env.PreparedNotesPath(ctx, tag)
	if err != nil {
		return err
	}
	reader := bufio.NewReader(os.Stdin)
	for {
		WriteStdout("\nPublic notes of %s: [a]ccept, [e]dit, [r]edo with the agent, [p]lain from the commit subjects, [q]uit? ", tag)
		line, err := reader.ReadString('\n')
		if err != nil && line == "" {
			return fmt.Errorf("no answer: the notes stay in %s", path)
		}
		switch strings.ToLower(strings.TrimSpace(line)) {
		case "", "a":
			if err := env.Notes(ctx, tag, release.NotesOptions{Check: true}); err != nil {
				WriteStdout("%v\n", err)
				continue
			}
			WriteStdout("Accepted. Finalize %s when ready (molten release finalize %s).\n", tag, tag)
			return nil
		case "e":
			editor := os.Getenv("VISUAL")
			if editor == "" {
				editor = os.Getenv("EDITOR")
			}
			if editor == "" {
				editor = "vi"
			}
			fields := strings.Fields(editor)
			edit := exec.Command(fields[0], append(fields[1:], path)...)
			edit.Stdin, edit.Stdout, edit.Stderr = os.Stdin, os.Stdout, os.Stderr
			if err := edit.Run(); err != nil {
				WriteStdout("%s: %v\n", editor, err)
			}
			if err := env.Notes(ctx, tag, release.NotesOptions{Check: true}); err != nil {
				WriteStdout("%v\n", err)
			}
		case "r", "p":
			plain := strings.ToLower(strings.TrimSpace(line)) == "p"
			if err := env.Notes(ctx, tag, release.NotesOptions{Plain: plain}); err != nil {
				WriteStdout("%v\n", err)
			}
		case "q":
			return fmt.Errorf("stopped: nothing is cut, the notes stay in %s", path)
		}
	}
}
