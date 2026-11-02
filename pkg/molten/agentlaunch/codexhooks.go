// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentlaunch

import (
	"fmt"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// Codex's state hooks (#988, FR-SHELL-038, DS-SHELL-050; codex-cli 0.163.0, its hook schemas and
// developers.openai.com/codex/hooks): the same events as Claude Code's, given for the run through -c, every one
// running `molten agent hook --agent codex` (molten.CodexStateHookCommand), which reads hook_event_name from the
// hook's input. Like the coffee hook (codexpermission.go), they run only once the developer trusted them in /hooks;
// MoltenTerm never bypasses that trust, and until then notify reports done (codex.go). Codex has no Notification event:
// waiting comes from the PermissionRequest hook and from Codex's own terminal notifications, asked for below.

const (
	codexStateHooksName = "Agent state hooks"
	codexTuiKey         = "tui"
	// Codex's [tui] notification keys (TuiNotificationSettings): which notifications, OSC 9 or BEL, and whether only
	// while the terminal is unfocused (the default) or always.
	codexTuiNotifications  = "notifications"
	codexTuiMethod         = "notification_method"
	codexTuiCondition      = "notification_condition"
	codexNotificationsName = "Waiting state from Codex's notifications (approvals and questions)"
)

// The notifications that mean Codex waits for the developer; agent-turn-complete is left out: done comes from the
// hooks and notify, and its OSC 9 would come on top.
var codexWaitingNotifications = []string{"approval-requested", "plan-mode-prompt", "async-question"}

// codexHookValue is a -c value for one event: one matcher group without a matcher (every occurrence), one command.
func codexHookValue(command string, timeout int) string {
	return fmt.Sprintf("[{hooks=[{type=%s,command=%s,timeout=%d}]}]", tomlString("command"), tomlString(command), timeout)
}

// eventHooksWhere names the first file (config.toml or hooks.json) with hooks of its own for an event, and whether one
// of them already runs MoltenTerm's handler (match).
func (c codexConfig) eventHooksWhere(event string, match func(string) bool) (string, bool) {
	where, ours := "", false
	check := func(display string, hooks map[string]any) {
		commands, ok := codexEventCommands(hooks, event)
		if !ok {
			return
		}
		for _, command := range commands {
			if match(command) {
				where, ours = display, true
				return
			}
		}
		if where == "" {
			where = display
		}
	}
	for _, s := range c.sources {
		hooks, _ := s.keys[codexHooksKey].(map[string]any)
		check(s.display, hooks)
	}
	for _, f := range c.hookFiles {
		hooks, _ := f.keys[codexHooksKey].(map[string]any)
		check(f.display, hooks)
	}
	return where, ours
}

// codexEventCommands lists the commands of an event's matcher groups, as a TOML table or a hooks.json reads; ok
// tells whether the event is there at all.
func codexEventCommands(hooks map[string]any, event string) ([]string, bool) {
	raw, ok := hooks[event]
	if !ok {
		return nil, false
	}
	var rtn []string
	for _, group := range anyList(raw) {
		g, _ := group.(map[string]any)
		for _, handler := range anyList(g["hooks"]) {
			h, _ := handler.(map[string]any)
			if command, ok := h["command"].(string); ok {
				rtn = append(rtn, command)
			}
		}
	}
	return rtn, true
}

// anyList reads an array as decoded from TOML ([]map[string]any for an array of tables) or JSON ([]any).
func anyList(raw any) []any {
	switch v := raw.(type) {
	case []any:
		return v
	case []map[string]any:
		rtn := make([]any, len(v))
		for i, m := range v {
			rtn[i] = m
		}
		return rtn
	}
	return nil
}

func planCodexStateHooks(ctx LaunchContext, args codexArgs, config codexConfig, plan *LaunchPlan) []string {
	skipAll := func(reason phrase) []string {
		plan.Skipped = append(plan.Skipped, skippedItem(molten.IntegrationStateHooks, say(uimsg.Make("integration.name.statehooks"), codexStateHooksName), reason))
		return nil
	}
	if ctx.MoltenPath == "" {
		return skipAll(moltenNotInstalled)
	}
	if where := config.managedHooksOnlyWhere(); where != "" {
		return skipAll(say(uimsg.Make("integration.reason.managedhooksonlyin", "where", where), "your organization's "+where+" allows only its own hooks"))
	}
	if where := config.hooksOffWhere(args); where != "" {
		return skipAll(say(uimsg.Make("integration.reason.codexhooksoff", "where", where), "Codex's hooks are turned off in "+where))
	}
	if args.overridesKey(codexHooksKey) {
		return skipAll(say(uimsg.Make("integration.reason.codexhooksflag", "flag", "-c "+codexHooksKey), "you passed -c "+codexHooksKey+": only your own hooks run"))
	}
	if config.hookFileUnreadable != "" {
		where := config.hookFileUnreadable
		return skipAll(say(uimsg.Make("integration.reason.fileunreadable", "where", where), where+" could not be read"))
	}
	var rtn, added []string
	for _, h := range molten.AgentStateHooks(molten.AgentIdCodex) {
		match := molten.IsAgentStateHookCommand
		if h.Event == molten.ClaudeSessionHookEvent {
			match = molten.IsAgentSessionHookCommand
		}
		if where, ours := config.eventHooksWhere(h.Event, match); where != "" {
			// A value given for the run could take the place of the developer's own hooks for that event.
			reason := say(uimsg.Make("integration.reason.owneventhooks", "event", h.Event, "where", where), "you have your own "+h.Event+" hooks, in "+where)
			if ours {
				reason = alreadyYours(where)
			}
			plan.Skipped = append(plan.Skipped, skippedItem(molten.IntegrationStateHooks, stateHooksPhrase([]string{h.Event}), reason))
			continue
		}
		added = append(added, h.Event)
		rtn = append(rtn, codexConfigFlag, codexHooksKey+"."+h.Event+"="+codexHookValue(h.Command, h.Timeout))
	}
	if len(added) == 0 {
		return nil
	}
	list := strings.Join(added, ", ")
	plan.Added = append(plan.Added, addedItem(molten.IntegrationStateHooks,
		say(uimsg.Make("integration.name.codexstatehooksof", "events", list), "Agent state hooks ("+list+"), once you trust MoltenTerm's hooks in Codex's /hooks")))
	for _, event := range added {
		if event == molten.ClaudeSessionHookEvent {
			plan.Added = append(plan.Added, addedItem(molten.IntegrationSession,
				say(uimsg.Make("integration.name.codexsessionstart"), "Session link at start (once you trust MoltenTerm's hooks in Codex's /hooks)")))
		}
	}
	return rtn
}

// tuiWhere names the file (or -c) that sets one of Codex's [tui] notification keys, or "".
func (c codexConfig) tuiWhere(args codexArgs) string {
	if _, whole := args.overrides[codexTuiKey]; whole {
		return "your -c " + codexTuiKey
	}
	keys := []string{codexTuiNotifications, codexTuiMethod, codexTuiCondition}
	for _, k := range keys {
		if args.overridesKey(codexTuiKey + "." + k) {
			return "your -c " + codexTuiKey + "." + k
		}
	}
	for _, s := range c.sources {
		tui, _ := s.keys[codexTuiKey].(map[string]any)
		for _, k := range keys {
			if _, ok := tui[k]; ok {
				return s.display
			}
		}
	}
	return ""
}

// planCodexNotifications asks Codex for an OSC 9 whenever it waits for the developer, focused or not: MoltenTerm reads
// it as waiting (FR-SHELL-003), with no trust to give. The developer's own notification settings are left as set.
func planCodexNotifications(ctx LaunchContext, args codexArgs, config codexConfig, plan *LaunchPlan) []string {
	name := say(uimsg.Make("integration.name.codexnotifications"), codexNotificationsName)
	if ctx.MoltenPath == "" {
		plan.Skipped = append(plan.Skipped, skippedItem(molten.IntegrationNotifications, name, moltenNotInstalled))
		return nil
	}
	if where := config.tuiWhere(args); where != "" {
		plan.Skipped = append(plan.Skipped, skippedItem(molten.IntegrationNotifications, name,
			say(uimsg.Make("integration.reason.owntuinotifications", "where", where), where+" sets Codex's notifications: they work as you set them")))
		return nil
	}
	plan.Added = append(plan.Added, addedItem(molten.IntegrationNotifications, name))
	prefix := codexTuiKey + "."
	return []string{
		codexConfigFlag, prefix + codexTuiNotifications + "=" + tomlArray(codexWaitingNotifications),
		codexConfigFlag, prefix + codexTuiMethod + "=" + tomlString("osc9"),
		codexConfigFlag, prefix + codexTuiCondition + "=" + tomlString("always"),
	}
}
