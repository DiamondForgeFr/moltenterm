// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

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
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
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

// The project's places (FR-SHELL-105) are asked of wavesrv before the plan, which reads the project's settings from
// the folder the agent starts in; past this, the project adds nothing and the run starts where the terminal is.
const moltenAgentLaunchPlacesTimeout = 200 * time.Millisecond

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
	real, ok := findMoltenLaunchBinary(adapter, getenv)
	if !ok {
		return moltenAgentLaunchMissingCode
	}
	if reason := agentlaunch.StepAsideReason(getenv, args, adapter); reason != "" {
		return execAgentBinary(real, args, os.Environ())
	}
	start := time.Now()
	connected := moltenLaunchConnect(getenv(wshutil.WaveJwtTokenVarName))
	settings, reportConn, places := moltenLaunchSettings(connected, start.Add(moltenAgentLaunchReportTimeout))
	project := moltenLaunchPlaces(places, start.Add(moltenAgentLaunchPlacesTimeout))
	gate := func() string {
		return moltenLaunchSettingsStepAside(settings, adapter.Id(), start.Add(moltenAgentLaunchReportTimeout))
	}
	report, finalArgs, env, startDir := planMoltenAgentLaunchHooks(adapter, real, args, getenv, start, gate, project)
	sendMoltenLaunchReport(reportConn, report, start)
	if startDir != "" && os.Chdir(startDir) == nil {
		env = moltenSetEnv(env, "PWD", startDir)
	}
	return execAgentBinary(real, finalArgs, env)
}

// findMoltenLaunchBinary finds the agent on PATH, else in another Node version's global folder (#1922), and says on
// stderr which one it runs, or what it searched and how to install the agent.
func findMoltenLaunchBinary(adapter agentlaunch.LaunchAdapter, getenv func(string) string) (string, bool) {
	search, ok := agentlaunch.FindAgentBinary(adapter.Executable(), getenv, agentlaunch.IsLauncher)
	if !ok {
		WriteStderr("%s", agentlaunch.NotFoundMessage(adapter, search))
		return "", false
	}
	if note := agentlaunch.FallbackNote(adapter, search); note != "" {
		WriteStderr("%s\n", note)
	}
	return search.Path, true
}

// moltenSetEnv sets a variable in an environment list, replacing the one it had.
func moltenSetEnv(env []string, name string, value string) []string {
	rtn := make([]string, 0, len(env)+1)
	for _, entry := range env {
		if !strings.HasPrefix(entry, name+"=") {
			rtn = append(rtn, entry)
		}
	}
	return append(rtn, name+"="+value)
}

// moltenLaunchSettings asks wavesrv for the project's places (FR-SHELL-105), then for the integration settings
// (FR-SHELL-040), once connected, and relays the connection's outcome for the report. A nil answer: the settings
// could not be read before the deadline; no places: the terminal's workspace has no project, or they were not read.
func moltenLaunchSettings(connected chan bool, deadline time.Time) (chan *agentlaunch.IntegrationSettings, chan bool, chan agentlaunch.ProjectPlaces) {
	settings := make(chan *agentlaunch.IntegrationSettings, 1)
	relay := make(chan bool, 1)
	places := make(chan agentlaunch.ProjectPlaces, 1)
	go func() {
		ok := <-connected
		relay <- ok
		left := time.Until(deadline)
		if !ok || left <= 0 {
			places <- agentlaunch.ProjectPlaces{}
			settings <- nil
			return
		}
		places <- moltenReadProjectPlaces(left)
		left = time.Until(deadline)
		if left <= 0 {
			settings <- nil
			return
		}
		config, err := wshclient.GetFullConfigCommand(RpcClient, &wshrpc.RpcOpts{Timeout: max(int64(left/time.Millisecond), 1)})
		if err != nil {
			settings <- nil
			return
		}
		settings <- &agentlaunch.IntegrationSettings{Integrate: config.Settings.AgentIntegrate, Off: config.Settings.AgentIntegrateOff}
	}()
	return settings, relay, places
}

// moltenReadProjectPlaces reads the terminal's workspace project: its folder and the code repository inside it. Any
// doubt (no workspace, no project, a slow answer) gives no places, and the project adds nothing.
func moltenReadProjectPlaces(timeout time.Duration) agentlaunch.ProjectPlaces {
	blockId := RpcContext.BlockId
	if blockId == "" {
		blockId = os.Getenv("WAVETERM_BLOCKID")
	}
	if blockId == "" || RpcContext.Conn != "" {
		return agentlaunch.ProjectPlaces{}
	}
	opts := &wshrpc.RpcOpts{Timeout: max(int64(timeout/time.Millisecond), 1)}
	resolved, err := wshclient.ResolveIdsCommand(RpcClient, wshrpc.CommandResolveIdsData{BlockId: blockId, Ids: []string{"workspace"}}, opts)
	if err != nil {
		return agentlaunch.ProjectPlaces{}
	}
	oref, ok := resolved.ResolvedIds["workspace"]
	if !ok {
		return agentlaunch.ProjectPlaces{}
	}
	meta, err := wshclient.GetMetaCommand(RpcClient, wshrpc.CommandGetMetaData{ORef: oref}, opts)
	if err != nil {
		return agentlaunch.ProjectPlaces{}
	}
	return moltenProjectPlacesOf(meta)
}

func moltenProjectPlacesOf(meta map[string]any) agentlaunch.ProjectPlaces {
	folder := moltenMetaString(meta, molten.ProjectMetaKey)
	return agentlaunch.ProjectPlaces{Folder: folder, Repo: molten.WorkspaceRepoOfMap(meta)}
}

// moltenLaunchPlaces waits for the project's places until the deadline.
func moltenLaunchPlaces(places chan agentlaunch.ProjectPlaces, deadline time.Time) agentlaunch.ProjectPlaces {
	select {
	case p := <-places:
		return p
	case <-time.After(time.Until(deadline)):
		return agentlaunch.ProjectPlaces{}
	}
}

// moltenLaunchSettingsStepAside waits for the settings until the deadline: off, or unknown, the run gets nothing (on
// any doubt the launcher steps aside).
func moltenLaunchSettingsStepAside(settings chan *agentlaunch.IntegrationSettings, agentId string, deadline time.Time) string {
	select {
	case s := <-settings:
		if s == nil {
			return agentlaunch.StepAsideSettingsUnknown
		}
		return s.StepAside(agentId)
	case <-time.After(time.Until(deadline)):
		return agentlaunch.StepAsideSettingsUnknown
	}
}

// planMoltenAgentLaunch asks the adapter what to add and writes its files. Whatever fails, the user's arguments
// run unchanged and the report says why. The run is the pane's agent either way: its own subprocesses are marked as
// nested, so a `claude -p` they start never takes the pane's session link.
func planMoltenAgentLaunch(adapter agentlaunch.LaunchAdapter, real string, args []string, getenv func(string) string, now time.Time) (molten.AgentIntegrationReport, []string, []string) {
	return planMoltenAgentLaunchWith(adapter, real, args, getenv, now, nil)
}

// planMoltenAgentLaunchWith plans like planMoltenAgentLaunch; gate, when set, is asked once the plan is made and before
// anything is written or added: a reason it gives keeps the run as the user started it.
func planMoltenAgentLaunchWith(adapter agentlaunch.LaunchAdapter, real string, args []string, getenv func(string) string, now time.Time, gate func() string) (molten.AgentIntegrationReport, []string, []string) {
	report, finalArgs, env, _ := planMoltenAgentLaunchHooks(adapter, real, args, getenv, now, gate, agentlaunch.ProjectPlaces{})
	return report, finalArgs, env
}

// planMoltenAgentLaunchHooks plans like planMoltenAgentLaunchWith for a terminal whose workspace project has these
// places (FR-SHELL-105). It also returns the folder the real binary must start in, "" for the terminal's own.
func planMoltenAgentLaunchHooks(adapter agentlaunch.LaunchAdapter, real string, args []string, getenv func(string) string, now time.Time, gate func() string, project agentlaunch.ProjectPlaces) (molten.AgentIntegrationReport, []string, []string, string) {
	report := molten.AgentIntegrationReport{BlockId: getenv("WAVETERM_BLOCKID"), Agent: adapter.Id(), RealPath: real}
	if execKeepsPid {
		report.Pid = os.Getpid()
	}
	env := append(os.Environ(), agentlaunch.LaunchedVarName+"="+adapter.Id())
	plan, dataDir, err := moltenLaunchPlanWithin(adapter, args, getenv, moltenAgentLaunchPlanTimeout, project)
	if err != nil {
		report.StepAside, report.StepAsideText = err.Error(), uimsg.TextOf(err)
		return report, args, env, ""
	}
	report.Added, report.Skipped = plan.Added, plan.Skipped
	if plan.StepAside != "" {
		report.StepAside, report.StepAsideText, report.Added = plan.StepAside, plan.StepAsideText, nil
		return report, args, env, ""
	}
	if gate != nil {
		if reason := gate(); reason != "" {
			report.StepAside, report.StepAsideText, report.Added, report.Skipped = reason, agentlaunch.StepAsideTextOf(reason), nil, nil
			return report, args, env, ""
		}
	}
	if plan.MakeArgs == nil {
		return report, args, env, plan.StartDir
	}
	report.Args = plan.ShownArgs
	if len(plan.Files) == 0 {
		return report, plan.MakeArgs(nil), env, plan.StartDir
	}
	dir := agentlaunch.LaunchDir(dataDir)
	var paths []string
	sweep := false
	for _, f := range plan.Files {
		path, created, err := agentlaunch.WriteLaunchFile(dir, f.Prefix, f.Data, now)
		if err != nil {
			report.StepAside, report.Added, report.Args = "the integration could not be written: "+err.Error(), nil, nil
			report.StepAsideText = uimsg.Make("integration.stepaside.notwritten", "detail", err.Error())
			return report, args, env, ""
		}
		paths = append(paths, path)
		sweep = sweep || created
	}
	if sweep {
		agentlaunch.SweepLaunchFiles(dir, now)
	}
	setReportFiles(&report, plan.Files, paths)
	return report, plan.MakeArgs(paths), env, plan.StartDir
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
func moltenLaunchPlanWithin(adapter agentlaunch.LaunchAdapter, args []string, getenv func(string) string, timeout time.Duration, project agentlaunch.ProjectPlaces) (agentlaunch.LaunchPlan, string, error) {
	done := make(chan moltenPlanResult, 1)
	go func() {
		defer func() {
			if r := recover(); r != nil {
				done <- moltenPlanResult{err: fmt.Errorf("the integration could not be prepared: %v", r)}
			}
		}()
		plan, dataDir, err := moltenLaunchPlan(adapter, args, getenv, project)
		done <- moltenPlanResult{plan: plan, dataDir: dataDir, err: err}
	}()
	select {
	case r := <-done:
		return r.plan, r.dataDir, r.err
	case <-time.After(timeout):
		return agentlaunch.LaunchPlan{}, "", fmt.Errorf("reading your settings took longer than %v", timeout)
	}
}

// moltenLaunchPlan asks the adapter what to add to a run started now with these arguments in this folder. A project
// that starts the run in its repository has the plan read the settings of that folder, where the agent will run.
func moltenLaunchPlan(adapter agentlaunch.LaunchAdapter, args []string, getenv func(string) string, project agentlaunch.ProjectPlaces) (agentlaunch.LaunchPlan, string, error) {
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
		Project:    project,
	}
	var projectPlan agentlaunch.ProjectPlan
	if projecting, ok := adapter.(agentlaunch.ProjectAdapter); ok && project.Folder != "" {
		projectPlan = projecting.PlanProject(ctx)
		if projectPlan.StartDir != "" {
			ctx.Cwd = projectPlan.StartDir
		}
	}
	plan, err := adapter.Plan(ctx)
	if err != nil {
		return plan, dataDir, fmt.Errorf("the integration could not be prepared: %w", err)
	}
	return plan.WithProject(projectPlan, args), dataDir, nil
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
