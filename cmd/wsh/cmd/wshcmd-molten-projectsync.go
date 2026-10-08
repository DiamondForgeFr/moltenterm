// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// `molten project sync [source]` (FR-MC-030-AC1): runs this workspace's project's declared sync for a dependency, as
// the notification's Sync does, and follows it to its end. Mission Control runs it (pkg/molten/mission/depsync.go):
// the command is read from the project file, trusted once from a MoltenTerm window, and given a clean worktree of the
// source. Nothing is committed: the user reviews and commits what the sync wrote.

package cmd

import (
	"fmt"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten"
)

// must match pkg/molten/mission/depsync.go and collector.go
const (
	moltenDepSyncCommand          = "moltenmissiondepsync"
	moltenMissionLogCommand       = "moltenmissionlog"
	moltenMissionRunsCommand      = "moltenmissionruns"
	moltenDepSyncRunning          = "running"
	moltenDepSyncSuccess          = "success"
	moltenDepSyncChanged          = "changed"
	moltenDepSyncNoChange         = "nochange"
	moltenDepSyncPollInterval     = 500 * time.Millisecond
	moltenDepSyncUntrustedMessage = "the sync command is not trusted yet: press Sync once on the stale dependency's notification (or on its flag in Mission Control) to review and trust the project's commands"
)

// must match RunRecord in pkg/molten/mission/runs.go
type moltenSyncRun struct {
	Id      string   `json:"id"`
	Dir     string   `json:"dir"`
	Kind    string   `json:"kind"`
	Title   string   `json:"title,omitempty"`
	Command string   `json:"command"`
	State   string   `json:"state"`
	Exit    *int     `json:"exit,omitempty"`
	Commit  string   `json:"commit,omitempty"`
	Source  string   `json:"source,omitempty"`
	Branch  string   `json:"branch,omitempty"`
	Outcome string   `json:"outcome,omitempty"`
	Changed []string `json:"changed,omitempty"`
}

type moltenLogChunk struct {
	Text string `json:"text"`
	Size int64  `json:"size"`
}

var moltenProjectSyncCmd = &cobra.Command{
	Use:     "sync [source]",
	Short:   "run this workspace's project's sync for a dependency (its declared command, against a clean worktree of the source) and wait for its end",
	Args:    cobra.MaximumNArgs(1),
	RunE:    moltenWrap(moltenProjectSyncRun),
	PreRunE: preRunSetupRpcClient,
}

func init() {
	moltenProjectSyncCmd.Flags().BoolVar(&moltenJson, "json", false, "print the ended run as JSON instead of its log")
	moltenProjectCmd.AddCommand(moltenProjectSyncCmd)
}

func moltenProjectSyncRun(cmd *cobra.Command, args []string) error {
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
	req := map[string]any{"dir": dir}
	if len(args) == 1 {
		req["project"] = args[0]
	}
	var started struct {
		Run       *moltenSyncRun `json:"run"`
		Untrusted any            `json:"untrusted"`
	}
	if err := moltenCiRequest(moltenDepSyncCommand, req, &started); err != nil {
		return err
	}
	if started.Untrusted != nil || started.Run == nil {
		return fmt.Errorf("%s", moltenDepSyncUntrustedMessage)
	}
	run := started.Run
	if !moltenJson {
		WriteStdout("%s: %s on %s @ %s, in %s\n", moltenPrintable(run.Title), moltenPrintable(run.Command), moltenPrintable(run.Branch),
			moltenCiShort(run.Commit), dir)
	}
	ended, err := moltenFollowSync(dir, run.Id)
	if err != nil {
		return err
	}
	if ended.State != moltenDepSyncSuccess {
		WshExitCode = 1
		if ended.Exit != nil && *ended.Exit > 0 {
			WshExitCode = *ended.Exit
		}
	}
	if moltenJson {
		return moltenWriteJson(ended)
	}
	WriteStdout("%s\n", formatMoltenSyncEnd(ended))
	return nil
}

// moltenFollowSync prints the run's log as it comes (unless --json) and returns the run once it ended.
func moltenFollowSync(dir string, runId string) (moltenSyncRun, error) {
	var from int64
	for {
		ended, err := moltenSyncRecord(dir, runId)
		if err != nil {
			return moltenSyncRun{}, err
		}
		for {
			var chunk moltenLogChunk
			if err := moltenCiRequest(moltenMissionLogCommand, map[string]any{"dir": dir, "runid": runId, "from": from}, &chunk); err != nil {
				break
			}
			if chunk.Size <= from {
				break
			}
			from = chunk.Size
			if !moltenJson {
				WriteStdout("%s", moltenPrintableLog(chunk.Text))
			}
		}
		if ended.State != moltenDepSyncRunning {
			return ended, nil
		}
		time.Sleep(moltenDepSyncPollInterval)
	}
}

func moltenSyncRecord(dir string, runId string) (moltenSyncRun, error) {
	var runs []moltenSyncRun
	if err := moltenCiRequest(moltenMissionRunsCommand, map[string]any{"dir": dir}, &runs); err != nil {
		return moltenSyncRun{}, err
	}
	for _, run := range runs {
		if run.Id == runId {
			return run, nil
		}
	}
	return moltenSyncRun{}, fmt.Errorf("the sync run %s is gone", runId)
}

// moltenPrintableLog keeps a log's lines and tabs, and drops the other control characters: the log holds what the
// sync printed, which may quote the source's files.
func moltenPrintableLog(text string) string {
	return strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		if r < 0x20 || (r >= 0x7f && r < 0xa0) {
			return -1
		}
		return r
	}, text)
}

func formatMoltenSyncEnd(run moltenSyncRun) string {
	source := moltenPrintable(run.Source)
	switch {
	case run.State == moltenDepSyncSuccess && run.Outcome == moltenDepSyncNoChange:
		return fmt.Sprintf("in sync, no change: nothing to commit; the flag on %s clears", source)
	case run.State == moltenDepSyncSuccess && run.Outcome == moltenDepSyncChanged:
		return fmt.Sprintf("synced, not committed: %s\nreview and commit them on the trunk to clear the flag on %s",
			strings.Join(moltenPrintableList(run.Changed), ", "), source)
	case run.State == moltenDepSyncSuccess:
		return "synced"
	case run.Exit != nil:
		return fmt.Sprintf("the sync %s (exit %d): the dependency on %s stays stale", run.State, *run.Exit, source)
	}
	return fmt.Sprintf("the sync %s: the dependency on %s stays stale", run.State, source)
}
