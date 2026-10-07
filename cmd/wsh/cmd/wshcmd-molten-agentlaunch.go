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
	"github.com/wavetermdev/waveterm/pkg/molten/agentlaunch"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// The agent launcher (FR-SHELL-036, FR-SHELL-038, DS-SHELL-045). `claude` and `codex` in a local MoltenTerm terminal
// are wsh under those names (<data>/bin/agents/claude): `claude` runs `molten agent launch --agent claude -- <args>`,
// which finds the real binary,
// adds MoltenTerm's integration for this run when it may, tells the pane what it added, and replaces itself with the
// real binary. On any doubt it adds nothing; it never keeps the agent from starting.

// The report, connection included, never holds the agent's start longer than this (NFR-SHELL-020).
const moltenAgentLaunchReportTimeout = 300 * time.Millisecond

const moltenAgentLaunchMissingCode = 127

// Planning (reading the settings files) is capped too: past it, the agent starts with nothing added.
const moltenAgentLaunchPlanTimeout = 250 * time.Millisecond

var moltenAgentLaunchCmd = &cobra.Command{
	Use:   "launch --agent <agent> -- [args...]",
	Short: "start a coding agent with MoltenTerm's integration for this run (what the claude and codex launchers run)",
	Long: "Start a coding agent's real binary with MoltenTerm's integration added for this run only, through the " +
		"agent's own per-run settings: for Claude Code the state hooks, the session link and the status line relay " +
		"around your own status line; for Codex a notify wrapper around your own notify (done state, session link); " +
		"for both the MoltenTerm browser. Nothing of yours is edited. Outside a MoltenTerm terminal, in an agent's own " +
		"subprocess, for commands that start no session, or with MOLTENTERM_AGENT_INTEGRATION=0, the real binary runs " +
		"with nothing added. In a MoltenTerm terminal, `claude` and `codex` run this.",
	DisableFlagParsing: true,
	RunE:               moltenAgentLaunchRun,
}

func init() {
	moltenAgentCmd.AddCommand(moltenAgentLaunchCmd)
}

// moltenAgentLaunchArgs is the wsh command line a launcher runs: every argument is passed after "--", untouched.
func moltenAgentLaunchArgs(args []string, agent string) []string {
	rtn := []string{args[0], MoltenProgramName, "agent", "launch", "--agent", agent, "--"}
	return append(rtn, args[1:]...)
}

func parseMoltenAgentLaunchArgs(args []string) (string, []string, error) {
	if len(args) >= 3 && args[0] == "--agent" && args[2] == "--" {
		return args[1], args[3:], nil
	}
	if len(args) >= 2 && strings.HasPrefix(args[0], "--agent=") && args[1] == "--" {
		return strings.TrimPrefix(args[0], "--agent="), args[2:], nil
	}
	return "", nil, fmt.Errorf("usage: molten agent launch --agent <agent> -- [args...]")
}

func moltenAgentLaunchRun(cmd *cobra.Command, args []string) error {
	if len(args) > 0 && (args[0] == "-h" || args[0] == "--help") {
		return cmd.Help()
	}
	agent, rest, err := parseMoltenAgentLaunchArgs(args)
	if err != nil {
		WriteStderr("%v\n", err)
		WshExitCode = 2
		return nil
	}
	WshExitCode = runMoltenAgentLaunch(agent, rest, os.Getenv)
	return nil
}

func runMoltenAgentLaunch(agent string, args []string, getenv func(string) string) int {
	adapter := agentlaunch.FindAdapter(agent)
	if adapter == nil {
		WriteStderr("molten agent launch: no launcher for %q\n", agent)
		return 2
	}
	real, ok := agentlaunch.FindRealBinary(adapter.Executable(), getenv("PATH"), getenv(agentlaunch.AgentBinDirVarName), agentlaunch.IsLauncher)
	if !ok {
		WriteStderr("%s: no %s found on PATH (MoltenTerm launcher)\n", adapter.Executable(), molten.AgentDisplayName(agent))
		return moltenAgentLaunchMissingCode
	}
	if reason := agentlaunch.StepAsideReason(getenv, args, adapter); reason != "" {
		return execAgentBinary(real, args, os.Environ())
	}
	start := time.Now()
	connected := moltenLaunchConnect(getenv(wshutil.WaveJwtTokenVarName))
	report, finalArgs, env := planMoltenAgentLaunch(adapter, real, args, getenv, start)
	sendMoltenLaunchReport(connected, report, start)
	return execAgentBinary(real, finalArgs, env)
}

// planMoltenAgentLaunch asks the adapter what to add and writes its files. Whatever fails, the user's arguments
// run unchanged and the report says why. The run is the pane's agent either way: its own subprocesses are marked as
// nested, so a `claude -p` they start never takes the pane's session link.
func planMoltenAgentLaunch(adapter agentlaunch.LaunchAdapter, real string, args []string, getenv func(string) string, now time.Time) (molten.AgentIntegrationReport, []string, []string) {
	report := molten.AgentIntegrationReport{BlockId: getenv("WAVETERM_BLOCKID"), Agent: adapter.Id(), RealPath: real}
	if execKeepsPid {
		report.Pid = os.Getpid()
	}
	env := append(os.Environ(), agentlaunch.LaunchedVarName+"="+adapter.Id())
	plan, dataDir, err := moltenLaunchPlanWithin(adapter, args, getenv, moltenAgentLaunchPlanTimeout)
	if err != nil {
		report.StepAside = err.Error()
		return report, args, env
	}
	report.Added, report.Skipped = plan.Added, plan.Skipped
	if plan.StepAside != "" {
		report.StepAside, report.Added = plan.StepAside, nil
		return report, args, env
	}
	if plan.MakeArgs == nil {
		return report, args, env
	}
	if len(plan.Files) == 0 {
		finalArgs := plan.MakeArgs(nil)
		report.Args = addedArgs(finalArgs, args)
		return report, finalArgs, env
	}
	dir := agentlaunch.LaunchDir(dataDir)
	var paths []string
	sweep := false
	for _, f := range plan.Files {
		path, created, err := agentlaunch.WriteLaunchFile(dir, f.Prefix, f.Data, now)
		if err != nil {
			report.StepAside, report.Added = "the integration could not be written: "+err.Error(), nil
			return report, args, env
		}
		paths = append(paths, path)
		sweep = sweep || created
	}
	if sweep {
		agentlaunch.SweepLaunchFiles(dir, now)
	}
	setReportFiles(&report, plan.Files, paths)
	return report, plan.MakeArgs(paths), env
}

// addedArgs is what a plan without files put before the user's arguments (Codex's -c overrides), for the report.
func addedArgs(finalArgs []string, userArgs []string) []string {
	if len(finalArgs) < len(userArgs) {
		return nil
	}
	return finalArgs[:len(finalArgs)-len(userArgs)]
}

// setReportFiles names the generated files in the report, by what they are.
func setReportFiles(report *molten.AgentIntegrationReport, files []agentlaunch.PlannedFile, paths []string) {
	for i, f := range files {
		switch f.Kind {
		case agentlaunch.FileSettings:
			report.Settings = paths[i]
		case agentlaunch.FileMcpConfig:
			report.McpConfig = paths[i]
		}
	}
}

type moltenPlanResult struct {
	plan    agentlaunch.LaunchPlan
	dataDir string
	err     error
}

// moltenLaunchPlanWithin plans within a time cap: settings on a stalled network folder must not hold the agent's
// start, which then runs with nothing added.
func moltenLaunchPlanWithin(adapter agentlaunch.LaunchAdapter, args []string, getenv func(string) string, timeout time.Duration) (agentlaunch.LaunchPlan, string, error) {
	done := make(chan moltenPlanResult, 1)
	go func() {
		defer func() {
			if r := recover(); r != nil {
				done <- moltenPlanResult{err: fmt.Errorf("the integration could not be prepared: %v", r)}
			}
		}()
		plan, dataDir, err := moltenLaunchPlan(adapter, args, getenv)
		done <- moltenPlanResult{plan: plan, dataDir: dataDir, err: err}
	}()
	select {
	case r := <-done:
		return r.plan, r.dataDir, r.err
	case <-time.After(timeout):
		return agentlaunch.LaunchPlan{}, "", fmt.Errorf("reading your settings took longer than %v", timeout)
	}
}

// moltenLaunchPlan asks the adapter what to add to a run started now with these arguments in this folder.
func moltenLaunchPlan(adapter agentlaunch.LaunchAdapter, args []string, getenv func(string) string) (agentlaunch.LaunchPlan, string, error) {
	dataDir, err := moltenLaunchDataDir(getenv)
	if err != nil {
		return agentlaunch.LaunchPlan{}, "", fmt.Errorf("MoltenTerm's data folder was not found: %w", err)
	}
	home, _ := os.UserHomeDir()
	cwd, _ := os.Getwd()
	ctx := agentlaunch.LaunchContext{
		Args:       args,
		Env:        molten.AgentEnv{Home: home, DataDir: dataDir, Getenv: getenv},
		Cwd:        cwd,
		BlockId:    getenv("WAVETERM_BLOCKID"),
		MoltenPath: agentlaunch.MoltenPath(dataDir),
	}
	plan, err := adapter.Plan(ctx)
	if err != nil {
		return plan, dataDir, fmt.Errorf("the integration could not be prepared: %w", err)
	}
	return plan, dataDir, nil
}

// moltenLaunchDataDir is MoltenTerm's data folder: the launcher is <data>/bin/agents/<name>, a link to <data>/bin/wsh.
func moltenLaunchDataDir(getenv func(string) string) (string, error) {
	if dir := getenv(agentlaunch.AgentBinDirVarName); dir != "" && filepath.IsAbs(dir) {
		return filepath.Dir(filepath.Dir(filepath.Clean(dir))), nil
	}
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	dir := filepath.Dir(exe)
	if filepath.Base(dir) == agentlaunch.AgentBinDirName {
		// A copy of wsh in the launchers' folder (Windows), not a link to <data>/bin/wsh.
		dir = filepath.Dir(dir)
	}
	return filepath.Dir(dir), nil
}

// moltenLaunchConnect opens the connection to wavesrv while the plan is made; the channel says whether it is up.
func moltenLaunchConnect(jwt string) chan bool {
	done := make(chan bool, 1)
	go func() {
		done <- jwt != "" && setupRpcClient(nil, jwt) == nil
	}()
	return done
}

// sendMoltenLaunchReport tells the pane what was added, within the launch's time cap: a slow or absent MoltenTerm
// only loses the report.
func sendMoltenLaunchReport(connected chan bool, report molten.AgentIntegrationReport, start time.Time) {
	deadline := start.Add(moltenAgentLaunchReportTimeout)
	select {
	case ok := <-connected:
		if !ok {
			return
		}
	case <-time.After(time.Until(deadline)):
		return
	}
	if RpcContext.BlockId != "" {
		report.BlockId = RpcContext.BlockId
	}
	left := time.Until(deadline)
	if left <= 0 {
		return
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		opts := &wshrpc.RpcOpts{Route: molten.AgentStatesRoute, Timeout: max(int64(left/time.Millisecond), 1)}
		RpcClient.SendRpcRequest(molten.AgentIntegrationReportCommand, report, opts)
	}()
	select {
	case <-done:
	case <-time.After(left):
	}
}
