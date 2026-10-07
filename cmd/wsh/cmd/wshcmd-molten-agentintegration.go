// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentlaunch"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// `molten agent integration status` (FR-SHELL-036 AC11, DS-SHELL-051). Inside an integrated agent (its tools'
// shells), it prints what the launcher added to that run, from the report the pane keeps. In the terminal's own
// shell, it prints what `claude` runs and what a session started now would get, read the same way the launcher
// reads it and without writing anything.

var moltenAgentIntegrationCmd = &cobra.Command{
	Use:   "integration",
	Short: "what MoltenTerm adds to the coding agents started in this terminal",
	Args:  cobra.ArbitraryArgs,
	RunE:  moltenAgentRun,
}

var moltenAgentIntegrationStatusCmd = &cobra.Command{
	Use:   "status",
	Short: "print the real binary of each agent and what MoltenTerm adds to its run, or why nothing",
	Args:  cobra.NoArgs,
	RunE:  moltenWrap(moltenAgentIntegrationStatusRun),
}

func init() {
	moltenAgentIntegrationStatusCmd.Flags().BoolVar(&moltenJson, "json", false, "print the result as JSON")
	moltenAgentIntegrationCmd.AddCommand(moltenAgentIntegrationStatusCmd)
	moltenAgentCmd.AddCommand(moltenAgentIntegrationCmd)
}

// MoltenIntegrationStatus is one agent's line of `molten agent integration status`.
type MoltenIntegrationStatus struct {
	Agent string `json:"agent"`
	// Running: the report of the run this command is part of; otherwise Report is what a new run would get.
	Running bool `json:"running,omitempty"`
	// OnPath: what `claude` runs in this shell; Launcher: it is MoltenTerm's launcher.
	OnPath   string                         `json:"onpath,omitempty"`
	Launcher bool                           `json:"launcher"`
	Report   *molten.AgentIntegrationReport `json:"report,omitempty"`
	Note     string                         `json:"note,omitempty"`
}

func moltenAgentIntegrationStatusRun(cmd *cobra.Command, args []string) error {
	var rtn []MoltenIntegrationStatus
	if running := os.Getenv(agentlaunch.LaunchedVarName); running != "" {
		status, err := moltenRunningIntegration(running)
		if err != nil {
			return err
		}
		rtn = append(rtn, status)
	} else {
		for _, name := range agentlaunch.LauncherNames() {
			rtn = append(rtn, moltenPlannedIntegration(agentlaunch.AdapterForProgram(name), os.Getenv))
		}
	}
	if moltenJson {
		out, err := json.Marshal(rtn)
		if err != nil {
			return err
		}
		WriteStdout("%s\n", out)
		return nil
	}
	for _, s := range rtn {
		WriteStdout("%s", formatMoltenIntegrationStatus(s))
	}
	return nil
}

// moltenRunningIntegration asks the pane for the launcher's report of the agent this command runs under.
func moltenRunningIntegration(agent string) (MoltenIntegrationStatus, error) {
	status := MoltenIntegrationStatus{Agent: agent, Running: true, Launcher: true}
	jwt := os.Getenv(wshutil.WaveJwtTokenVarName)
	if jwt == "" {
		return status, fmt.Errorf("not in a MoltenTerm terminal")
	}
	if err := setupRpcClient(nil, jwt); err != nil {
		return status, err
	}
	blockId := RpcContext.BlockId
	if blockId == "" {
		blockId = os.Getenv("WAVETERM_BLOCKID")
	}
	req := molten.AgentIntegrationStatusRequest{BlockId: blockId}
	data, err := RpcClient.SendRpcRequest(molten.AgentIntegrationStatusCommand, req, &wshrpc.RpcOpts{Route: molten.AgentStatesRoute, Timeout: moltenAgentStateTimeoutMs})
	if err != nil {
		return status, err
	}
	var found molten.AgentIntegrationStatus
	raw, _ := json.Marshal(data)
	if err := json.Unmarshal(raw, &found); err != nil {
		return status, err
	}
	if !found.Found || found.Report == nil {
		status.Note = "the pane has no report of this run (MoltenTerm was restarted, or the report did not arrive in time)"
		return status, nil
	}
	status.Report = found.Report
	return status, nil
}

// moltenPlannedIntegration is what the agent (`claude`, `codex`) would run with if started now in this shell.
func moltenPlannedIntegration(adapter agentlaunch.LaunchAdapter, getenv func(string) string) MoltenIntegrationStatus {
	status := MoltenIntegrationStatus{Agent: adapter.Id()}
	if onPath, err := exec.LookPath(adapter.Executable()); err == nil {
		if abs, err := filepath.Abs(onPath); err == nil {
			onPath = abs
		}
		status.OnPath, status.Launcher = onPath, agentlaunch.IsLauncher(onPath)
	}
	real, ok := agentlaunch.FindRealBinary(adapter.Executable(), getenv("PATH"), getenv(agentlaunch.AgentBinDirVarName), agentlaunch.IsLauncher)
	if !ok {
		status.Note = fmt.Sprintf("no %s found on PATH", molten.AgentDisplayName(adapter.Id()))
		return status
	}
	report := molten.AgentIntegrationReport{Agent: adapter.Id(), RealPath: real}
	if !status.Launcher {
		report.StepAside = "`" + adapter.Executable() + "` does not run MoltenTerm's launcher in this shell"
	} else if reason := agentlaunch.StepAsideReason(getenv, nil, adapter); reason != "" {
		report.StepAside = reason
	} else {
		report = planMoltenAgentLaunchDry(adapter, real, getenv)
	}
	status.Report = &report
	return status
}

// planMoltenAgentLaunchDry plans like the launcher, without writing the generated file.
func planMoltenAgentLaunchDry(adapter agentlaunch.LaunchAdapter, real string, getenv func(string) string) molten.AgentIntegrationReport {
	report := molten.AgentIntegrationReport{Agent: adapter.Id(), RealPath: real}
	plan, dataDir, err := moltenLaunchPlan(adapter, nil, getenv)
	if err != nil {
		report.StepAside = err.Error()
		return report
	}
	report.Added, report.Skipped, report.StepAside = plan.Added, plan.Skipped, plan.StepAside
	var paths []string
	for _, f := range plan.Files {
		paths = append(paths, filepath.Join(agentlaunch.LaunchDir(dataDir), agentlaunch.LaunchFileName(f.Prefix, f.Data)))
	}
	setReportFiles(&report, plan.Files, paths)
	if len(plan.Files) == 0 && plan.MakeArgs != nil && plan.StepAside == "" {
		report.Args = plan.MakeArgs(nil)
	}
	return report
}

func formatMoltenIntegrationStatus(s MoltenIntegrationStatus) string {
	var b strings.Builder
	name := molten.AgentDisplayName(s.Agent)
	fmt.Fprintf(&b, "%s\n", name)
	if !s.Running {
		switch {
		case s.OnPath == "":
			fmt.Fprintf(&b, "  `%s` is not on PATH.\n", agentlaunch.FindAdapter(s.Agent).Executable())
		case s.Launcher:
			fmt.Fprintf(&b, "  `%s` runs MoltenTerm's launcher: %s\n", agentlaunch.FindAdapter(s.Agent).Executable(), s.OnPath)
		default:
			fmt.Fprintf(&b, "  `%s` runs %s, not MoltenTerm's launcher.\n", agentlaunch.FindAdapter(s.Agent).Executable(), s.OnPath)
		}
	}
	if s.Note != "" {
		fmt.Fprintf(&b, "  %s.\n", capitalize(s.Note))
	}
	r := s.Report
	if r == nil {
		return b.String()
	}
	fmt.Fprintf(&b, "  Real binary: %s\n", r.RealPath)
	verb := "Added to this run"
	if !s.Running {
		verb = "A session started now gets"
	}
	switch {
	case r.StepAside != "":
		fmt.Fprintf(&b, "  Nothing added: %s.\n", r.StepAside)
	case len(r.Added) == 0:
		b.WriteString("  Nothing added: your own settings already have all of it.\n")
	default:
		fmt.Fprintf(&b, "  %s:\n", verb)
		for _, item := range r.Added {
			fmt.Fprintf(&b, "    - %s\n", item.Name)
		}
		if r.Settings != "" {
			fmt.Fprintf(&b, "    through --settings %s (your own files are not edited)\n", r.Settings)
		}
		if r.McpConfig != "" {
			fmt.Fprintf(&b, "    through --mcp-config %s (added to your own MCP servers)\n", r.McpConfig)
		}
		if len(r.Args) > 0 {
			b.WriteString("    through these arguments, before yours (your own files are not edited):\n")
			for i := 0; i < len(r.Args); i++ {
				if r.Args[i] == "-c" && i+1 < len(r.Args) {
					fmt.Fprintf(&b, "      -c %s\n", r.Args[i+1])
					i++
					continue
				}
				fmt.Fprintf(&b, "      %s\n", r.Args[i])
			}
		}
	}
	if len(r.Skipped) > 0 {
		b.WriteString("  Left out:\n")
		for _, item := range r.Skipped {
			fmt.Fprintf(&b, "    - %s: %s\n", item.Name, item.Reason)
		}
	}
	if s.Running && r.At > 0 {
		fmt.Fprintf(&b, "  Started %s.\n", time.UnixMilli(r.At).Format("15:04:05"))
	}
	return b.String()
}

func capitalize(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}
