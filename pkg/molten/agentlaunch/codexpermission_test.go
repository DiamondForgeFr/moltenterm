// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentlaunch

import (
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// FR-SHELL-064-AC1: the run carries the PermissionRequest hook through its -c overrides only, its definition the same
// at every run (Codex keeps the developer's trust against its hash); nothing bypasses that trust.
func TestCodexPlanPermissionHook(t *testing.T) {
	tree := makeFakeTree(t)
	plan, args := codexPlanAll(t, tree.codexCtx("fix"))
	i := slices.IndexFunc(args, func(a string) bool { return strings.HasPrefix(a, codexPermissionOverrideKey+"=") })
	if i < 1 || args[i-1] != "-c" || args[len(args)-1] != "fix" {
		t.Fatalf("hook override: %q", args)
	}
	hooks := overridesOf(t, args[i-1:i+1], 2)[codexPermissionOverrideKey].([]any)
	group := hooks[0].(map[string]any)
	if _, ok := group["matcher"]; ok || len(hooks) != 1 {
		t.Fatalf("one group, no matcher: %v", hooks)
	}
	handler := group["hooks"].([]any)[0].(map[string]any)
	if handler["type"] != "command" || handler["command"] != molten.CodexPermissionHookCommand || handler["timeout"] != int64(molten.CodexPermissionHookTimeout) {
		t.Fatalf("handler: %v", handler)
	}
	if !strings.Contains(molten.CodexPermissionHookCommand, "molten agent permission --agent codex") {
		t.Fatalf("command: %s", molten.CodexPermissionHookCommand)
	}
	if names := itemNames(plan.Added, molten.IntegrationCoffeeApproval); len(names) != 1 || !strings.Contains(names[0], "/hooks") {
		t.Fatalf("report: %v", plan.Added)
	}
	_, again := codexPlanAll(t, tree.codexCtx("other prompt"))
	if !slices.Contains(again, args[i]) {
		t.Fatalf("the hook's definition must not change between runs: %q vs %q", args[i], again)
	}
	for _, a := range args {
		if strings.Contains(a, "bypass") {
			t.Fatalf("no trust bypass: %q", args)
		}
	}
}

func TestCodexPlanPermissionSkips(t *testing.T) {
	tree := makeFakeTree(t)
	cases := []struct {
		name   string
		config string
		args   []string
		reason string
	}{
		{"own -c hooks", "", []string{"-c", `hooks.PreToolUse=[]`}, "only your own hooks"},
		{"hooks off by -c", "", []string{"-c", "features.hooks=false"}, "turned off in your -c features.hooks"},
		{"hooks off in config", "[features]\nhooks = false\n", nil, "turned off in"},
		{"older flag off", "[features]\ncodex_hooks = false\n", nil, "turned off in"},
		{"own PermissionRequest hooks", "[[hooks.PermissionRequest]]\n[[hooks.PermissionRequest.hooks]]\ntype = \"command\"\ncommand = \"mine\"\n", nil, "your own PermissionRequest hooks"},
	}
	for _, tc := range cases {
		tree.write(t, tree.codexConfig(), tc.config)
		plan, args := codexPlanAll(t, tree.codexCtx(tc.args...))
		if slices.ContainsFunc(args, func(a string) bool { return strings.HasPrefix(a, codexPermissionOverrideKey+"=") }) {
			t.Errorf("%s: no hook may be added: %q", tc.name, args)
		}
		skipped := strings.Join(itemNames(plan.Skipped, molten.IntegrationCoffeeApproval), "")
		if !strings.Contains(skipped, tc.reason) {
			t.Errorf("%s: skipped %q, want %q", tc.name, skipped, tc.reason)
		}
	}
	tree.write(t, tree.codexConfig(), "")
	ctx := tree.codexCtx()
	tree.write(t, filepath.Join(filepath.Dir(ctx.CodexSystemConfig), "managed_config.toml"), "allow_managed_hooks_only = true\n")
	if plan, _ := codexPlanAll(t, ctx); !strings.Contains(strings.Join(itemNames(plan.Skipped, molten.IntegrationCoffeeApproval), ""), "organization") {
		t.Errorf("managed hooks only: %v", plan.Skipped)
	}
}
