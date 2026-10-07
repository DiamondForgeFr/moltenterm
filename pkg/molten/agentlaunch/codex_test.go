// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentlaunch

import (
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"syscall"
	"testing"

	"github.com/BurntSushi/toml"
	"github.com/wavetermdev/waveterm/pkg/molten"
)

const codexTestMolten = "/data dir/bin/molten"

func (f fakeTree) codexCtx(args ...string) LaunchContext {
	ctx := f.ctx(args...)
	ctx.MoltenPath = codexTestMolten
	ctx.CodexSystemConfig = filepath.Join(filepath.Dir(f.home), "etc-codex", "config.toml")
	return ctx
}

func (f fakeTree) codexConfig() string { return filepath.Join(f.home, ".codex", "config.toml") }

func codexPlan(t *testing.T, ctx LaunchContext) (LaunchPlan, []string) {
	t.Helper()
	plan, err := codexAdapter{}.Plan(ctx)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if len(plan.Files) != 0 {
		t.Fatalf("the codex plan writes no file: %v", plan.Files)
	}
	if plan.MakeArgs == nil {
		return plan, ctx.Args
	}
	return plan, plan.MakeArgs(nil)
}

// overridesOf decodes every -c of the generated arguments as Codex does: `key = <TOML value>`.
func overridesOf(t *testing.T, args []string, n int) map[string]any {
	t.Helper()
	rtn := map[string]any{}
	for i := 0; i < n; i += 2 {
		if args[i] != "-c" {
			t.Fatalf("argument %d is %q, want -c: %q", i, args[i], args)
		}
		key, value, ok := strings.Cut(args[i+1], "=")
		if !ok {
			t.Fatalf("no = in %q", args[i+1])
		}
		var doc map[string]any
		if _, err := toml.Decode("v = "+value, &doc); err != nil {
			t.Fatalf("%s is not valid TOML: %v", args[i+1], err)
		}
		rtn[key] = doc["v"]
	}
	return rtn
}

func itemNames(items []molten.IntegrationItem, kind string) []string {
	var rtn []string
	for _, it := range items {
		if it.Kind == kind {
			rtn = append(rtn, it.Name+"|"+it.Reason)
		}
	}
	return rtn
}

func wantNotify(user ...string) []any {
	rtn := []any{codexTestMolten, "agent", "notify", "--agent", "codex", "--"}
	for _, u := range user {
		rtn = append(rtn, u)
	}
	return rtn
}

// AC5: the commands that start no session in this pane run the real binary with nothing added; a prompt, exec,
// resume, fork and review are integrated.
func TestCodexPassThrough(t *testing.T) {
	pass := [][]string{
		{"--version"}, {"-V"}, {"--help"}, {"-h"}, {"login"}, {"login", "status"}, {"logout"}, {"mcp", "list"},
		{"mcp-server"}, {"app-server"}, {"features", "list"}, {"completion", "zsh"}, {"apply", "x"}, {"cloud"},
		{"-c", "model=o3", "mcp", "list"}, {"--remote", "ws://h", "fix it"}, {"exec", "--help"}, {"-m", "o3", "login"},
		{"--config=x=1", "logout"},
	}
	for _, args := range pass {
		if !(codexAdapter{}).PassThrough(args) {
			t.Errorf("%q should pass through", args)
		}
	}
	integrated := [][]string{
		nil, {"fix the tests"}, {"exec", "fix it"}, {"e", "x"}, {"resume", "--last"}, {"fork"}, {"review"},
		{"-m", "login"}, {"-c", "mcp=1", "fix"}, {"--", "--help"}, {"--", "login"}, {"-i", "a.png", "b.png", "describe"},
		{"-p", "mcp", "x"},
	}
	for _, args := range integrated {
		if (codexAdapter{}).PassThrough(args) {
			t.Errorf("%q should be integrated", args)
		}
	}
	inPane := func(name string) string {
		return map[string]string{"WAVETERM_BLOCKID": "b", "WAVETERM_JWT": "j"}[name]
	}
	if got := StepAsideReason(inPane, []string{"login"}, codexAdapter{}); got != StepAsidePassThrough {
		t.Fatalf("step aside for codex login: %q", got)
	}
}

// AC1: stock Codex, no notify: the browser server and the wrapper with no user program, before the user's arguments,
// which stay unchanged; no hook is added and the report says why.
func TestCodexPlanStock(t *testing.T) {
	tree := makeFakeTree(t)
	plan, args := codexPlan(t, tree.codexCtx("--model", "o3", "fix the tests"))
	if !slices.Equal(args[len(args)-3:], []string{"--model", "o3", "fix the tests"}) || len(args) != 9 {
		t.Fatalf("user args must come last, unchanged: %q", args)
	}
	got := overridesOf(t, args, 6)
	if got["mcp_servers.molten-browser.command"] != codexTestMolten {
		t.Fatalf("browser command: %v", got)
	}
	if !slices.Equal(got["mcp_servers.molten-browser.args"].([]any), []any{"mcp", "browser"}) {
		t.Fatalf("browser args: %v", got)
	}
	if !slices.Equal(got["notify"].([]any), wantNotify()) {
		t.Fatalf("notify: %v", got["notify"])
	}
	if names := itemNames(plan.Added, molten.IntegrationNotify); len(names) != 1 || names[0] != codexNotifyItemName+"|" {
		t.Fatalf("added notify: %v", plan.Added)
	}
	if len(itemNames(plan.Added, molten.IntegrationSession)) != 1 || len(itemNames(plan.Added, molten.IntegrationBrowser)) != 1 {
		t.Fatalf("added: %v", plan.Added)
	}
	if hooks := itemNames(plan.Skipped, molten.IntegrationStateHooks); len(hooks) != 1 || !strings.Contains(hooks[0], "trust") {
		t.Fatalf("hooks must be reported as left out (AC8): %v", plan.Skipped)
	}
	for _, a := range args {
		if strings.Contains(a, "hooks") || strings.Contains(a, "bypass") || a == "-p" || a == "--profile" {
			t.Fatalf("no hook, trust bypass or profile may be added: %q", args)
		}
	}
}

// AC2: the user's notify (user config over the system one) is wrapped, its arguments kept byte for byte.
func TestCodexPlanWrapsUserNotify(t *testing.T) {
	tree := makeFakeTree(t)
	ctx := tree.codexCtx()
	tree.write(t, ctx.CodexSystemConfig, `notify = ["system-notify"]`+"\n")
	_, args := codexPlan(t, ctx)
	if got := overridesOf(t, args, 6)["notify"]; !slices.Equal(got.([]any), wantNotify("system-notify")) {
		t.Fatalf("system notify: %v", got)
	}
	tricky := "a \"quoted\" \\ back\tslash\x7f é 'single'"
	tree.write(t, tree.codexConfig(), "model = \"o3\"\n# notify = [\"commented\"]\nnotify = [\n  \"/Users/me/bin/notify.sh\", # the notifier\n  '--title', \"a \\\"quoted\\\" \\\\ back\\tslash\\u007f é 'single'\",\n]\n\n[tui]\nnotifications = true\n")
	plan, args := codexPlan(t, ctx)
	got := overridesOf(t, args, 6)["notify"]
	if !slices.Equal(got.([]any), wantNotify("/Users/me/bin/notify.sh", "--title", tricky)) {
		t.Fatalf("user notify: %q", got)
	}
	if names := itemNames(plan.Added, molten.IntegrationNotify); len(names) != 1 || names[0] != codexNotifyAroundItemName+"|" {
		t.Fatalf("added: %v", plan.Added)
	}
}

// AC7, AC3 and the doubts: the user's own -c notify, a profile or project notify, or a config that cannot be read
// leave notify alone; a molten-browser of the user's leaves the server out.
func TestCodexPlanSkips(t *testing.T) {
	tree := makeFakeTree(t)
	_, args := codexPlan(t, tree.codexCtx("-c", `notify=["/x/other.sh"]`, "fix"))
	if len(args) != 7 || args[0] != "-c" || !strings.HasPrefix(args[1], "mcp_servers.molten-browser.command=") || args[4] != "-c" || args[5] != `notify=["/x/other.sh"]` {
		t.Fatalf("user -c notify: only the browser is added (AC7): %q", args)
	}
	for _, flag := range [][]string{{"--config", "notify = []"}, {"-cnotify=[]"}, {"--config=notify=[]"}, {"-c=notify=[]"}} {
		_, args = codexPlan(t, tree.codexCtx(flag...))
		if slices.ContainsFunc(args[:len(args)-len(flag)], func(a string) bool { return strings.HasPrefix(a, "notify=") }) {
			t.Fatalf("%q: notify must be left alone: %q", flag, args)
		}
	}

	tree.write(t, tree.codexConfig(), "profile = \"work\"\n[profiles.work]\nnotify = [\"work-notify\"]\n[profiles.home]\nmodel = \"o3\"\n")
	plan, args := codexPlan(t, tree.codexCtx())
	if len(args) != 4 || len(itemNames(plan.Skipped, molten.IntegrationNotify)) != 1 {
		t.Fatalf("a profile's notify: notify left alone: %q %v", args, plan.Skipped)
	}
	_, args = codexPlan(t, tree.codexCtx("-p", "home"))
	if len(args) != 8 {
		t.Fatalf("-p home has no notify of its own: the wrapper is added: %q", args)
	}
	_, args = codexPlan(t, tree.codexCtx("-c", "profile=home"))
	if len(args) != 8 {
		t.Fatalf("-c profile=home: the wrapper is added: %q", args)
	}
	_, args = codexPlan(t, tree.codexCtx("--profile=work"))
	if len(args) != 5 {
		t.Fatalf("--profile=work: notify left alone: %q", args)
	}

	tree.write(t, tree.codexConfig(), "notify = [\"mine\"]\n")
	tree.write(t, filepath.Join(tree.project, ".codex", "config.toml"), "notify = [\"project-notify\"]\n")
	plan, args = codexPlan(t, tree.codexCtx())
	if len(args) != 4 || !strings.Contains(strings.Join(itemNames(plan.Skipped, molten.IntegrationNotify), ""), ".codex/config.toml") {
		t.Fatalf("a project notify: notify left alone: %q %v", args, plan.Skipped)
	}
	os.Remove(filepath.Join(tree.project, ".codex", "config.toml"))

	tree.write(t, tree.codexConfig(), "notify = \"not-a-list\"\n")
	_, args = codexPlan(t, tree.codexCtx())
	if len(args) != 4 {
		t.Fatalf("a notify that is not a list: left alone: %q", args)
	}

	tree.write(t, tree.codexConfig(), "[mcp_servers.molten-browser]\ncommand = \"molten\"\nargs = [\"mcp\", \"browser\"]\n[mcp_servers.github]\ncommand = \"gh-mcp\"\n")
	plan, args = codexPlan(t, tree.codexCtx())
	if len(args) != 2 || !strings.HasPrefix(args[1], "notify=") || !strings.Contains(strings.Join(itemNames(plan.Skipped, molten.IntegrationBrowser), ""), "already yours") {
		t.Fatalf("the user's molten-browser wins (AC3): %q %v", args, plan.Skipped)
	}
	tree.write(t, tree.codexConfig(), "")
	for _, flag := range []string{"mcp_servers.molten-browser.command=x", `mcp_servers."molten-browser".command="x"`, "mcp_servers={}"} {
		_, args = codexPlan(t, tree.codexCtx("-c", flag))
		if strings.Contains(strings.Join(args[:len(args)-2], " "), "molten-browser") {
			t.Fatalf("-c %s: no browser added: %q", flag, args)
		}
	}
	tree.write(t, filepath.Join(tree.project, ".codex", "config.toml"), "[mcp_servers.molten-browser]\ncommand = \"x\"\n")
	_, args = codexPlan(t, tree.codexCtx())
	if len(args) != 2 {
		t.Fatalf("a project molten-browser: no browser added: %q", args)
	}
	os.Remove(filepath.Join(tree.project, ".codex", "config.toml"))

	ctx := tree.codexCtx("fix")
	ctx.MoltenPath = ""
	plan, args = codexPlan(t, ctx)
	if !slices.Equal(args, []string{"fix"}) || len(plan.Added) != 0 {
		t.Fatalf("no molten installed: nothing added: %q %v", args, plan.Added)
	}
}

// A config file that cannot be read is a doubt: nothing is added, and the run starts.
func TestCodexPlanUnreadableConfig(t *testing.T) {
	tree := makeFakeTree(t)
	tree.write(t, tree.codexConfig(), "notify = [\"unterminated\n")
	plan, args := codexPlan(t, tree.codexCtx("fix"))
	if plan.StepAside == "" || !slices.Equal(args, []string{"fix"}) {
		t.Fatalf("bad TOML: step aside: %q %q", plan.StepAside, args)
	}
	tree.write(t, tree.codexConfig(), strings.Repeat("#", maxSettingsBytes+1))
	if plan, _ := codexPlan(t, tree.codexCtx()); plan.StepAside == "" {
		t.Fatalf("oversized config: step aside")
	}
	if runtime.GOOS == "windows" {
		return
	}
	os.Remove(tree.codexConfig())
	if err := syscall.Mkfifo(tree.codexConfig(), 0644); err != nil {
		t.Fatal(err)
	}
	if plan, _ := codexPlan(t, tree.codexCtx()); plan.StepAside == "" {
		t.Fatalf("a FIFO config: step aside without blocking")
	}
}

// CODEX_HOME moves the user's config; the home folder's .codex is then a project folder like any other.
func TestCodexPlanCodexHome(t *testing.T) {
	tree := makeFakeTree(t)
	other := filepath.Join(filepath.Dir(tree.home), "codex-home")
	tree.write(t, filepath.Join(other, "config.toml"), "notify = [\"from-codex-home\"]\n")
	ctx := tree.codexCtx()
	ctx.Env.Getenv = func(name string) string {
		if name == "CODEX_HOME" {
			return other
		}
		return ""
	}
	_, args := codexPlan(t, ctx)
	if got := overridesOf(t, args, 6)["notify"]; !slices.Equal(got.([]any), wantNotify("from-codex-home")) {
		t.Fatalf("CODEX_HOME notify: %v", got)
	}
	// A session started in the home folder: ~/.codex/config.toml is the user's file, not a project one.
	tree.write(t, tree.codexConfig(), "notify = [\"home\"]\n")
	ctx = tree.codexCtx()
	ctx.Cwd = tree.home
	_, args = codexPlan(t, ctx)
	if got := overridesOf(t, args, 6)["notify"]; !slices.Equal(got.([]any), wantNotify("home")) {
		t.Fatalf("home folder session: %v", got)
	}
}

func TestTomlString(t *testing.T) {
	for _, s := range []string{"", "plain", `"`, `\`, "\x00\x01\x1f\x7f", "tab\there\nnew", "é ü 😀", "'single'", `A`, "\xff"} {
		var doc map[string]any
		if _, err := toml.Decode("v = "+tomlString(s), &doc); err != nil {
			t.Fatalf("%q -> %s: %v", s, tomlString(s), err)
		}
		want := strings.ToValidUTF8(s, "�")
		if doc["v"] != want {
			t.Fatalf("%q round trip gave %q", s, doc["v"])
		}
	}
}
