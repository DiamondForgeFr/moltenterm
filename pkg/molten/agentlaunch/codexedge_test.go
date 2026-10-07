// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentlaunch

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// --profile wins over -c profile; quoted and spaced -c keys are the user's.
func TestCodexPlanProfileAndKeys(t *testing.T) {
	tree := makeFakeTree(t)
	tree.write(t, tree.codexConfig(), "[profiles.work]\nnotify = [\"work-notify\"]\n[profiles.home]\nmodel = \"o3\"\n")
	if _, args := codexPlan(t, tree.codexCtx("-p", "home", "-c", "profile=work")); len(args) != 10 {
		t.Fatalf("--profile home wins over -c profile=work: the wrapper is added: %q", args)
	}
	if _, args := codexPlan(t, tree.codexCtx("-p", "work", "-c", "profile=home")); len(args) != 8 {
		t.Fatalf("--profile work wins over -c profile=home: notify left alone: %q", args)
	}
	tree.write(t, tree.codexConfig(), "")
	for _, flag := range []string{`mcp_servers.'molten-browser'.command="x"`, `mcp_servers . "molten-browser" . args=[]`} {
		_, args := codexPlan(t, tree.codexCtx("-c", flag))
		if strings.Contains(strings.Join(args[:len(args)-2], " "), "molten-browser") {
			t.Fatalf("-c %s is the user's server: %q", flag, args)
		}
	}
	_, args := codexPlan(t, tree.codexCtx("-c", `"notify" = []`))
	if slices.ContainsFunc(args[:len(args)-2], func(a string) bool { return strings.HasPrefix(a, "notify=") }) {
		t.Fatalf("a quoted notify key is the user's: %q", args)
	}
}

// A managed notify or molten-browser (above -c), custom project root markers and a linked project file are doubts.
func TestCodexPlanManagedAndProject(t *testing.T) {
	tree := makeFakeTree(t)
	ctx := tree.codexCtx()
	managed := filepath.Join(filepath.Dir(ctx.CodexSystemConfig), "managed_config.toml")
	tree.write(t, managed, "notify = [\"org-notify\"]\n")
	if plan, args := codexPlan(t, ctx); len(args) != 4 || !strings.Contains(strings.Join(itemNames(plan.Skipped, molten.IntegrationNotify), ""), "organization") {
		t.Fatalf("a managed notify applies above -c: left alone: %q %v", args, plan.Skipped)
	}
	tree.write(t, managed, "[mcp_servers.molten-browser]\ncommand = \"x\"\n")
	if _, args := codexPlan(t, ctx); len(args) != 2 {
		t.Fatalf("a managed molten-browser: no browser added: %q", args)
	}
	os.Remove(managed)

	tree.write(t, tree.codexConfig(), "project_root_markers = [\".hg\"]\n")
	if _, args := codexPlan(t, tree.codexCtx()); len(args) != 4 {
		t.Fatalf("custom project root markers: notify left alone: %q", args)
	}

	tree.write(t, tree.codexConfig(), "")
	secret := filepath.Join(tree.home, "secret.toml")
	tree.write(t, secret, "notify = []\n")
	os.MkdirAll(filepath.Join(tree.project, ".codex"), 0755)
	if err := os.Symlink(secret, filepath.Join(tree.project, ".codex", "config.toml")); err != nil {
		t.Fatal(err)
	}
	if plan, args := codexPlan(t, tree.codexCtx("x")); plan.StepAside == "" || !slices.Equal(args, []string{"x"}) {
		t.Fatalf("a linked project file is never opened: nothing added: %q %q", plan.StepAside, args)
	}
}

// The #221 snippet already reports done: the wrapper only links the session. The report never shows the user's
// notify arguments, which may hold a token.
func TestCodexPlanSnippetAndShownArgs(t *testing.T) {
	tree := makeFakeTree(t)
	tree.write(t, tree.codexConfig(), `notify = ["sh", "-c", "[ -n \"$WAVETERM_BLOCKID\" ] && molten agent state done --agent codex || true"]`+"\n")
	plan, args := codexPlan(t, tree.codexCtx())
	notify := overridesOf(t, args, 6)["notify"].([]any)
	if !slices.Equal(notify[:7], []any{codexTestMolten, "agent", "notify", "--agent", "codex", NotifySessionOnlyFlag, "--"}) || notify[7] != "sh" {
		t.Fatalf("the #221 snippet: the wrapper only links the session: %q", notify)
	}
	if len(itemNames(plan.Added, molten.IntegrationNotify)) != 0 || len(itemNames(plan.Added, molten.IntegrationSession)) != 1 {
		t.Fatalf("the #221 snippet: added %v", plan.Added)
	}

	tree.write(t, tree.codexConfig(), "notify = [\"/bin/notify\", \"https://hooks.example/T0K3N\"]\n")
	plan, args = codexPlan(t, tree.codexCtx())
	shown := strings.Join(plan.ShownArgs, " ")
	if strings.Contains(shown, "T0K3N") || !strings.Contains(shown, `"/bin/notify","<1 more of your arguments>"]`) || !strings.Contains(args[5], "T0K3N") {
		t.Fatalf("the report never shows the user's notify arguments: %q", shown)
	}
	if len(plan.ShownArgs) != 6 {
		t.Fatalf("shown args: %q", plan.ShownArgs)
	}
}
