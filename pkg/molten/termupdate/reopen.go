// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package termupdate

import (
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/agentcontinuity"
	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/molten/companion"
	"github.com/wavetermdev/waveterm/pkg/molten/reopen"
)

// A view put away with its agent comes back with it (FR-SHELL-088): before a terminal closes, the reopen stack notes
// the agent it runs and the command that resumes its session, through the agent's adapter, whatever its provider. A
// close must not wait: the companion is only asked what it already knows (no transcript is opened); without a sure
// session the command resumes the agent's last session in the folder.

// AgentResume reads the agent running in a terminal and the command line that starts it again on its session.
func AgentResume(blockId string) (reopen.ResumeAgent, bool) {
	run, ok := attention.AgentRun(blockId)
	if !ok || !run.Running || run.Agent == "" {
		return reopen.ResumeAgent{}, false
	}
	adapter := agentcontinuity.Find(run.Agent)
	if adapter == nil {
		return reopen.ResumeAgent{}, false
	}
	session := companion.KnownResumeSession(blockId, run.Agent)
	command, guessed := ResumeCommand(adapter, run.Agent, session)
	name := strings.TrimSpace(run.FirstName)
	if name == "" {
		name = adapter.Name()
	}
	return reopen.ResumeAgent{Agent: run.Agent, Name: name, Command: command, Guessed: guessed}, true
}

// StartReopenAgents lets the reopen stack read the agents; wavesrv calls it once.
func StartReopenAgents() {
	reopen.SetAgentResume(AgentResume)
}
