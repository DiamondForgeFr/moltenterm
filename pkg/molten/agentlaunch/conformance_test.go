// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentlaunch

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/BurntSushi/toml"
	"github.com/wavetermdev/waveterm/pkg/molten"
)

// launchRun is one planned run of a launcher, its files written to the data folder as the launcher writes them.
type launchRun struct {
	plan LaunchPlan
	args []string
	// files: what was written, by kind.
	files map[string][]byte
}

type launchConformanceCase struct {
	// userFiles: the user's own configuration, present before the run and left as it was.
	userFiles map[string]string
	ctx       func(tree fakeTree) LaunchContext
	check     func(t *testing.T, run launchRun)
}

// launchConformance holds one case per launch adapter (FR-AGC-006): the cells launcher, state, approvals, turnnotify,
// statusline, browsermcp and instructions of the compatibility matrix rest on what the run gets here.
var launchConformance = map[string]launchConformanceCase{
	ClaudeAgentId: {
		userFiles: map[string]string{
			".claude/settings.json": `{"statusLine":{"type":"command","command":"echo mine"},"hooks":{}}`,
			".claude.json":          `{"mcpServers":{"github":{"command":"gh"}}}`,
		},
		ctx:   func(tree fakeTree) LaunchContext { return tree.browserCtx("fix the tests") },
		check: checkClaudeLaunch,
	},
	CodexAgentId: {
		userFiles: map[string]string{
			".codex/config.toml": "model = \"gpt-5.4\"\nnotify = [\"my-notify\"]\n",
		},
		ctx:   func(tree fakeTree) LaunchContext { return tree.codexCtx("fix the tests") },
		check: checkCodexLaunch,
	},
}

// FR-AGC-006 AC-2: every launcher plans its run's options, writes its files in the data folder only, and leaves the
// fake HOME as it was everywhere else.
func TestLaunchConformance(t *testing.T) {
	for id := range adapters {
		if _, ok := launchConformance[id]; !ok {
			t.Errorf("launch adapter %s has no conformance case", id)
		}
	}
	for id, tc := range launchConformance {
		t.Run(id, func(t *testing.T) {
			a := FindAdapter(id)
			if a == nil {
				t.Fatalf("no launch adapter for %s", id)
			}
			if !a.PassThrough([]string{"--version"}) || a.PassThrough([]string{"fix the tests"}) {
				t.Fatalf("--version must run the real binary unchanged, a prompt must not")
			}
			tree := makeFakeTree(t)
			for rel, content := range tc.userFiles {
				tree.write(t, filepath.Join(tree.home, rel), content)
			}
			ctx := tc.ctx(tree)
			before := hashTree(t, tree.home)
			plan, err := a.Plan(ctx)
			if err != nil {
				t.Fatalf("plan: %v", err)
			}
			if plan.StepAside != "" {
				t.Fatalf("the launcher stepped aside: %s", plan.StepAside)
			}
			run := launchRun{plan: plan, files: map[string][]byte{}}
			var paths []string
			for _, f := range plan.Files {
				path, _, err := WriteLaunchFile(LaunchDir(ctx.Env.DataDir), f.Prefix, f.Data, time.Now())
				if err != nil {
					t.Fatal(err)
				}
				paths = append(paths, path)
				run.files[f.Kind] = f.Data
			}
			if plan.MakeArgs == nil {
				t.Fatalf("the plan adds nothing to the run")
			}
			run.args = plan.MakeArgs(paths)
			if !slices.Equal(run.args[len(run.args)-1:], []string{"fix the tests"}) {
				t.Fatalf("the user's prompt must stay last and unchanged: %q", run.args)
			}
			for _, p := range paths {
				if !strings.HasPrefix(p, ctx.Env.DataDir+string(filepath.Separator)) {
					t.Fatalf("%s is written outside the data folder %s", p, ctx.Env.DataDir)
				}
			}
			assertHomeUnchangedOutside(t, tree.home, ctx.Env.DataDir, before)
			tc.check(t, run)
		})
	}
}

// assertHomeUnchangedOutside compares a fingerprint of home with before, ignoring the data folder.
func assertHomeUnchangedOutside(t *testing.T, home string, dataDir string, before map[string]string) {
	t.Helper()
	inData := func(path string) bool { return strings.HasPrefix(path, dataDir+string(filepath.Separator)) }
	after := hashTree(t, home)
	for path, h := range after {
		if inData(path) {
			continue
		}
		if before[path] != h {
			t.Errorf("%s was written outside the data folder", path)
		}
	}
	for path := range before {
		if _, ok := after[path]; !ok && !inData(path) {
			t.Errorf("%s was removed", path)
		}
	}
}

func checkClaudeLaunch(t *testing.T, run launchRun) {
	if !slices.ContainsFunc(run.args, func(a string) bool { return strings.HasPrefix(a, "--mcp-config=") }) ||
		!slices.Contains(run.args, "--settings") {
		t.Fatalf("launch options --mcp-config and --settings: %q", run.args)
	}
	var mcp struct {
		McpServers map[string]struct {
			Type    string   `json:"type"`
			Command string   `json:"command"`
			Args    []string `json:"args"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal(run.files[FileMcpConfig], &mcp); err != nil {
		t.Fatalf("mcp config: %v", err)
	}
	if s, ok := mcp.McpServers["molten-browser"]; !ok || s.Type != "stdio" || s.Command != testMolten || !slices.Equal(s.Args, []string{"mcp", "browser"}) {
		t.Fatalf("molten-browser is not registered: %s", run.files[FileMcpConfig])
	}
	var gen generatedSettings
	if err := json.Unmarshal(run.files[FileSettings], &gen); err != nil {
		t.Fatalf("settings: %v", err)
	}
	for _, h := range molten.AgentStateHooks(molten.AgentIdClaude) {
		if !slices.Contains(hookCommands(gen, h.Event), h.Command) {
			t.Errorf("state hook %s missing: %v", h.Event, hookCommands(gen, h.Event))
		}
	}
	if !slices.ContainsFunc(hookCommands(gen, molten.ClaudePermissionHookEvent), molten.IsAgentPermissionHookCommand) {
		t.Errorf("coffee approvals' PermissionRequest hook missing")
	}
	command, _ := gen.StatusLine["command"].(string)
	if !molten.IsStatusLineRelayCommand(command) || !strings.Contains(command, "echo mine") {
		t.Errorf("the user's status line must be wrapped by the relay: %q", command)
	}
}

func checkCodexLaunch(t *testing.T, run launchRun) {
	if len(run.files) != 0 {
		t.Fatalf("Codex's run is given with -c only, no file: %v", run.files)
	}
	overrides := map[string]any{}
	for i := 0; i+1 < len(run.args); i++ {
		if run.args[i] != codexConfigFlag {
			continue
		}
		key, value, ok := strings.Cut(run.args[i+1], "=")
		if !ok {
			t.Fatalf("no = in %q", run.args[i+1])
		}
		var doc map[string]any
		if _, err := toml.Decode("v = "+value, &doc); err != nil {
			t.Fatalf("%s is not valid TOML: %v", run.args[i+1], err)
		}
		overrides[key] = doc["v"]
		i++
	}
	if overrides["mcp_servers.molten-browser.command"] != codexTestMolten {
		t.Errorf("molten-browser is not registered: %v", overrides)
	}
	notify, _ := overrides[codexNotifyKey].([]any)
	if len(notify) == 0 || notify[0] != codexTestMolten || notify[len(notify)-1] != "my-notify" {
		t.Errorf("notify must wrap the user's own: %v", notify)
	}
	for _, h := range molten.AgentStateHooks(molten.AgentIdCodex) {
		if _, ok := overrides[codexHooksKey+"."+h.Event]; !ok {
			t.Errorf("state hook %s missing", h.Event)
		}
	}
	if _, ok := overrides[codexPermissionOverrideKey]; !ok {
		t.Errorf("coffee approvals' PermissionRequest hook missing")
	}
	if _, ok := overrides[codexTuiKey+"."+codexTuiNotifications]; !ok {
		t.Errorf("tui.notifications missing")
	}
	for _, a := range run.args {
		if strings.Contains(strings.ToLower(a), "statusline") || strings.Contains(a, "bypass") {
			t.Errorf("no status line relay and no trust bypass for Codex: %q", a)
		}
	}
}

// FR-AGC-006: the matrix's none cell "status line relay" for Codex has no code path: its launcher adds none, whatever
// the user's configuration holds.
func TestCodexLaunchHasNoStatusLine(t *testing.T) {
	tree := makeFakeTree(t)
	tree.write(t, filepath.Join(tree.home, ".codex", "config.toml"), "[tui]\nstatus_line = [\"model\"]\n")
	plan, err := codexAdapter{}.Plan(tree.codexCtx("fix the tests"))
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range plan.MakeArgs(nil) {
		if molten.IsStatusLineRelayCommand(a) || strings.Contains(a, "agent statusline") {
			t.Fatalf("a status line relay in Codex's run: %q", a)
		}
	}
	if entries, _ := os.ReadDir(LaunchDir(tree.ctx().Env.DataDir)); len(entries) != 0 {
		t.Fatalf("files written: %v", entries)
	}
}
