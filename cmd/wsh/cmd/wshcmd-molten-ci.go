// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// The local CI from a terminal (FR-MC-011): wavesrv runs it (pkg/molten/mission/ci.go); these commands ask it, so a
// pre-push hook can warn when the code is not green.

// must match pkg/molten/mission/collector.go
const (
	moltenMissionRoute       = "molten:mission"
	moltenCiRunCommand       = "moltenmissioncirun"
	moltenCiStatusCommand    = "moltenmissioncistatus"
	moltenCiStateCommand     = "moltenmissioncistate"
	moltenCiRpcTimeoutMs     = 30000
	moltenCiPollInterval     = 2 * time.Second
	moltenCiStatusGreen      = "success"
	moltenCiStatusRed        = "failure"
	moltenCiStatusRunning    = "running"
	moltenCiExitNotRun       = 2
	moltenCiUntrustedMessage = "the project's commands are not trusted yet: start the local CI once from Mission Control (CI/CD › CI local) to review and trust them"
)

type moltenCiJob struct {
	Name   string `json:"name"`
	Status string `json:"status"`
}

type moltenCiRun struct {
	Id     string        `json:"id"`
	Sha    string        `json:"sha"`
	Status string        `json:"status"`
	Error  string        `json:"error,omitempty"`
	Jobs   []moltenCiJob `json:"jobs"`
}

type moltenCiVerdict struct {
	Sha     string   `json:"sha"`
	Status  string   `json:"status"`
	Failed  []string `json:"failed,omitempty"`
	Missing []string `json:"missing,omitempty"`
}

var moltenCiForce bool
var moltenCiOnly string

var moltenCiCmd = &cobra.Command{
	Use:   "ci",
	Short: "the project's local CI, run by MoltenTerm",
}

var moltenCiStatusCmd = &cobra.Command{
	Use:     "status [revision]",
	Short:   "say whether the local CI is green on a revision (exit 0 green, 1 red, 2 not run yet)",
	Args:    cobra.MaximumNArgs(1),
	RunE:    moltenWrap(moltenCiStatusRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenCiRunCmd = &cobra.Command{
	Use:     "run [branch]",
	Short:   "run the local CI on a branch (default: the checked-out one) and wait for its result",
	Args:    cobra.MaximumNArgs(1),
	RunE:    moltenWrap(moltenCiRunRun),
	PreRunE: preRunSetupRpcClient,
}

func init() {
	moltenCiRunCmd.Flags().BoolVar(&moltenCiForce, "force", false, "run every job, even those already green on this code")
	moltenCiRunCmd.Flags().StringVar(&moltenCiOnly, "only", "", "run only these jobs (comma-separated names)")
	moltenCmd.AddCommand(moltenCiCmd)
	for _, cmd := range []*cobra.Command{moltenCiStatusCmd, moltenCiRunCmd} {
		cmd.Flags().BoolVar(&moltenJson, "json", false, "print the result as JSON")
		moltenCiCmd.AddCommand(cmd)
	}
}

func moltenCiProjectDir() (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	root := molten.FindGitRoot(cwd)
	if root == "" {
		return "", fmt.Errorf("%s is not inside a git project", cwd)
	}
	if !molten.IsWorktreeCheckout(root) {
		return root, nil
	}
	return moltenCiResolveDir(root, moltenCiLinkedDir()), nil
}

// The project's trust, verdicts and runs are kept per folder, and Mission Control shows the workspace's linked one:
// from a linked git worktree the CI must target the main checkout (a branch is a ref of the whole repository, whatever
// worktree has it checked out), unless the workspace is linked to the worktree itself. linked is that link, if known.
func moltenCiResolveDir(root string, linked string) string {
	if linked == root {
		return root
	}
	info, err := molten.ResolveWorktree(root)
	if err != nil {
		return root
	}
	if linked != "" && moltenSameFolder(linked, info.Main) {
		return linked
	}
	return info.Main
}

func moltenSameFolder(a string, b string) bool {
	realA, errA := filepath.EvalSymlinks(a)
	realB, errB := filepath.EvalSymlinks(b)
	return errA == nil && errB == nil && realA == realB
}

// The folder this terminal's workspace is linked to; empty when unknown (not in a MoltenTerm terminal, not linked).
func moltenCiLinkedDir() string {
	oref, err := moltenProjectWorkspace()
	if err != nil {
		return ""
	}
	meta, err := moltenProjectGetMeta(oref)
	if err != nil {
		return ""
	}
	return moltenMetaString(meta, molten.ProjectMetaKey)
}

func moltenCiRequest(command string, data any, out any) error {
	resp, err := RpcClient.SendRpcRequest(command, data, &wshrpc.RpcOpts{Route: moltenMissionRoute, Timeout: moltenCiRpcTimeoutMs})
	if err != nil {
		return err
	}
	return utilfn.ReUnmarshal(out, resp)
}

func moltenCiShort(sha string) string {
	if len(sha) > 7 {
		return sha[:7]
	}
	return sha
}

func formatMoltenCiVerdict(v moltenCiVerdict) string {
	switch v.Status {
	case moltenCiStatusGreen:
		return fmt.Sprintf("local CI green on %s", moltenCiShort(v.Sha))
	case moltenCiStatusRed:
		return fmt.Sprintf("local CI red on %s: %s", moltenCiShort(v.Sha), strings.Join(v.Failed, ", "))
	case moltenCiStatusRunning:
		return fmt.Sprintf("local CI running on %s", moltenCiShort(v.Sha))
	}
	return fmt.Sprintf("local CI not run yet on %s: %s", moltenCiShort(v.Sha), strings.Join(v.Missing, ", "))
}

func moltenCiStatusRun(cmd *cobra.Command, args []string) error {
	dir, err := moltenCiProjectDir()
	if err != nil {
		return err
	}
	rev := ""
	if len(args) == 1 {
		rev = args[0]
	}
	var verdict moltenCiVerdict
	if err := moltenCiRequest(moltenCiStatusCommand, map[string]any{"dir": dir, "rev": rev}, &verdict); err != nil {
		return err
	}
	switch verdict.Status {
	case moltenCiStatusGreen:
	case moltenCiStatusRed:
		WshExitCode = 1
	default:
		WshExitCode = moltenCiExitNotRun
	}
	if moltenJson {
		return moltenWriteJson(verdict)
	}
	WriteStdout("%s\n", formatMoltenCiVerdict(verdict))
	return nil
}

func moltenCiRunRun(cmd *cobra.Command, args []string) error {
	dir, err := moltenCiProjectDir()
	if err != nil {
		return err
	}
	req := map[string]any{"dir": dir, "force": moltenCiForce}
	if len(args) == 1 {
		req["branch"] = args[0]
	}
	if moltenCiOnly != "" {
		req["only"] = strings.Split(moltenCiOnly, ",")
	}
	var started struct {
		Run       *moltenCiRun `json:"run"`
		Untrusted any          `json:"untrusted"`
	}
	if err := moltenCiRequest(moltenCiRunCommand, req, &started); err != nil {
		return err
	}
	if started.Untrusted != nil || started.Run == nil {
		return fmt.Errorf("%s", moltenCiUntrustedMessage)
	}
	if !moltenJson {
		WriteStdout("local CI %s on %s: %d job(s)\n", started.Run.Id, moltenCiShort(started.Run.Sha), len(started.Run.Jobs))
	}
	told := map[string]string{}
	for {
		var state struct {
			Runs []moltenCiRun `json:"runs"`
		}
		if err := moltenCiRequest(moltenCiStateCommand, map[string]any{"dir": dir}, &state); err != nil {
			return err
		}
		var run *moltenCiRun
		for i := range state.Runs {
			if state.Runs[i].Id == started.Run.Id {
				run = &state.Runs[i]
			}
		}
		if run == nil {
			return fmt.Errorf("the local CI run %s is gone", started.Run.Id)
		}
		for _, job := range run.Jobs {
			if !moltenJson && told[job.Name] != job.Status && job.Status != "queued" {
				WriteStdout("  %-12s %s\n", job.Name, job.Status)
			}
			told[job.Name] = job.Status
		}
		if run.Status != moltenCiStatusRunning {
			if run.Status != moltenCiStatusGreen {
				WshExitCode = 1
			}
			if moltenJson {
				return moltenWriteJson(run)
			}
			if run.Error != "" {
				WriteStdout("%s\n", run.Error)
			}
			WriteStdout("local CI %s\n", run.Status)
			return nil
		}
		time.Sleep(moltenCiPollInterval)
	}
}
