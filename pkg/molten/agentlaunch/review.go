// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agentlaunch

import (
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
)

// A review session's agent (FR-REV-004) runs with MoltenTerm's review token in its environment. Its read-only profile
// and its tools are on its own command line; the launcher still adds the state hooks and the status line, but never
// the coffee approvals: an approval granted for unattended work must not apply to a session that reads untrusted PR
// content (#505 R1). wavesrv refuses the session's permission requests too (pkg/molten/keepawake).

const ReasonReviewSession = "a review session is read-only: coffee mode never answers its requests"

func isReviewSession(ctx LaunchContext) bool {
	return ctx.Env.Getenv != nil && ctx.Env.Getenv(mcpreview.SessionTokenVarName) != ""
}

// isOwnSession: the terminal of Brokk's own session (#2257), whose permission requests wait for the developer's answer
// in his layer. Set in his block's cmd:env; another terminal setting it only lengthens its own hook, and wavesrv still
// checks the caller's block before keeping a request.
func isOwnSession(ctx LaunchContext) bool {
	return ctx.Env.Getenv != nil && ctx.Env.Getenv(molten.OwnSessionEnvVar) == "1"
}

// ownSessionHookBudget gives his session's PermissionRequest hook the time a human answer takes; every other terminal
// keeps the short one.
func ownSessionHookBudget(ctx LaunchContext, hooks []plannedHook) {
	if !isOwnSession(ctx) {
		return
	}
	for i := range hooks {
		if hooks[i].event == molten.ClaudePermissionHookEvent {
			hooks[i].timeout = molten.ClaudeOwnSessionPermissionHookTimeout
		}
	}
}
