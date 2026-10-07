// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentlaunch"
)

func TestMoltenRewriteArgsForLaunchers(t *testing.T) {
	cases := []struct {
		in   []string
		want []string
	}{
		{[]string{"claude"}, []string{"claude", "molten", "agent", "launch", "--agent", "claude", "--"}},
		{[]string{"/d/bin/agents/claude", "-p", "--version", "--", "x"}, []string{"/d/bin/agents/claude", "molten", "agent", "launch", "--agent", "claude", "--", "-p", "--version", "--", "x"}},
		{[]string{`C:\d\bin\agents\claude.exe`, "mcp"}, []string{`C:\d\bin\agents\claude.exe`, "molten", "agent", "launch", "--agent", "claude", "--", "mcp"}},
		{[]string{"/d/bin/claude-wrapper", "x"}, []string{"/d/bin/claude-wrapper", "x"}},
	}
	for _, c := range cases {
		if got := moltenRewriteArgs(c.in); !slices.Equal(got, c.want) {
			t.Errorf("moltenRewriteArgs(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	agent, rest, err := parseMoltenAgentLaunchArgs([]string{"--agent", "claude", "--", "-b", "--help"})
	if err != nil || agent != "claude" || !slices.Equal(rest, []string{"-b", "--help"}) {
		t.Fatalf("parse: %q %q %v", agent, rest, err)
	}
	if _, _, err := parseMoltenAgentLaunchArgs([]string{"claude"}); err == nil {
		t.Fatalf("a launch without --agent and -- must fail")
	}
	found, _, err := rootCmd.Find([]string{"molten", "agent", "integration", "status"})
	if err != nil || found != moltenAgentIntegrationStatusCmd {
		t.Fatalf("status routes to %v (%v)", found.Name(), err)
	}
	found, _, err = rootCmd.Find([]string{"molten", "agent", "launch"})
	if err != nil || found != moltenAgentLaunchCmd {
		t.Fatalf("launch routes to %v (%v)", found.Name(), err)
	}
}

// launchEnv is a pane's environment for the launcher's planning, with a home and a data folder of its own.
func launchEnv(t *testing.T) (map[string]string, string) {
	t.Helper()
	root := t.TempDir()
	home := filepath.Join(root, "home")
	data := filepath.Join(root, "data")
	os.MkdirAll(filepath.Join(data, "bin", "agents"), 0755)
	os.MkdirAll(home, 0755)
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(home, ".claude"))
	t.Chdir(home)
	return map[string]string{
		"WAVETERM_BLOCKID":             "block-1",
		agentlaunch.AgentBinDirVarName: filepath.Join(data, "bin", "agents"),
		"CLAUDE_CONFIG_DIR":            filepath.Join(home, ".claude"),
	}, data
}

func TestPlanMoltenAgentLaunch(t *testing.T) {
	env, data := launchEnv(t)
	getenv := func(name string) string { return env[name] }
	report, args, procEnv := planMoltenAgentLaunch(agentlaunch.FindAdapter("claude"), "/real/claude", []string{"-p", "hi"}, getenv, time.Now())
	if report.StepAside != "" || len(report.Added) != 3 || report.RealPath != "/real/claude" || report.BlockId != "block-1" {
		t.Fatalf("report %+v", report)
	}
	if len(args) != 4 || args[0] != "--settings" || !strings.HasPrefix(args[1], agentlaunch.LaunchDir(data)) || !slices.Equal(args[2:], []string{"-p", "hi"}) {
		t.Fatalf("args %q", args)
	}
	if _, err := os.Stat(args[1]); err != nil {
		t.Fatalf("the settings file must exist: %v", err)
	}
	if !slices.Contains(procEnv, agentlaunch.LaunchedVarName+"=claude") {
		t.Fatalf("the agent's processes must be marked as nested")
	}
	if runtime.GOOS != "windows" && report.Pid != os.Getpid() {
		t.Fatalf("the agent keeps the launcher's pid: %d", report.Pid)
	}
}

// FR-SHELL-036 AC10: when preparing fails, the user's arguments run unchanged and the report says why.
func TestPlanMoltenAgentLaunchFailures(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("permissions")
	}
	env, data := launchEnv(t)
	getenv := func(name string) string { return env[name] }
	os.MkdirAll(filepath.Join(data, "molten"), 0755)
	os.WriteFile(agentlaunch.LaunchDir(data), []byte("not a folder"), 0644)
	report, args, procEnv := planMoltenAgentLaunch(agentlaunch.FindAdapter("claude"), "/real/claude", []string{"-p", "hi"}, getenv, time.Now())
	if !strings.Contains(report.StepAside, "could not be written") || len(report.Added) != 0 || !slices.Equal(args, []string{"-p", "hi"}) {
		t.Fatalf("unwritable folder: %+v %q", report, args)
	}
	if !slices.Contains(procEnv, agentlaunch.LaunchedVarName+"=claude") {
		t.Fatalf("still the pane's agent: its subprocesses are nested")
	}
	report, args, _ = planMoltenAgentLaunch(agentlaunch.FindAdapter("claude"), "/real/claude", []string{"--settings", "nope.json"}, getenv, time.Now())
	if !strings.Contains(report.StepAside, "could not be prepared") || !slices.Equal(args, []string{"--settings", "nope.json"}) {
		t.Fatalf("unreadable --settings: %+v %q", report, args)
	}
}

func TestFormatMoltenIntegrationStatus(t *testing.T) {
	running := MoltenIntegrationStatus{Agent: "claude", Running: true, Launcher: true, Report: &molten.AgentIntegrationReport{
		Agent: "claude", RealPath: "/h/.local/bin/claude", Settings: "/d/molten/agent-launch/claude-1.json",
		Added:   []molten.IntegrationItem{{Kind: molten.IntegrationStateHooks, Name: "Agent state hooks (Stop)"}},
		Skipped: []molten.IntegrationItem{{Kind: molten.IntegrationSession, Name: "Session link", Reason: "already yours, in ~/.claude/settings.json"}},
	}}
	out := formatMoltenIntegrationStatus(running)
	for _, want := range []string{"Claude Code", "Real binary: /h/.local/bin/claude", "Added to this run", "Agent state hooks (Stop)", "--settings /d/molten", "Session link: already yours"} {
		if !strings.Contains(out, want) {
			t.Errorf("running status misses %q:\n%s", want, out)
		}
	}
	planned := MoltenIntegrationStatus{Agent: "claude", OnPath: "/h/.local/bin/claude", Report: &molten.AgentIntegrationReport{RealPath: "/h/.local/bin/claude", StepAside: "`claude` does not run MoltenTerm's launcher in this shell"}}
	out = formatMoltenIntegrationStatus(planned)
	for _, want := range []string{"not MoltenTerm's launcher", "Nothing added"} {
		if !strings.Contains(out, want) {
			t.Errorf("planned status misses %q:\n%s", want, out)
		}
	}
	missing := formatMoltenIntegrationStatus(MoltenIntegrationStatus{Agent: "claude", Note: "no Claude Code found on PATH"})
	if !strings.Contains(missing, "No Claude Code found on PATH") {
		t.Errorf("missing: %s", missing)
	}
}

// FR-SHELL-036 AC3: through the relay, the user's status line prints the same bytes as when Claude Code runs it.
func TestStatusLineRelayOutputIsTheUsers(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("sh")
	}
	user := `printf '[%s]' "$(cat)"; printf 'end\n' >&2; exit 3`
	input := []byte(`{"cwd":"/x","rate_limits":{"five_hour":{"used_percentage":40}}}`)
	var relayOut, relayErr bytes.Buffer
	code := runStatusLineRelay(bytes.NewReader(input), &relayOut, &relayErr, []string{user}, func(molten.AgentStatusLineRequest) {})
	var plainOut, plainErr bytes.Buffer
	plainCode := runStatusLineCommand([]string{user}, bytes.NewReader(input), &plainOut, &plainErr)
	if relayOut.String() != plainOut.String() || relayErr.String() != plainErr.String() || code != plainCode {
		t.Fatalf("relay %q %q %d, plain %q %q %d", relayOut.String(), relayErr.String(), code, plainOut.String(), plainErr.String(), plainCode)
	}
}
