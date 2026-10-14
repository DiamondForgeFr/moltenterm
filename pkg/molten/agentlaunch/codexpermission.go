// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentlaunch

import (
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// The coffee approvals for Codex (FR-SHELL-064, DS-SHELL-113): a PermissionRequest hook running `molten agent
// permission --agent codex`, given for the run through -c only. Codex runs a hook it was not given by its
// administrator only once the developer trusted it in /hooks, and keeps that trust against the hook's hash, so the
// hook's definition never changes (molten.CodexPermissionHookCommand). MoltenTerm never trusts it for the developer
// and never passes --dangerously-bypass-hook-trust.

const (
	codexHooksKey              = "hooks"
	codexPermissionEvent       = "PermissionRequest"
	codexFeaturesKey           = "features"
	codexManagedHooksOnlyKey   = "allow_managed_hooks_only"
	CodexCoffeeApprovalName    = "Coffee approvals (once you trust MoltenTerm's hook in Codex's /hooks)"
	codexCoffeeSkippedName     = "Coffee approvals"
	codexPermissionOverrideKey = codexHooksKey + "." + codexPermissionEvent
)

// The feature flags that turn Codex's hooks off when false (codex_hooks is the older name).
var codexHookFeatures = []string{"hooks", "codex_hooks"}

// codexPermissionHookValue is the -c value: one matcher group without a matcher (every request), one command.
func codexPermissionHookValue() string {
	return fmt.Sprintf("[{hooks=[{type=%s,command=%s,timeout=%d}]}]",
		tomlString("command"), tomlString(molten.CodexPermissionHookCommand), molten.CodexPermissionHookTimeout)
}

// hooksOffWhere names the file (or -c) that turns Codex's hooks off, or "".
func (c codexConfig) hooksOffWhere(args codexArgs) string {
	for _, f := range codexHookFeatures {
		if v, ok := args.overrides[codexFeaturesKey+"."+f]; ok && v == "false" {
			return "your -c " + codexFeaturesKey + "." + f
		}
	}
	for _, s := range c.sources {
		features, _ := s.keys[codexFeaturesKey].(map[string]any)
		for _, f := range codexHookFeatures {
			if on, ok := features[f].(bool); ok && !on {
				return s.display
			}
		}
	}
	return ""
}

// permissionHooksWhere names a file that has its own PermissionRequest hooks, or "".
func (c codexConfig) permissionHooksWhere() string {
	for _, s := range c.sources {
		hooks, _ := s.keys[codexHooksKey].(map[string]any)
		if _, ok := hooks[codexPermissionEvent]; ok {
			return s.display
		}
	}
	return ""
}

// managedHooksOnlyWhere names the managed file that allows only its own hooks, or "".
func (c codexConfig) managedHooksOnlyWhere() string {
	for _, s := range c.sources {
		if only, ok := s.keys[codexManagedHooksOnlyKey].(bool); ok && only && s.managed {
			return s.display
		}
	}
	return ""
}

func planCodexPermission(ctx LaunchContext, args codexArgs, config codexConfig, plan *LaunchPlan) []string {
	skip := func(reason string) []string {
		plan.Skipped = append(plan.Skipped, molten.IntegrationItem{Kind: molten.IntegrationCoffeeApproval, Name: codexCoffeeSkippedName, Reason: reason})
		return nil
	}
	if isReviewSession(ctx) {
		return skip(ReasonReviewSession)
	}
	if ctx.MoltenPath == "" {
		return skip("MoltenTerm's molten command is not installed")
	}
	if where := config.managedHooksOnlyWhere(); where != "" {
		return skip("your organization's " + where + " allows only its own hooks")
	}
	if where := config.hooksOffWhere(args); where != "" {
		return skip("Codex's hooks are turned off in " + where)
	}
	if args.overridesKey(codexHooksKey) {
		return skip("you passed -c " + codexHooksKey + ": only your own hooks run")
	}
	if where := config.permissionHooksWhere(); where != "" {
		// A value given for the run could take the place of the developer's own hooks for that event.
		return skip("you have your own PermissionRequest hooks, in " + where)
	}
	plan.Added = append(plan.Added, molten.IntegrationItem{Kind: molten.IntegrationCoffeeApproval, Name: CodexCoffeeApprovalName})
	return []string{codexConfigFlag, codexPermissionOverrideKey + "=" + codexPermissionHookValue()}
}
