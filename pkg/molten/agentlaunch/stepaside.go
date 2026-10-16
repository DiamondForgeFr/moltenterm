// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentlaunch

import (
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// StepAsideTextOf is the code of one of the fixed reasons a launch adds nothing (this file's and settings.go's), nil
// for any other text (#656).
func StepAsideTextOf(reason string) *uimsg.Text {
	switch reason {
	case StepAsideOutsidePane:
		return uimsg.Make("integration.stepaside.outsidepane")
	case StepAsideNested:
		return uimsg.Make("integration.stepaside.nested")
	case StepAsideTurnedOff:
		return uimsg.Make("integration.stepaside.turnedoff", "var", IntegrationVarName)
	case StepAsidePassThrough:
		return uimsg.Make("integration.stepaside.passthrough")
	case StepAsideSettingsOff:
		return uimsg.Make("integration.stepaside.settingsoff", "setting", SettingIntegrate)
	case StepAsideSettingsAgentOff:
		return uimsg.Make("integration.stepaside.settingsagentoff", "setting", SettingIntegrateOff)
	case StepAsideSettingsUnknown:
		return uimsg.Make("integration.stepaside.settingsunknown")
	}
	return nil
}

// Why a launch adds nothing (DS-SHELL-045): the real binary then runs with the user's arguments unchanged.
const (
	StepAsideOutsidePane = "not in a MoltenTerm terminal"
	StepAsideNested      = "started by a running agent"
	StepAsideTurnedOff   = IntegrationVarName + "=0"
	StepAsidePassThrough = "a command that starts no session"
)

// Variables a coding agent sets for the processes it starts (its tools' shells): a `claude` run there is the
// agent's own subprocess, whose hooks must not take the pane's session link.
var nestedAgentVars = []string{LaunchedVarName, "CLAUDECODE"}

// StepAsideReason tells why a launch adds nothing, or "" to integrate it. A run outside a MoltenTerm pane (no block
// or no token: another terminal app, an SSH or WSL shell) is never touched.
func StepAsideReason(getenv func(string) string, args []string, adapter LaunchAdapter) string {
	if getenv("WAVETERM_BLOCKID") == "" || getenv("WAVETERM_JWT") == "" {
		return StepAsideOutsidePane
	}
	for _, name := range nestedAgentVars {
		if getenv(name) != "" {
			return StepAsideNested
		}
	}
	// The Agent SDK starts claude for a program, not for the pane's user.
	if strings.HasPrefix(getenv("CLAUDE_CODE_ENTRYPOINT"), "sdk") {
		return StepAsideNested
	}
	if getenv(IntegrationVarName) == "0" {
		return StepAsideTurnedOff
	}
	if adapter.PassThrough(args) {
		return StepAsidePassThrough
	}
	return ""
}
