// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentlaunch

import "github.com/wavetermdev/waveterm/pkg/molten/mcpreview"

// A review session's agent (FR-REV-004) runs with MoltenTerm's review token in its environment. Its read-only profile
// and its tools are on its own command line; the launcher still adds the state hooks and the status line, but never
// the coffee approvals: an approval granted for unattended work must not apply to a session that reads untrusted PR
// content (#505 R1). wavesrv refuses the session's permission requests too (pkg/molten/keepawake).

const ReasonReviewSession = "a review session is read-only: coffee mode never answers its requests"

func isReviewSession(ctx LaunchContext) bool {
	return ctx.Env.Getenv != nil && ctx.Env.Getenv(mcpreview.SessionTokenVarName) != ""
}
