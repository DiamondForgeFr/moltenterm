// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// `molten project deps` (FR-MC-029-AC6): each dependency this workspace's project declares in `dependson`, evaluated
// afresh by Mission Control from the local git of both members. It only reads: nothing is written in either project.

package cmd

import (
	"fmt"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten"
)

// must match pkg/molten/mission/deps.go
const (
	moltenDepsCommand            = "moltenmissiondeps"
	moltenDepStateInSync         = "insync"
	moltenDepStateStale          = "stale"
	moltenDepStateUncommitted    = "uncommitted"
	moltenDepStateSourceNotFound = "sourcenotfound"
	moltenDepStateBranchNotFound = "branchnotfound"
	moltenDepStateInvalid        = "invalid"
	moltenDepStateError          = "error"
	moltenDepsShownCommits       = 10
)

// must match DependencyCommit in pkg/molten/mission/deps.go
type moltenDepCommit struct {
	Sha     string   `json:"sha"`
	Time    int64    `json:"time"`
	Subject string   `json:"subject"`
	Tickets []string `json:"tickets,omitempty"`
}

// must match DependencyState in pkg/molten/mission/deps.go
type moltenDepState struct {
	Index       int               `json:"index"`
	Project     string            `json:"project"`
	Paths       []string          `json:"paths"`
	Output      []string          `json:"output"`
	Sync        string            `json:"sync,omitempty"`
	Branch      string            `json:"branch,omitempty"`
	Ref         string            `json:"ref,omitempty"`
	State       string            `json:"state"`
	Problem     string            `json:"problem,omitempty"`
	SourceDir   string            `json:"sourcedir,omitempty"`
	SourceName  string            `json:"sourcename,omitempty"`
	Source      *moltenDepCommit  `json:"source,omitempty"`
	Synced      *moltenDepCommit  `json:"synced,omitempty"`
	Trunk       string            `json:"trunk,omitempty"`
	Commits     []moltenDepCommit `json:"commits,omitempty"`
	MoreCommits bool              `json:"morecommits,omitempty"`
	Changed     []string          `json:"changed,omitempty"`
	Uncommitted []string          `json:"uncommitted,omitempty"`
	CheckedAt   int64             `json:"checkedat,omitempty"`
}

type MoltenProjectDepsStatus struct {
	Workspace string           `json:"workspace"`
	Linked    bool             `json:"linked"`
	Dir       string           `json:"dir,omitempty"`
	Project   string           `json:"project,omitempty"`
	Deps      []moltenDepState `json:"deps"`
}

var moltenProjectDepsCmd = &cobra.Command{
	Use:     "deps",
	Short:   "check this workspace's project dependencies on the other members of its group (stale or in sync)",
	Args:    cobra.NoArgs,
	RunE:    moltenWrap(moltenProjectDepsRun),
	PreRunE: preRunSetupRpcClient,
}

func init() {
	moltenProjectDepsCmd.Flags().BoolVar(&moltenJson, "json", false, "print the result as JSON")
	moltenProjectCmd.AddCommand(moltenProjectDepsCmd)
}

func moltenProjectDepsRun(cmd *cobra.Command, args []string) error {
	oref, err := moltenProjectWorkspace()
	if err != nil {
		return err
	}
	meta, err := moltenProjectGetMeta(oref)
	if err != nil {
		return err
	}
	status := MoltenProjectDepsStatus{Workspace: oref.OID, Dir: moltenMetaString(meta, molten.ProjectMetaKey), Deps: []moltenDepState{}}
	status.Linked = status.Dir != ""
	if status.Linked {
		status.Project = molten.ReadProject(status.Dir).Name
		if err := moltenCiRequest(moltenDepsCommand, map[string]any{"dir": status.Dir}, &status.Deps); err != nil {
			return fmt.Errorf("asking Mission Control for the dependencies: %w", err)
		}
		if status.Deps == nil {
			status.Deps = []moltenDepState{}
		}
	}
	if moltenJson {
		return moltenWriteJson(status)
	}
	WriteStdout("%s", formatMoltenProjectDeps(status))
	return nil
}

func formatMoltenProjectDeps(status MoltenProjectDepsStatus) string {
	var sb strings.Builder
	if !status.Linked {
		sb.WriteString("this workspace is not linked to a project; link it with: molten project link [folder]\n")
		return sb.String()
	}
	if len(status.Deps) == 0 {
		fmt.Fprintf(&sb, "%s declares no dependency; to declare one, add \"dependson\" to %s (see molten project group)\n", status.Project, molten.ProjectPipelineFile)
		return sb.String()
	}
	fmt.Fprintf(&sb, "%s: %s\n", moltenPrintable(status.Project), moltenCount(len(status.Deps), "dependency", "dependencies"))
	for _, dep := range status.Deps {
		sb.WriteString(formatMoltenDep(dep))
	}
	return sb.String()
}

func moltenDepName(dep moltenDepState) string {
	if dep.SourceName != "" {
		return dep.SourceName
	}
	if dep.Project != "" {
		return dep.Project
	}
	return fmt.Sprintf("dependson[%d]", dep.Index)
}

var moltenDepWords = map[string]string{
	moltenDepStateInSync:         "in sync",
	moltenDepStateStale:          "STALE",
	moltenDepStateUncommitted:    "STALE: synced, not committed",
	moltenDepStateSourceNotFound: "source not found",
	moltenDepStateBranchNotFound: "branch not found",
	moltenDepStateInvalid:        "invalid declaration",
	moltenDepStateError:          "could not be read",
}

func formatMoltenDepCommit(c *moltenDepCommit) string {
	return fmt.Sprintf("%s %s (%s)", moltenCiShort(c.Sha), c.Subject, time.UnixMilli(c.Time).Format("2006-01-02 15:04"))
}

// moltenPrintable drops the control characters of a text read from a repository (a commit subject, a file name): printed
// as is, an escape sequence would drive the terminal (its title, the clipboard through OSC 52).
func moltenPrintable(text string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 || (r >= 0x7f && r < 0xa0) {
			return -1
		}
		return r
	}, text)
}

func moltenPrintableList(items []string) []string {
	rtn := make([]string, len(items))
	for i, item := range items {
		rtn[i] = moltenPrintable(item)
	}
	return rtn
}

func moltenPrintableCommit(c *moltenDepCommit) *moltenDepCommit {
	if c == nil {
		return nil
	}
	copied := *c
	copied.Sha, copied.Subject, copied.Tickets = moltenPrintable(c.Sha), moltenPrintable(c.Subject), moltenPrintableList(c.Tickets)
	return &copied
}

// printableMoltenDep is a dependency whose every text is safe to print.
func printableMoltenDep(dep moltenDepState) moltenDepState {
	dep.Project, dep.Sync, dep.Branch, dep.Ref, dep.Problem = moltenPrintable(dep.Project), moltenPrintable(dep.Sync), moltenPrintable(dep.Branch), moltenPrintable(dep.Ref), moltenPrintable(dep.Problem)
	dep.SourceName, dep.Trunk, dep.State = moltenPrintable(dep.SourceName), moltenPrintable(dep.Trunk), moltenPrintable(dep.State)
	dep.Paths, dep.Output, dep.Changed, dep.Uncommitted = moltenPrintableList(dep.Paths), moltenPrintableList(dep.Output), moltenPrintableList(dep.Changed), moltenPrintableList(dep.Uncommitted)
	dep.Source, dep.Synced = moltenPrintableCommit(dep.Source), moltenPrintableCommit(dep.Synced)
	commits := make([]moltenDepCommit, len(dep.Commits))
	for i := range dep.Commits {
		commits[i] = *moltenPrintableCommit(&dep.Commits[i])
	}
	dep.Commits = commits
	return dep
}

func formatMoltenDep(dep moltenDepState) string {
	dep = printableMoltenDep(dep)
	var sb strings.Builder
	word := moltenDepWords[dep.State]
	if word == "" {
		word = dep.State
	}
	fmt.Fprintf(&sb, "  %s: %s\n", moltenDepName(dep), word)
	fmt.Fprintf(&sb, "    reads: %s", strings.Join(dep.Paths, ", "))
	if dep.Branch != "" {
		fmt.Fprintf(&sb, " on %s", dep.Branch)
		if dep.Ref != "" && dep.Ref != dep.Branch {
			fmt.Fprintf(&sb, " (%s)", dep.Ref)
		}
	}
	sb.WriteString("\n")
	fmt.Fprintf(&sb, "    writes: %s\n", strings.Join(dep.Output, ", "))
	if dep.Problem != "" {
		fmt.Fprintf(&sb, "    %s\n", dep.Problem)
	}
	switch dep.State {
	case moltenDepStateSourceNotFound, moltenDepStateBranchNotFound, moltenDepStateInvalid, moltenDepStateError:
		return sb.String()
	}
	if dep.Synced != nil {
		trunk := dep.Trunk
		if trunk == "" {
			trunk = "the trunk"
		}
		fmt.Fprintf(&sb, "    last sync: %s on %s\n", formatMoltenDepCommit(dep.Synced), trunk)
	} else {
		sb.WriteString("    last sync: never (no commit touches the output on the trunk)\n")
	}
	if dep.Source != nil {
		fmt.Fprintf(&sb, "    source: %s\n", formatMoltenDepCommit(dep.Source))
	}
	if dep.State == moltenDepStateInSync {
		return sb.String()
	}
	if len(dep.Changed) > 0 {
		fmt.Fprintf(&sb, "    changed: %s\n", strings.Join(dep.Changed, ", "))
	}
	count := moltenCount(len(dep.Commits), "commit", "commits")
	if dep.MoreCommits {
		count = fmt.Sprintf("more than %d commits", len(dep.Commits))
	}
	fmt.Fprintf(&sb, "    since the last sync: %s\n", count)
	for i, c := range dep.Commits {
		if i == moltenDepsShownCommits {
			fmt.Fprintf(&sb, "      and %d more\n", len(dep.Commits)-i)
			break
		}
		line := fmt.Sprintf("%s %s", moltenCiShort(c.Sha), c.Subject)
		if len(c.Tickets) > 0 {
			line += " [#" + strings.Join(c.Tickets, ", #") + "]"
		}
		fmt.Fprintf(&sb, "      %s\n", line)
	}
	if dep.State == moltenDepStateUncommitted {
		fmt.Fprintf(&sb, "    not committed: %s (commit them to clear the flag)\n", strings.Join(dep.Uncommitted, ", "))
	}
	if dep.Sync != "" {
		fmt.Fprintf(&sb, "    sync: %s\n", dep.Sync)
	}
	return sb.String()
}
