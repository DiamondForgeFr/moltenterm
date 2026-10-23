// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentlaunch

import (
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
)

// codexStateHookArgs reads the state hooks of a run's arguments: event -> its decoded -c value.
func codexStateHookArgs(t *testing.T, args []string) map[string][]any {
	t.Helper()
	rtn := map[string][]any{}
	for i := 0; i+1 < len(args); i++ {
		if args[i] != codexConfigFlag || !strings.HasPrefix(args[i+1], codexHooksKey+".") {
			continue
		}
		for key, value := range overridesOf(t, args[i:i+2], 2) {
			event := strings.TrimPrefix(key, codexHooksKey+".")
			if event != codexPermissionEvent {
				rtn[event] = value.([]any)
			}
		}
	}
	return rtn
}

func addedEvents(t *testing.T, args []string) []string {
	t.Helper()
	var rtn []string
	for _, h := range molten.AgentStateHooks(molten.AgentIdCodex) {
		if _, ok := codexStateHookArgs(t, args)[h.Event]; ok {
			rtn = append(rtn, h.Event)
		}
	}
	return rtn
}

var allCodexEvents = []string{"SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SubagentStart", "SubagentStop"}

// #988, TC-SHELL-038-4: a stock run gets the six state hooks, one group each, every one the same fixed handler (Codex
// trusts it by its hash), valid TOML, and the notification keys; nothing bypasses the trust.
func TestCodexPlanStateHooks(t *testing.T) {
	tree := makeFakeTree(t)
	plan, args := codexPlanAll(t, tree.codexCtx("fix"))
	hooks := codexStateHookArgs(t, args)
	if got := addedEvents(t, args); !slices.Equal(got, allCodexEvents) {
		t.Fatalf("events %v, want %v: %q", got, allCodexEvents, args)
	}
	for event, groups := range hooks {
		group := groups[0].(map[string]any)
		if _, ok := group["matcher"]; ok || len(groups) != 1 {
			t.Fatalf("%s: one group, no matcher: %v", event, groups)
		}
		handler := group["hooks"].([]any)[0].(map[string]any)
		if handler["type"] != "command" || handler["command"] != molten.CodexStateHookCommand || handler["timeout"] != int64(molten.CodexStateHookTimeout) {
			t.Fatalf("%s handler: %v", event, handler)
		}
	}
	if molten.CodexStateHookCommand != `[ -n "$WAVETERM_BLOCKID" ] && molten agent hook --agent codex || true` || molten.CodexStateHookTimeout != 15 {
		t.Fatalf("the handler's definition changed: every developer would have to trust it again: %q %d", molten.CodexStateHookCommand, molten.CodexStateHookTimeout)
	}
	if args[len(args)-1] != "fix" || slices.ContainsFunc(args, func(a string) bool { return strings.Contains(a, "bypass") }) {
		t.Fatalf("args %q", args)
	}
	names := itemNames(plan.Added, molten.IntegrationStateHooks)
	if len(names) != 1 || !strings.Contains(names[0], strings.Join(allCodexEvents, ", ")) || !strings.Contains(names[0], "/hooks") {
		t.Fatalf("report %v", plan.Added)
	}
	if !slices.ContainsFunc(itemNames(plan.Added, molten.IntegrationSession), func(n string) bool { return strings.Contains(n, "at start") }) {
		t.Fatalf("session link at start: %v", plan.Added)
	}
	tui := overridesOf(t, args[slices.Index(args, "tui.notifications=[\"approval-requested\",\"plan-mode-prompt\",\"async-question\"]")-1:], 6)
	if tui["tui.notification_method"] != "osc9" || tui["tui.notification_condition"] != "always" ||
		!slices.Equal(tui["tui.notifications"].([]any), []any{"approval-requested", "plan-mode-prompt", "async-question"}) {
		t.Fatalf("notification keys: %v", tui)
	}
	if len(itemNames(plan.Added, molten.IntegrationNotifications)) != 1 {
		t.Fatalf("notifications not reported: %v", plan.Added)
	}

	// A review session needs a precise pane too (its Ask, Discuss and Translate are typed into it).
	ctx := tree.codexCtx("fix")
	ctx.Env.Getenv = func(k string) string {
		if k == mcpreview.SessionTokenVarName {
			return "r-1"
		}
		return ""
	}
	if _, args := codexPlanAll(t, ctx); !isReviewSession(ctx) || !slices.Equal(addedEvents(t, args), allCodexEvents) {
		t.Fatalf("review session: %q", args)
	}
}

// The skip rules of the coffee hook, for all the state hooks; per event, the developer's own hooks in a config.toml
// or a hooks.json.
func TestCodexPlanStateHookSkips(t *testing.T) {
	tree := makeFakeTree(t)
	whole := []struct {
		name   string
		config string
		args   []string
		reason string
	}{
		{"own -c hooks", "", []string{"-c", `hooks.PreToolUse=[]`}, "only your own hooks"},
		{"hooks off", "[features]\nhooks = false\n", nil, "turned off in"},
		{"hooks off by -c", "", []string{"-c", "features.codex_hooks=false"}, "turned off in your -c"},
	}
	for _, tc := range whole {
		tree.write(t, tree.codexConfig(), tc.config)
		plan, args := codexPlanAll(t, tree.codexCtx(tc.args...))
		if got := addedEvents(t, args); len(got) != 0 {
			t.Errorf("%s: no state hook may be added: %v", tc.name, got)
		}
		if skipped := strings.Join(itemNames(plan.Skipped, molten.IntegrationStateHooks), ""); !strings.Contains(skipped, tc.reason) {
			t.Errorf("%s: skipped %q, want %q", tc.name, skipped, tc.reason)
		}
	}
	tree.write(t, tree.codexConfig(), "")
	ctx := tree.codexCtx()
	managed := filepath.Join(filepath.Dir(ctx.CodexSystemConfig), "managed_config.toml")
	tree.write(t, managed, "allow_managed_hooks_only = true\n")
	if plan, args := codexPlanAll(t, ctx); len(addedEvents(t, args)) != 0 || !strings.Contains(strings.Join(itemNames(plan.Skipped, molten.IntegrationStateHooks), ""), "organization") {
		t.Errorf("managed hooks only: %v", plan.Skipped)
	}
	tree.write(t, managed, "")

	// The developer's own Stop hook in a config.toml: Stop only is left to them.
	tree.write(t, tree.codexConfig(), "[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = \"command\"\ncommand = \"afplay done.wav\"\n")
	plan, args := codexPlanAll(t, tree.codexCtx())
	if got := addedEvents(t, args); slices.Contains(got, "Stop") || len(got) != 5 {
		t.Fatalf("own Stop hook: %v", got)
	}
	if skipped := strings.Join(itemNames(plan.Skipped, molten.IntegrationStateHooks), ""); !strings.Contains(skipped, "(Stop)") || !strings.Contains(skipped, "your own Stop hooks, in ~/.codex/config.toml") {
		t.Fatalf("skipped %q", skipped)
	}
	tree.write(t, tree.codexConfig(), "")

	// hooks.json, user and project: the developer's own, and the documented snippet (already yours).
	userHooks := filepath.Join(tree.home, ".codex", "hooks.json")
	tree.write(t, userHooks, `{"hooks":{"PostToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"lint"}]}],`+
		`"SessionStart":[{"hooks":[{"type":"command","command":"[ -n \"$WAVETERM_BLOCKID\" ] && molten agent hook --agent codex || true","timeout":15}]}]}}`)
	tree.write(t, filepath.Join(tree.project, ".codex", "hooks.json"), `{"hooks":{"PermissionRequest":[{"hooks":[{"type":"command","command":"mine"}]}]}}`)
	plan, args = codexPlanAll(t, tree.codexCtx())
	if got := addedEvents(t, args); !slices.Equal(got, []string{"UserPromptSubmit", "Stop", "SubagentStart", "SubagentStop"}) {
		t.Fatalf("hooks.json: %v", got)
	}
	skipped := strings.Join(itemNames(plan.Skipped, molten.IntegrationStateHooks), "\n")
	if !strings.Contains(skipped, "(PostToolUse)|you have your own PostToolUse hooks, in ~/.codex/hooks.json") ||
		!strings.Contains(skipped, "(SessionStart)|already yours, in ~/.codex/hooks.json") {
		t.Fatalf("skipped %q", skipped)
	}
	if !strings.Contains(strings.Join(itemNames(plan.Skipped, molten.IntegrationCoffeeApproval), ""), "your own PermissionRequest hooks") ||
		slices.ContainsFunc(args, func(a string) bool { return strings.HasPrefix(a, codexPermissionOverrideKey+"=") }) {
		t.Fatalf("a project hooks.json PermissionRequest leaves the coffee hook out: %v", plan.Skipped)
	}

	tree.write(t, userHooks, "{broken")
	plan, args = codexPlanAll(t, tree.codexCtx())
	if len(addedEvents(t, args)) != 0 || !strings.Contains(strings.Join(itemNames(plan.Skipped, molten.IntegrationStateHooks), ""), "hooks.json could not be read") {
		t.Fatalf("an unreadable hooks.json: %v", plan.Skipped)
	}
}

// The developer's own [tui] notification settings stay as set.
func TestCodexPlanNotificationSkips(t *testing.T) {
	tree := makeFakeTree(t)
	for name, tc := range map[string]struct {
		config string
		args   []string
		where  string
	}{
		"config":    {"[tui]\nnotifications = true\n", nil, "~/.codex/config.toml"},
		"condition": {"[tui]\nnotification_condition = \"unfocused\"\n", nil, "~/.codex/config.toml"},
		"-c key":    {"", []string{"-c", "tui.notification_method=bel"}, "your -c tui.notification_method"},
		"-c tui":    {"", []string{"-c", "tui={}"}, "your -c tui"},
	} {
		tree.write(t, tree.codexConfig(), tc.config)
		plan, args := codexPlanAll(t, tree.codexCtx(tc.args...))
		if slices.ContainsFunc(args[:len(args)-len(tc.args)], func(a string) bool { return strings.HasPrefix(a, "tui.") }) {
			t.Errorf("%s: no tui key may be added: %q", name, args)
		}
		if skipped := strings.Join(itemNames(plan.Skipped, molten.IntegrationNotifications), ""); !strings.Contains(skipped, tc.where) {
			t.Errorf("%s: skipped %q", name, skipped)
		}
	}
}
