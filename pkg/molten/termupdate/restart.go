// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package termupdate

import (
	"context"
	"fmt"
	"slices"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// Restart with current settings (#389, the Sessions view's bulk actions): the coding agent of a terminal is ended with
// its own exit command and started again on the same conversation in the same pane, so it reads the user's settings
// again (a new default permission mode, a new agent version, MoltenTerm's integration). It is Update terminal's
// agent path without the outdated-shell condition, with its guarantees: an agent that works or waits for an answer is
// never typed into, and nothing is ever signalled or killed.

// must match frontend/moltenterm-shell/sessions/sessions-bulk.ts
const (
	AgentRestartCommand = "moltenagentrestart"

	StatusRestarted = "restarted"
	StatusNoAgent   = "noagent"

	claudePermissionModeFlag = "--permission-mode"
)

// The modes a restart may pass to Claude Code (claude --help: --permission-mode <mode>). Auto is left out: it is
// gated by Claude Code's own settings and would fail the start where it is not available.
var restartModes = []string{ModeDefault, ModeAcceptEdits, ModePlan, ModeBypassPermissions}

// AgentRestartRequest restarts the agent of a terminal. Agent: the agent the window listed ("" for any); Mode: a
// Claude Code permission mode for the resumed run, "" to keep the user's default.
type AgentRestartRequest struct {
	BlockId string `json:"blockid"`
	Agent   string `json:"agent,omitempty"`
	Mode    string `json:"mode,omitempty"`
}

var restartTextsCurrent = restartTexts{
	notice:     "MoltenTerm: restarting with the current settings",
	again:      "Restart it",
	againLower: "restart it with the current settings",
	done:       "Restarted.",
	doneStatus: StatusRestarted,
}

// RestartAgent restarts the terminal's agent on its session, or says why it did not touch the terminal.
func (u *Updater) RestartAgent(ctx context.Context, req AgentRestartRequest) Outcome {
	if !u.begin(req.BlockId) {
		return Outcome{Status: StatusBusy, Message: "MoltenTerm is already typing in this terminal: try again in a moment."}
	}
	defer u.end(req.BlockId)
	st, out := u.inspect(ctx, req.BlockId)
	if out != nil {
		if out.Message == msgNotLocal {
			out.Message = "Only an agent running in a local terminal can be restarted."
		}
		return *out
	}
	expected := molten.AgentDisplayName(req.Agent)
	if expected == "" {
		expected = "The agent"
	}
	if st.adapter == nil {
		if st.busy != "" {
			return Outcome{Status: StatusBusy, Program: st.busy, Message: fmt.Sprintf("%s is in the foreground of this terminal, not %s: nothing was typed.", st.busy, expected)}
		}
		return Outcome{Status: StatusNoAgent, Message: fmt.Sprintf("%s no longer runs in this terminal: nothing was typed.", expected)}
	}
	agent, name := st.agent.Agent, st.adapter.Name()
	if req.Agent != "" && req.Agent != agent {
		return Outcome{Status: StatusBusy, Program: name, Agent: agent, AgentName: name, Message: fmt.Sprintf("%s is in the foreground of this terminal, not %s: nothing was typed.", name, expected)}
	}
	var extra []string
	if req.Mode != "" {
		if agent != molten.AgentIdClaude {
			return Outcome{Status: StatusUnavailable, Agent: agent, AgentName: name, Message: fmt.Sprintf("%s has no permission mode MoltenTerm can set: nothing was typed.", name)}
		}
		if !slices.Contains(restartModes, req.Mode) {
			return Outcome{Status: StatusUnavailable, Agent: agent, AgentName: name, Message: fmt.Sprintf("%s has no permission mode %q: nothing was typed.", name, req.Mode)}
		}
		extra = []string{claudePermissionModeFlag, req.Mode}
	}
	return u.restartAgent(ctx, req.BlockId, st, restartTextsCurrent, extra...)
}
