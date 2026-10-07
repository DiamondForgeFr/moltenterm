// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentlaunch

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

const testMolten = "/data/bin/molten"

func (f fakeTree) browserCtx(args ...string) LaunchContext {
	ctx := f.ctx(args...)
	ctx.MoltenPath = testMolten
	return ctx
}

func fileOf(plan LaunchPlan, kind string) *PlannedFile {
	for i := range plan.Files {
		if plan.Files[i].Kind == kind {
			return &plan.Files[i]
		}
	}
	return nil
}

func itemOf(items []molten.IntegrationItem, kind string) *molten.IntegrationItem {
	for i := range items {
		if items[i].Kind == kind {
			return &items[i]
		}
	}
	return nil
}

// fakePaths gives each planned file a path named after its kind, for MakeArgs.
func fakePaths(plan LaunchPlan) []string {
	var rtn []string
	for _, f := range plan.Files {
		rtn = append(rtn, "/gen/"+f.Kind+".json")
	}
	return rtn
}

// browserSkipped returns the reason the browser was left out, failing when it was added.
func browserSkipped(t *testing.T, plan LaunchPlan) string {
	t.Helper()
	if fileOf(plan, FileMcpConfig) != nil || itemOf(plan.Added, molten.IntegrationBrowser) != nil {
		t.Fatalf("the browser must not be added: %+v", plan)
	}
	item := itemOf(plan.Skipped, molten.IntegrationBrowser)
	if item == nil {
		t.Fatalf("the report must say why the browser was left out: %+v", plan.Skipped)
	}
	return item.Reason
}

func browserAdded(t *testing.T, plan LaunchPlan) {
	t.Helper()
	if fileOf(plan, FileMcpConfig) == nil || itemOf(plan.Added, molten.IntegrationBrowser) == nil {
		t.Fatalf("the browser must be added: %+v", plan)
	}
}

// FR-SHELL-037 AC1: the run gets one stdio server, molten-browser, running MoltenTerm's molten by its absolute path,
// passed first as --mcp-config=<file> (one value: a prompt after it stays the prompt), before the generated settings.
func TestClaudePlanAddsBrowser(t *testing.T) {
	tree := makeFakeTree(t)
	plan, _, _ := planOf(t, tree.browserCtx("fix it"))
	browserAdded(t, plan)
	if plan.Files[0].Kind != FileSettings || plan.Files[1].Kind != FileMcpConfig || plan.Files[1].Prefix != claudeMcpFilePrefix {
		t.Fatalf("files %+v", plan.Files)
	}
	var doc struct {
		McpServers map[string]struct {
			Type    string   `json:"type"`
			Command string   `json:"command"`
			Args    []string `json:"args"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal(plan.Files[1].Data, &doc); err != nil {
		t.Fatal(err)
	}
	server, ok := doc.McpServers["molten-browser"]
	if len(doc.McpServers) != 1 || !ok || server.Type != "stdio" || server.Command != testMolten || !slices.Equal(server.Args, []string{"mcp", "browser"}) {
		t.Fatalf("mcp config %s", plan.Files[1].Data)
	}
	if got := plan.MakeArgs(fakePaths(plan)); !slices.Equal(got, []string{"--mcp-config=/gen/mcpconfig.json", "--settings", "/gen/settings.json", "fix it"}) {
		t.Fatalf("args %q", got)
	}

	tree.write(t, filepath.Join(tree.project, "s.json"), `{}`)
	plan, _, _ = planOf(t, tree.browserCtx("--allowedTools", "Bash", "--settings", "s.json", "fix it"))
	if got := plan.MakeArgs(fakePaths(plan)); !slices.Equal(got, []string{"--mcp-config=/gen/mcpconfig.json", "--allowedTools", "Bash", "--settings", "/gen/settings.json", "fix it"}) {
		t.Fatalf("args with a variadic option and the user's --settings %q", got)
	}
}

// With nothing else to add (managed hooks only, managed status line), the browser alone is added and the user's own
// --settings stays where it was.
func TestClaudePlanBrowserOnly(t *testing.T) {
	tree := makeFakeTree(t)
	tree.write(t, tree.managed, `{"statusLine":{"type":"command","command":"corp"},"allowManagedHooksOnly":true}`)
	tree.write(t, filepath.Join(tree.project, "mine.json"), `{"model":"x"}`)
	plan, _, _ := planOf(t, tree.browserCtx("--settings", "mine.json", "-p", "hi"))
	browserAdded(t, plan)
	if len(plan.Files) != 1 {
		t.Fatalf("files %+v", plan.Files)
	}
	if got := plan.MakeArgs(fakePaths(plan)); !slices.Equal(got, []string{"--mcp-config=/gen/mcpconfig.json", "--settings", "mine.json", "-p", "hi"}) {
		t.Fatalf("args %q", got)
	}
	plan, _, _ = planOf(t, tree.ctx("-p", "hi"))
	if len(plan.Files) != 0 || plan.MakeArgs != nil {
		t.Fatalf("nothing to add: the arguments run unchanged: %+v", plan)
	}
}

// FR-SHELL-037 AC4 and AC6: --strict-mcp-config means the user chose the servers; without molten nothing is offered.
func TestClaudePlanBrowserStrictOrMissing(t *testing.T) {
	tree := makeFakeTree(t)
	for _, args := range [][]string{{"--strict-mcp-config", "--mcp-config", "other.json"}, {"-p", "x", "--strict-mcp-config"}} {
		tree.write(t, filepath.Join(tree.project, "other.json"), `{"mcpServers":{"mine":{"command":"x"}}}`)
		plan, _, _ := planOf(t, tree.browserCtx(args...))
		if reason := browserSkipped(t, plan); !strings.Contains(reason, "--strict-mcp-config") {
			t.Fatalf("reason %q", reason)
		}
		if fileOf(plan, FileSettings) == nil {
			t.Fatalf("the rest of the integration is still added")
		}
		if got := plan.MakeArgs(fakePaths(plan)); got[0] != "--settings" || !slices.Equal(got[2:], args) {
			t.Fatalf("args %q", got)
		}
	}
	plan, _, _ := planOf(t, tree.browserCtx("--", "--strict-mcp-config"))
	browserAdded(t, plan)
	plan, _, _ = planOf(t, tree.ctx())
	if reason := browserSkipped(t, plan); !strings.Contains(reason, "not installed") {
		t.Fatalf("reason %q", reason)
	}
}

func TestParseClaudeMcpArgs(t *testing.T) {
	cases := []struct {
		args    []string
		configs []string
		strict  bool
	}{
		{nil, nil, false},
		{[]string{"--mcp-config", "a.json", "b.json", "-p", "x"}, []string{"a.json", "b.json"}, false},
		{[]string{"--mcp-config=a.json", "prompt"}, []string{"a.json"}, false},
		{[]string{"--mcp-config", "a.json", "--mcp-config", "{}", "--strict-mcp-config"}, []string{"a.json", "{}"}, true},
		{[]string{"--", "--mcp-config", "a.json", "--strict-mcp-config"}, nil, false},
	}
	for _, c := range cases {
		got := parseClaudeMcpArgs(c.args)
		if !slices.Equal(got.configs, c.configs) || got.strict != c.strict {
			t.Errorf("%q: %q %v", c.args, got.configs, got.strict)
		}
	}
}

// FR-SHELL-037 AC3: a molten-browser of the user's, in any scope or in their own --mcp-config, is theirs: nothing is
// added. Other servers of theirs do not matter; their --mcp-config still applies next to the generated one.
func TestClaudePlanBrowserAlreadyYours(t *testing.T) {
	mine := `{"mcpServers":{"molten-browser":{"command":"molten","args":["mcp","browser"]}}}`
	other := `{"mcpServers":{"github":{"command":"gh-mcp"}}}`

	tree := makeFakeTree(t)
	tree.write(t, filepath.Join(tree.project, "mine.json"), mine)
	tree.write(t, filepath.Join(tree.project, "other.json"), other)
	for _, args := range [][]string{{"--mcp-config", "mine.json"}, {"--mcp-config=mine.json"}, {"--mcp-config", "other.json", mine}} {
		plan, _, _ := planOf(t, tree.browserCtx(args...))
		if reason := browserSkipped(t, plan); reason != "already yours, in your --mcp-config" {
			t.Fatalf("%q: reason %q", args, reason)
		}
	}
	plan, _, _ := planOf(t, tree.browserCtx("--mcp-config", "other.json", "-p", "x"))
	browserAdded(t, plan)
	if got := plan.MakeArgs(fakePaths(plan)); !slices.Equal(got, []string{"--mcp-config=/gen/mcpconfig.json", "--settings", "/gen/settings.json", "--mcp-config", "other.json", "-p", "x"}) {
		t.Fatalf("args %q", got)
	}
	plan, _, _ = planOf(t, tree.browserCtx("--mcp-config", "missing.json"))
	if reason := browserSkipped(t, plan); !strings.Contains(reason, "could not be read") {
		t.Fatalf("reason %q", reason)
	}

	scopes := []struct {
		name  string
		path  string
		body  string
		where string
	}{
		{"user scope", ".claude.json", mine, "~/.claude.json"},
		{"local scope", ".claude.json", `{"projects":{"PROJECT":` + mine + `}}`, "~/.claude.json (this project)"},
		{"local scope of a parent", ".claude.json", `{"projects":{"HOME/src":` + mine + `}}`, "~/.claude.json (this project)"},
		{"project scope", "src/app/.mcp.json", mine, "~/src/app/.mcp.json"},
		{"project scope of a parent", ".mcp.json", mine, "~/.mcp.json"},
	}
	for _, s := range scopes {
		tree := makeFakeTree(t)
		body := strings.ReplaceAll(strings.ReplaceAll(s.body, "PROJECT", jsonPath(tree.project)), "HOME", jsonPath(tree.home))
		tree.write(t, filepath.Join(tree.home, s.path), body)
		plan, _, _ := planOf(t, tree.browserCtx())
		if reason := browserSkipped(t, plan); reason != "already yours, in "+s.where {
			t.Errorf("%s: reason %q", s.name, reason)
		}
	}

	tree = makeFakeTree(t)
	tree.write(t, filepath.Join(tree.home, ".claude.json"), `{"mcpServers":`+other[len(`{"mcpServers":`):len(other)-1]+`,"projects":{"/elsewhere":`+mine+`},"history":["molten-browser"]}`)
	tree.write(t, filepath.Join(tree.project, ".mcp.json"), other)
	plan, _, _ = planOf(t, tree.browserCtx())
	browserAdded(t, plan)

	tree = makeFakeTree(t)
	configDir := filepath.Join(tree.home, "alt")
	tree.write(t, filepath.Join(configDir, ".claude.json"), mine)
	ctx := tree.browserCtx()
	ctx.Env.Getenv = func(name string) string {
		if name == "CLAUDE_CONFIG_DIR" {
			return configDir
		}
		return ""
	}
	plan, _ = claudeAdapter{}.Plan(ctx)
	if reason := browserSkipped(t, plan); reason != "already yours, in ~/alt/.claude.json" {
		t.Fatalf("CLAUDE_CONFIG_DIR: reason %q", reason)
	}
}

func jsonPath(p string) string {
	return strings.Trim(jsonString(p), `"`)
}

// A doubt adds nothing: an unreadable file that may name molten-browser, or the organization's managed MCP.
func TestClaudePlanBrowserDoubts(t *testing.T) {
	tree := makeFakeTree(t)
	tree.write(t, filepath.Join(tree.home, ".claude.json"), `{"mcpServers":{"molten-browser":{}}`)
	plan, _, _ := planOf(t, tree.browserCtx())
	if reason := browserSkipped(t, plan); reason != "~/.claude.json could not be read" {
		t.Fatalf("reason %q", reason)
	}
	tree.write(t, filepath.Join(tree.home, ".claude.json"), `{"mcpServers":`)
	plan, _, _ = planOf(t, tree.browserCtx())
	browserAdded(t, plan)

	tree.write(t, filepath.Join(tree.project, ".mcp.json"), `{"mcpServers":{"molten-browser":{}},}`)
	plan, _, _ = planOf(t, tree.browserCtx())
	if reason := browserSkipped(t, plan); !strings.Contains(reason, ".mcp.json could not be read") {
		t.Fatalf("reason %q", reason)
	}
	os.Remove(filepath.Join(tree.project, ".mcp.json"))

	tree.write(t, filepath.Join(filepath.Dir(tree.managed), "managed-mcp.json"), `{"mcpServers":{}}`)
	plan, _, _ = planOf(t, tree.browserCtx())
	if reason := browserSkipped(t, plan); !strings.Contains(reason, "managed MCP configuration") {
		t.Fatalf("reason %q", reason)
	}
	os.Remove(filepath.Join(filepath.Dir(tree.managed), "managed-mcp.json"))

	tree.write(t, tree.managed, `{"managedMcpServers":[{"name":"molten-browser","command":"x"}]}`)
	plan, _, _ = planOf(t, tree.browserCtx())
	if reason := browserSkipped(t, plan); !strings.Contains(reason, "organization") {
		t.Fatalf("reason %q", reason)
	}
}

// FR-SHELL-037 AC6: molten is MoltenTerm's own, by its absolute path, and only when it is installed.
func TestMoltenPath(t *testing.T) {
	data := t.TempDir()
	if MoltenPath(data) != "" || MoltenPath("") != "" {
		t.Fatalf("no molten installed")
	}
	if runtime.GOOS == "windows" {
		return
	}
	writeExec(t, filepath.Join(data, "bin", "wsh"))
	os.Symlink("wsh", filepath.Join(data, "bin", "molten"))
	if got := MoltenPath(data); got != filepath.Join(data, "bin", "molten") {
		t.Fatalf("molten path %q", got)
	}
}
