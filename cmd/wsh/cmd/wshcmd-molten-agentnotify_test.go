// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
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

const testNotifyPayload = `{"type":"agent-turn-complete","thread-id":"0199a8b2-4c1d-7e3f-9a0b-1c2d3e4f5a6b","turn-id":"1","cwd":"/x","input-messages":["fix it 'now' \"please\""],"last-assistant-message":"done\nok"}`

func TestParseMoltenAgentNotifyArgs(t *testing.T) {
	p, err := parseMoltenAgentNotifyArgs([]string{"--agent", "codex", "--", "/bin/notify", "--title", "x", testNotifyPayload})
	if err != nil || p.agent != "codex" || p.sessionOnly || !slices.Equal(p.program, []string{"/bin/notify", "--title", "x"}) || p.payload != testNotifyPayload {
		t.Fatalf("parse: %+v %v", p, err)
	}
	p, err = parseMoltenAgentNotifyArgs([]string{"--agent", "codex", "--", testNotifyPayload})
	if err != nil || len(p.program) != 0 || p.payload != testNotifyPayload {
		t.Fatalf("no user notify: %+v %v", p, err)
	}
	p, err = parseMoltenAgentNotifyArgs([]string{"--agent", "codex", "--session-only", "--", "sh", "-c", "x", testNotifyPayload})
	if err != nil || !p.sessionOnly || !slices.Equal(p.program, []string{"sh", "-c", "x"}) {
		t.Fatalf("session only: %+v %v", p, err)
	}
	for _, bad := range [][]string{{"--agent", "Bad Name", "--", "x"}, {"x"}, {"--agent", "codex", "--session-only"}, {"--agent", "codex", "-x", "--"}} {
		if _, err := parseMoltenAgentNotifyArgs(bad); err == nil {
			t.Fatalf("%q must be refused", bad)
		}
	}
	found, _, err := rootCmd.Find([]string{"molten", "agent", "notify"})
	if err != nil || found != moltenAgentNotifyCmd {
		t.Fatalf("notify routes to %v (%v)", found.Name(), err)
	}
}

// AC2: the user's notify gets exactly Codex's argument, once, and its exit code is the wrapper's; outside a pane
// nothing else happens.
func TestRunMoltenAgentNotifyRunsTheUsersProgram(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("sh")
	}
	dir := t.TempDir()
	log := filepath.Join(dir, "log")
	script := filepath.Join(dir, "notify.sh")
	os.WriteFile(script, []byte("#!/bin/sh\nfor a in \"$@\"; do printf '%s\\0' \"$a\" >>\""+log+"\"; done\nexit 5\n"), 0755)
	noPane := func(string) string { return "" }
	code := runMoltenAgentNotify(moltenNotifyArgs{agent: "codex", program: []string{script, "--title", "a b"}, payload: testNotifyPayload}, noPane)
	if code != 5 {
		t.Fatalf("exit code %d, want the program's 5", code)
	}
	data, _ := os.ReadFile(log)
	got := strings.Split(strings.TrimSuffix(string(data), "\x00"), "\x00")
	if !slices.Equal(got, []string{"--title", "a b", testNotifyPayload}) {
		t.Fatalf("the program got %q", got)
	}
	if code := runMoltenAgentNotify(moltenNotifyArgs{agent: "codex", payload: testNotifyPayload}, noPane); code != 0 {
		t.Fatalf("no user notify: %d", code)
	}
	if code := runMoltenAgentNotify(moltenNotifyArgs{agent: "codex", program: []string{filepath.Join(dir, "missing")}, payload: testNotifyPayload}, noPane); code != 127 {
		t.Fatalf("a missing program: %d", code)
	}
	// A pane whose wavesrv does not answer: the report is given up within its cap, and the program still ran.
	os.Remove(log)
	inPane := func(name string) string {
		return map[string]string{"WAVETERM_BLOCKID": "b", "WAVETERM_JWT": "not-a-token"}[name]
	}
	start := time.Now()
	if code := runMoltenAgentNotify(moltenNotifyArgs{agent: "codex", program: []string{script}, payload: testNotifyPayload}, inPane); code != 5 {
		t.Fatalf("in a pane: %d", code)
	}
	// The cap plus room for a loaded machine to start the script.
	if took := time.Since(start); took > moltenAgentNotifyReportTimeout+3*time.Second {
		t.Fatalf("the report took %v", took)
	}
	if data, _ := os.ReadFile(log); string(data) != testNotifyPayload+"\x00" {
		t.Fatalf("in a pane the program still gets the payload: %q", data)
	}
}

// FR-SHELL-038: the codex launcher's plan writes no file; its -c overrides come first and the report lists them.
func TestPlanMoltenAgentLaunchCodex(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks")
	}
	env, data := launchEnv(t)
	t.Setenv("CODEX_HOME", filepath.Join(filepath.Dir(data), "home", ".codex"))
	getenv := func(name string) string { return env[name] }
	os.WriteFile(filepath.Join(data, "bin", "wsh"), []byte("#!/bin/sh\n"), 0755)
	os.Symlink("wsh", filepath.Join(data, "bin", "molten"))
	report, args, procEnv := planMoltenAgentLaunch(agentlaunch.FindAdapter("codex"), "/real/codex", []string{"fix it"}, getenv, time.Now())
	if report.StepAside != "" || len(args) != 7 || args[len(args)-1] != "fix it" || !slices.Equal(report.Args, args[:6]) {
		t.Fatalf("args %q report %+v", args, report)
	}
	moltenPath := filepath.Join(data, "bin", "molten")
	if args[5] != `notify=["`+moltenPath+`","agent","notify","--agent","codex","--"]` {
		t.Fatalf("notify override %q", args[5])
	}
	if report.Settings != "" || report.McpConfig != "" {
		t.Fatalf("no file for codex: %+v", report)
	}
	if entries, _ := os.ReadDir(agentlaunch.LaunchDir(data)); len(entries) != 0 {
		t.Fatalf("nothing written: %v", entries)
	}
	if !slices.Contains(procEnv, agentlaunch.LaunchedVarName+"=codex") {
		t.Fatalf("the agent's processes must be marked as nested")
	}
	out := formatMoltenIntegrationStatus(MoltenIntegrationStatus{Agent: "codex", Running: true, Report: &report})
	for _, want := range []string{"Codex", "Done state at each turn's end", "-c notify=", "-c mcp_servers.molten-browser.command=", "Agent state hooks: Codex runs hooks"} {
		if !strings.Contains(out, want) {
			t.Errorf("status misses %q:\n%s", want, out)
		}
	}
	dry := planMoltenAgentLaunchDry(agentlaunch.FindAdapter("codex"), "/real/codex", getenv)
	if !slices.Equal(dry.Args, report.Args) {
		t.Fatalf("dry run %+v", dry)
	}
	if !slices.ContainsFunc(report.Added, func(it molten.IntegrationItem) bool { return it.Kind == molten.IntegrationNotify }) {
		t.Fatalf("added %+v", report.Added)
	}
}
