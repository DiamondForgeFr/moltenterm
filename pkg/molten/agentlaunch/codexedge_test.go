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

// codexNotifyArg is the run's -c notify value, "" for none.
func codexNotifyArg(args []string) string {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == codexConfigFlag && strings.HasPrefix(args[i+1], codexNotifyKey+"=") {
			return args[i+1]
		}
	}
	return ""
}

// TC-SHELL-038-11 (#990): -p <name> layers $CODEX_HOME/<name>.config.toml above config.toml (profile v2); its notify
// is chained inside the wrapper, never dropped. Quoted and spaced -c keys are the user's.
func TestCodexPlanProfileAndKeys(t *testing.T) {
	tree := makeFakeTree(t)
	codexHome := filepath.Dir(tree.codexConfig())
	tree.write(t, tree.codexConfig(), "notify = [\"mine\"]\n")
	tree.write(t, filepath.Join(codexHome, "work.config.toml"), "model = \"o3\"\nnotify = [\"work-notify\", \"--loud\"]\n")
	tree.write(t, filepath.Join(codexHome, "home.config.toml"), "model = \"o3\"\n")
	tree.write(t, filepath.Join(filepath.Dir(codexHome), "evil.config.toml"), "notify = [\"evil\"]\n")
	wrapped := func(user ...string) string {
		return codexNotifyKey + "=" + tomlArray(append(append([]string{codexTestMolten}, codexNotifyWrapper...), user...))
	}
	for _, tc := range []struct {
		flags []string
		want  string
	}{
		{nil, wrapped("mine")},
		{[]string{"-p", "work"}, wrapped("work-notify", "--loud")},
		{[]string{"--profile=work"}, wrapped("work-notify", "--loud")},
		{[]string{"-pwork"}, wrapped("work-notify", "--loud")},
		{[]string{"--profile", "work", "fix the tests"}, wrapped("work-notify", "--loud")},
		{[]string{"-p", "home"}, wrapped("mine")},
		{[]string{"-p", "absent"}, wrapped("mine")},
		{[]string{"-c", "profile=work"}, wrapped("mine")},
		{[]string{"-p", "../evil"}, wrapped("mine")},
	} {
		plan, args := codexPlan(t, tree.codexCtx(tc.flags...))
		if got := codexNotifyArg(args); got != tc.want {
			t.Fatalf("%q: notify %s, want %s", tc.flags, got, tc.want)
		}
		if len(itemNames(plan.Skipped, molten.IntegrationNotify)) != 0 {
			t.Fatalf("%q: notify is not skipped: %v", tc.flags, plan.Skipped)
		}
	}
	tree.write(t, filepath.Join(codexHome, "work.config.toml"), "notify = \"not-a-list\"\n")
	if _, args := codexPlan(t, tree.codexCtx("-p", "work")); codexNotifyArg(args) != "" {
		t.Fatalf("a profile notify that is not a list: left alone: %q", args)
	}
	tree.write(t, filepath.Join(codexHome, "work.config.toml"), "notify = [\n")
	if plan, _ := codexPlan(t, tree.codexCtx("-p", "work")); plan.StepAside == "" {
		t.Fatalf("a profile file that cannot be parsed: the launcher steps aside: %+v", plan)
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
	if plan, args := codexPlan(t, ctx); len(args) != 6 || !strings.Contains(strings.Join(itemNames(plan.Skipped, molten.IntegrationNotify), ""), "organization") {
		t.Fatalf("a managed notify applies above -c: left alone: %q %v", args, plan.Skipped)
	}
	tree.write(t, managed, "[mcp_servers.molten-browser]\ncommand = \"x\"\n")
	if _, args := codexPlan(t, ctx); len(args) != 2 {
		t.Fatalf("a managed molten-browser: no browser added: %q", args)
	}
	os.Remove(managed)

	tree.write(t, tree.codexConfig(), "project_root_markers = [\".hg\"]\n")
	if _, args := codexPlan(t, tree.codexCtx()); len(args) != 6 {
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
	notify := overridesOf(t, args, 8)["notify"].([]any)
	if !slices.Equal(notify[:7], []any{codexTestMolten, "agent", "notify", "--agent", "codex", NotifySessionOnlyFlag, "--"}) || notify[7] != "sh" {
		t.Fatalf("the #221 snippet: the wrapper only links the session: %q", notify)
	}
	if len(itemNames(plan.Added, molten.IntegrationNotify)) != 0 || !slices.Contains(itemNames(plan.Added, molten.IntegrationSession), codexSessionItemName+"|") {
		t.Fatalf("the #221 snippet: added %v", plan.Added)
	}

	tree.write(t, tree.codexConfig(), "notify = [\"/bin/notify\", \"https://hooks.example/T0K3N\"]\n")
	plan, args = codexPlan(t, tree.codexCtx())
	shown := strings.Join(plan.ShownArgs, " ")
	if strings.Contains(shown, "T0K3N") || !strings.Contains(shown, `"/bin/notify","<1 more of your arguments>"]`) || !strings.Contains(args[7], "T0K3N") {
		t.Fatalf("the report never shows the user's notify arguments: %q", shown)
	}
	_, all := codexPlanAll(t, tree.codexCtx())
	if len(plan.ShownArgs) != len(all) {
		t.Fatalf("every added argument is shown: %q", plan.ShownArgs)
	}
}
