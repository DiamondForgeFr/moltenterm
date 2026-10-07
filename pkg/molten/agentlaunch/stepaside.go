// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentlaunch

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
	if getenv(IntegrationVarName) == "0" {
		return StepAsideTurnedOff
	}
	if adapter.PassThrough(args) {
		return StepAsidePassThrough
	}
	return ""
}
