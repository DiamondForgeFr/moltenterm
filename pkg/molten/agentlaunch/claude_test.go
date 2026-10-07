// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentlaunch

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentdocs"
	"github.com/wavetermdev/waveterm/pkg/util/shellutil"
)

type fakeTree struct {
	home    string
	project string
	managed string
}

// makeFakeTree builds a home folder with a project (a git repository) and a managed settings path, all empty.
func makeFakeTree(t *testing.T) fakeTree {
	t.Helper()
	root := t.TempDir()
	tree := fakeTree{home: filepath.Join(root, "home"), managed: filepath.Join(root, "managed-settings.json")}
	tree.project = filepath.Join(tree.home, "src", "app")
	if err := os.MkdirAll(filepath.Join(tree.project, ".git"), 0755); err != nil {
		t.Fatal(err)
	}
	return tree
}

func (f fakeTree) write(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

func (f fakeTree) userSettings() string { return filepath.Join(f.home, ".claude", "settings.json") }

func (f fakeTree) ctx(args ...string) LaunchContext {
	return LaunchContext{
		Args:            args,
		Env:             molten.AgentEnv{Home: f.home, DataDir: filepath.Join(f.home, "data"), Getenv: func(string) string { return "" }},
		Cwd:             f.project,
		BlockId:         "block-1",
		ManagedSettings: f.managed,
	}
}

type generatedSettings struct {
	Hooks map[string][]struct {
		Matcher string `json:"matcher"`
		Hooks   []struct {
			Type    string `json:"type"`
			Command string `json:"command"`
		} `json:"hooks"`
	} `json:"hooks"`
	StatusLine map[string]any `json:"statusLine"`
}

func planOf(t *testing.T, ctx LaunchContext) (LaunchPlan, generatedSettings, map[string]json.RawMessage) {
	t.Helper()
	plan, err := claudeAdapter{}.Plan(ctx)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	var gen generatedSettings
	var raw map[string]json.RawMessage
	if len(plan.Files) == 1 {
		if err := json.Unmarshal(plan.Files[0].Data, &gen); err != nil {
			t.Fatalf("generated settings do not parse: %v\n%s", err, plan.Files[0].Data)
		}
		json.Unmarshal(plan.Files[0].Data, &raw)
	}
	return plan, gen, raw
}

func hookCommands(gen generatedSettings, event string) []string {
	var rtn []string
	for _, m := range gen.Hooks[event] {
		for _, h := range m.Hooks {
			rtn = append(rtn, h.Command)
		}
	}
	return rtn
}

func itemKinds(items []molten.IntegrationItem) []string {
	var rtn []string
	for _, it := range items {
		rtn = append(rtn, it.Kind)
	}
	return rtn
}

func TestClaudePassThrough(t *testing.T) {
	cases := map[string]bool{
		"":                               false,
		"--version":                      true,
		"-v":                             true,
		"--help":                         true,
		"mcp list":                       true,
		"doctor":                         true,
		"update":                         true,
		"install stable":                 true,
		"config list":                    true,
		"plugin install x":               true,
		"--model opus":                   false,
		"-p hello":                       false,
		"--resume":                       false,
		"--continue fix the tests":       false,
		"--bg":                           true,
		"--bare -p x":                    true,
		"-- --version":                   false,
		"explain mcp":                    false,
		"--dangerously-skip-permissions": false,
	}
	for line, want := range cases {
		if got := (claudeAdapter{}).PassThrough(strings.Fields(line)); got != want {
			t.Errorf("PassThrough(%q) = %v, want %v", line, got, want)
		}
	}
}

// FR-SHELL-036 AC1, AC3: with no settings at all, a run gets the four state hooks and the session link with the exact
// command strings of agent-states.md, and a status line that is the relay alone (it prints nothing).
func TestClaudePlanEmptySettings(t *testing.T) {
	tree := makeFakeTree(t)
	plan, gen, raw := planOf(t, tree.ctx("-p", "hi"))
	if plan.StepAside != "" || len(plan.Files) != 1 {
		t.Fatalf("plan %+v", plan)
	}
	doc, err := fs.ReadFile(agentdocs.Files, "agent-states.md")
	if err != nil {
		t.Fatal(err)
	}
	for _, h := range molten.ClaudeStateHooks() {
		if got := hookCommands(gen, h.Event); !slices.Equal(got, []string{h.Command}) {
			t.Errorf("%s: %q, want %q", h.Event, got, h.Command)
		}
		quoted := jsonString(h.Command)
		if !strings.Contains(string(doc), string(quoted)) {
			t.Errorf("%s: the command is not agent-states.md's: %s", h.Event, quoted)
		}
	}
	if len(molten.ClaudeStateHooks()) != 4 {
		t.Fatalf("state hooks: %v", molten.ClaudeStateHooks())
	}
	if got := hookCommands(gen, "SessionStart"); !slices.Equal(got, []string{molten.ClaudeSessionHookCommand}) {
		t.Errorf("SessionStart: %q", got)
	}
	quoted := jsonString(molten.ClaudeSessionHookCommand)
	if !strings.Contains(string(doc), string(quoted)) {
		t.Errorf("SessionStart is not agent-states.md's: %s", quoted)
	}
	for event, matchers := range gen.Hooks {
		for _, m := range matchers {
			if m.Matcher != "" {
				t.Errorf("%s has a matcher %q: SessionStart must run on startup, resume, clear and compact", event, m.Matcher)
			}
		}
	}
	if gen.StatusLine["type"] != "command" || gen.StatusLine["command"] != molten.StatusLineRelayCommand("") {
		t.Errorf("status line %v", gen.StatusLine)
	}
	for key := range raw {
		if key != "hooks" && key != "statusLine" {
			t.Errorf("the generated settings set %q", key)
		}
	}
	if got := itemKinds(plan.Added); !slices.Equal(got, []string{molten.IntegrationStateHooks, molten.IntegrationSession, molten.IntegrationStatusLine}) {
		t.Errorf("added %v", got)
	}
	args := plan.MakeArgs([]string{"/data/claude-x.json"})
	if !slices.Equal(args, []string{"--settings", "/data/claude-x.json", "-p", "hi"}) {
		t.Errorf("args %q", args)
	}
}

// FR-SHELL-036 AC3: the user's status line is wrapped, its other fields kept; without molten on PATH the wrapped
// command prints exactly what the user's printed.
func TestClaudePlanWrapsUserStatusLine(t *testing.T) {
	tree := makeFakeTree(t)
	user := `printf '%s|' "$(cat)"; echo "marker 'q'"`
	settings, _ := json.Marshal(map[string]any{"statusLine": map[string]any{"type": "command", "command": user, "padding": 2}, "model": "opus"})
	tree.write(t, tree.userSettings(), string(settings))
	plan, gen, _ := planOf(t, tree.ctx())
	if gen.StatusLine["command"] != molten.StatusLineRelayCommand(user) || gen.StatusLine["padding"] != float64(2) {
		t.Fatalf("status line %v", gen.StatusLine)
	}
	if _, ok := gen.Hooks["Stop"]; !ok {
		t.Fatalf("hooks missing: %v", gen.Hooks)
	}
	if !slices.Contains(itemKinds(plan.Added), molten.IntegrationStatusLine) {
		t.Fatalf("added %v", plan.Added)
	}
	if runtime.GOOS == "windows" {
		return
	}
	input := `{"model":{"display_name":"Opus"},"rate_limits":{"five_hour":{"used_percentage":12}}}`
	run := func(command string) string {
		c := exec.Command("/bin/sh", "-c", command)
		c.Env = []string{"PATH=/usr/bin:/bin"}
		c.Stdin = strings.NewReader(input)
		out, err := c.CombinedOutput()
		if err != nil {
			t.Fatalf("%q: %v %s", command, err, out)
		}
		return string(out)
	}
	if got, want := run(gen.StatusLine["command"].(string)), run(user); got != want {
		t.Fatalf("wrapped status line printed %q, the user's prints %q", got, want)
	}
}

// FR-SHELL-036 AC3: the status line in effect is the highest level's; one that already runs the relay is left alone.
func TestClaudePlanStatusLineLevels(t *testing.T) {
	tree := makeFakeTree(t)
	tree.write(t, tree.userSettings(), `{"statusLine":{"type":"command","command":"echo user"}}`)
	tree.write(t, filepath.Join(tree.project, ".claude", "settings.json"), `{"statusLine":{"type":"command","command":"echo project"}}`)
	_, gen, _ := planOf(t, tree.ctx())
	if gen.StatusLine["command"] != molten.StatusLineRelayCommand("echo project") {
		t.Fatalf("project level must win: %v", gen.StatusLine)
	}
	tree.write(t, filepath.Join(tree.project, ".claude", "settings.local.json"), `{"statusLine":{"type":"command","command":"`+strings.ReplaceAll(molten.StatusLineRelayCommand("echo mine"), `"`, `\"`)+`"}}`)
	plan, gen, _ := planOf(t, tree.ctx())
	if gen.StatusLine != nil || !slices.Contains(itemKinds(plan.Skipped), molten.IntegrationStatusLine) {
		t.Fatalf("a relay already in place must be left alone: %v %+v", gen.StatusLine, plan.Skipped)
	}
	_, gen, _ = planOf(t, tree.ctx("--setting-sources", "user"))
	if gen.StatusLine["command"] != molten.StatusLineRelayCommand("echo user") {
		t.Fatalf("--setting-sources user reads the user's only: %v", gen.StatusLine)
	}
	_, gen, _ = planOf(t, tree.ctx("--restricted"))
	if gen.StatusLine["command"] != molten.StatusLineRelayCommand("") {
		t.Fatalf("--restricted ignores the files: %v", gen.StatusLine)
	}
}

// FR-SHELL-036 AC4: an event the user already wired to MoltenTerm (a #221 paste, or a variant) is left to theirs.
func TestClaudePlanSkipsUserHooks(t *testing.T) {
	tree := makeFakeTree(t)
	tree.write(t, tree.userSettings(), `{"hooks":{
		"Stop":[{"hooks":[{"type":"command","command":"molten agent state done --agent claude"}]}],
		"PostToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"./my-own-hook.sh"}]}],
		"SessionStart":[{"hooks":[{"type":"command","command":"molten agent session --stdin"}]}]}}`)
	plan, gen, _ := planOf(t, tree.ctx())
	if _, ok := gen.Hooks["Stop"]; ok {
		t.Fatalf("Stop is the user's: %v", gen.Hooks["Stop"])
	}
	if _, ok := gen.Hooks["SessionStart"]; ok {
		t.Fatalf("SessionStart is the user's")
	}
	if len(hookCommands(gen, "PostToolUse")) != 1 || len(hookCommands(gen, "UserPromptSubmit")) != 1 {
		t.Fatalf("the user's own hook does not replace MoltenTerm's: %v", gen.Hooks)
	}
	skipped := map[string]string{}
	for _, it := range plan.Skipped {
		skipped[it.Kind] = it.Name + ": " + it.Reason
	}
	if !strings.Contains(skipped[molten.IntegrationStateHooks], "Stop") || !strings.Contains(skipped[molten.IntegrationStateHooks], "~/.claude/settings.json") {
		t.Fatalf("skipped %v", skipped)
	}
	if _, ok := skipped[molten.IntegrationSession]; !ok {
		t.Fatalf("skipped %v", skipped)
	}
}

func TestClaudePlanStepsAsideOrLeavesOut(t *testing.T) {
	tree := makeFakeTree(t)
	tree.write(t, tree.userSettings(), `{"disableAllHooks": true}`)
	plan, _, _ := planOf(t, tree.ctx())
	if plan.StepAside == "" || len(plan.Files) != 0 {
		t.Fatalf("disableAllHooks: %+v", plan)
	}
	tree.write(t, filepath.Join(tree.project, ".claude", "settings.local.json"), `{"disableAllHooks": false}`)
	if plan, _, _ := planOf(t, tree.ctx()); plan.StepAside != "" {
		t.Fatalf("a higher level turned hooks back on: %+v", plan)
	}
	os.Remove(filepath.Join(tree.project, ".claude", "settings.local.json"))
	os.Remove(tree.userSettings())

	tree.write(t, tree.managed, `{"statusLine":{"type":"command","command":"corp"},"allowManagedHooksOnly":true}`)
	plan, gen, _ := planOf(t, tree.ctx())
	if len(plan.Files) != 0 || gen.StatusLine != nil {
		t.Fatalf("managed status line and hooks only: %+v", plan)
	}
	if got := itemKinds(plan.Skipped); !slices.Equal(got, []string{molten.IntegrationStateHooks, molten.IntegrationSession, molten.IntegrationStatusLine}) {
		t.Fatalf("skipped %v", got)
	}
	os.Remove(tree.managed)

	tree.write(t, tree.userSettings(), `{ "statusLine": { "type": "command", "command": "echo x" }, // a comment`)
	plan, gen, _ = planOf(t, tree.ctx())
	if gen.StatusLine != nil || !slices.Contains(itemKinds(plan.Skipped), molten.IntegrationStatusLine) {
		t.Fatalf("an unreadable file may hold the status line: %v", gen.StatusLine)
	}
	if len(hookCommands(gen, "Stop")) != 1 {
		t.Fatalf("hooks still added: %v", gen.Hooks)
	}
}

// DS-SHELL-047: the user's own --settings is folded in: their keys and hooks kept, their status line wrapped, their
// flag replaced by the generated file.
func TestClaudePlanUserSettingsFlag(t *testing.T) {
	tree := makeFakeTree(t)
	theirs := filepath.Join(tree.project, "mine.json")
	tree.write(t, theirs, `{"model":"sonnet","hooks":{"Stop":[{"hooks":[{"type":"command","command":"./log.sh"}]}]},"statusLine":{"type":"command","command":"echo flag"}}`)
	plan, gen, raw := planOf(t, tree.ctx("--model", "opus", "--settings", "mine.json", "-p", "x"))
	if string(raw["model"]) != `"sonnet"` {
		t.Fatalf("their keys: %s", raw["model"])
	}
	if got := hookCommands(gen, "Stop"); len(got) != 2 || got[0] != "./log.sh" {
		t.Fatalf("their hooks first, then MoltenTerm's: %q", got)
	}
	if gen.StatusLine["command"] != molten.StatusLineRelayCommand("echo flag") {
		t.Fatalf("their status line wrapped: %v", gen.StatusLine)
	}
	if args := plan.MakeArgs([]string{"/g.json"}); !slices.Equal(args, []string{"--settings", "/g.json", "--model", "opus", "-p", "x"}) {
		t.Fatalf("args %q", args)
	}
	_, gen, _ = planOf(t, tree.ctx(`--settings={"statusLine":{"type":"command","command":"echo inline"}}`))
	if gen.StatusLine["command"] != molten.StatusLineRelayCommand("echo inline") {
		t.Fatalf("inline: %v", gen.StatusLine)
	}
	if _, err := (claudeAdapter{}).Plan(tree.ctx("--settings", "missing.json")); err == nil {
		t.Fatalf("an unreadable --settings must stop the plan")
	}
	if _, err := (claudeAdapter{}).Plan(tree.ctx("--settings", "[1]")); err == nil {
		t.Fatalf("a --settings that is not an object must stop the plan")
	}
	args := parseClaudeArgs([]string{"-p", "--", "--settings", "x"})
	if args.hasSetting || !slices.Equal(args.rest, []string{"-p", "--", "--settings", "x"}) {
		t.Fatalf("after --, nothing is an option: %+v", args)
	}
}

func hashTree(t *testing.T, root string) map[string]string {
	t.Helper()
	rtn := map[string]string{}
	filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		data, _ := os.ReadFile(path)
		sum := sha256.Sum256(data)
		info, _ := d.Info()
		rtn[path] = hex.EncodeToString(sum[:]) + info.ModTime().String()
		return nil
	})
	return rtn
}

// FR-SHELL-036 AC5, NFR-SHELL-019: planning and writing the run's file leave every user file as it was.
func TestClaudePlanWritesNothingOfTheUsers(t *testing.T) {
	tree := makeFakeTree(t)
	tree.write(t, tree.userSettings(), `{"statusLine":{"type":"command","command":"echo a"},"hooks":{}}`)
	tree.write(t, filepath.Join(tree.home, ".claude.json"), `{"mcpServers":{}}`)
	tree.write(t, filepath.Join(tree.project, ".mcp.json"), `{"mcpServers":{}}`)
	tree.write(t, filepath.Join(tree.project, ".claude", "settings.json"), `{}`)
	before := hashTree(t, tree.home)
	dataDir := t.TempDir()
	for i := 0; i < 3; i++ {
		plan, _, _ := planOf(t, tree.ctx())
		if _, err := WriteLaunchFile(LaunchDir(dataDir), plan.Files[0].Prefix, plan.Files[0].Data, time.Now()); err != nil {
			t.Fatal(err)
		}
	}
	after := hashTree(t, tree.home)
	if len(before) != len(after) {
		t.Fatalf("files added or removed: %v -> %v", before, after)
	}
	for path, h := range before {
		if after[path] != h {
			t.Fatalf("%s changed", path)
		}
	}
	entries, _ := os.ReadDir(LaunchDir(dataDir))
	if len(entries) != 1 {
		t.Fatalf("one content-addressed file, got %d", len(entries))
	}
}

func TestLauncherNamesMatchShellutil(t *testing.T) {
	if !slices.Equal(LauncherNames(), shellutil.AgentLauncherNames) {
		t.Fatalf("adapters %v, installed launchers %v", LauncherNames(), shellutil.AgentLauncherNames)
	}
	if AdapterForProgram("claude") == nil || AdapterForProgram("wsh") != nil || FindAdapter("gemini") != nil {
		t.Fatalf("registry")
	}
}

// NFR-SHELL-020: planning reads the settings files and builds the file; the launcher's budget is 50 ms at p95.
func BenchmarkClaudePlan(b *testing.B) {
	root := b.TempDir()
	tree := fakeTree{home: filepath.Join(root, "home"), managed: filepath.Join(root, "managed.json")}
	tree.project = filepath.Join(tree.home, "src", "app")
	os.MkdirAll(filepath.Join(tree.project, ".git"), 0755)
	os.MkdirAll(filepath.Join(tree.home, ".claude"), 0755)
	os.WriteFile(tree.userSettings(), []byte(`{"statusLine":{"type":"command","command":"echo a"},"hooks":{"Stop":[{"hooks":[{"type":"command","command":"x"}]}]}}`), 0644)
	dir := filepath.Join(root, "launch")
	for i := 0; i < b.N; i++ {
		plan, err := claudeAdapter{}.Plan(tree.ctx("-p", "x"))
		if err != nil {
			b.Fatal(err)
		}
		if _, err := WriteLaunchFile(dir, plan.Files[0].Prefix, plan.Files[0].Data, time.Now()); err != nil {
			b.Fatal(err)
		}
		SweepLaunchFiles(dir, time.Now())
	}
}

func jsonString(s string) string {
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.Encode(s)
	return strings.TrimSuffix(b.String(), "\n")
}
