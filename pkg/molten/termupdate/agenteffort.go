// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package termupdate

import (
	"fmt"
	"os"
	"slices"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentcontinuity"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// Effort levels from the command panel (#549), the way each agent takes them, through the same guarded input as the
// other commands. Claude Code: `/effort <level>`, which applies at once; Claude Code itself keeps low to xhigh as its
// default for new sessions, max for this session only, and its status line reports the new level to the header.
// Codex: its effort keys, one press per level from the level its last turn reported, which change this session only;
// Codex writes the new level at its next turn, so the header shows none until then rather than a guess.

// setEffort types the effort command of the agent's table.
func (u *Updater) setEffort(req AgentInputRequest, st shellState, cmd agentcontinuity.AgentCommand, name string) AgentInputResult {
	run, _ := u.env.AgentRun(req.BlockId)
	target := req.Effort
	levels := u.effortLevels(st.agent.Agent, run.Settings.Model)
	if !slices.Contains(levels, target) {
		return refused(InputReasonUnknownAction, uimsg.Make("termupdate.effort.unknown", "agent", name, "effort", target),
			fmt.Sprintf("%s has no effort level %q here: nothing was typed.", name, target))
	}
	if run.Settings.Effort == target {
		rtn := sentResult(uimsg.Make("termupdate.effort.already", "agent", name, "effort", target),
			fmt.Sprintf("%s already runs at %s effort.", name, target))
		rtn.Effort = target
		return rtn
	}
	if cmd.Text != "" {
		return u.typeEffortCommand(req, st, cmd, name, target)
	}
	return u.pressEffortKeys(req, st, cmd, name, run.Settings.Effort, levels, target)
}

func (u *Updater) typeEffortCommand(req AgentInputRequest, st shellState, cmd agentcontinuity.AgentCommand, name string, target string) AgentInputResult {
	text := cmd.Text + " " + target
	sent, err := u.sendToForegroundAgent(req.BlockId, st.agent, st.shell.Pid, []string{keyClearLine, text, "\r"})
	if err != nil {
		return refusedNotTaken(err)
	}
	if !sent {
		return refusedGone(name)
	}
	rtn := sentResult(uimsg.Make("termupdate.input.sent", "agent", name, "text", text), fmt.Sprintf("Sent %s to %s.", text, name))
	rtn.Effort = target
	return rtn
}

func (u *Updater) pressEffortKeys(req AgentInputRequest, st shellState, cmd agentcontinuity.AgentCommand, name string, current string, levels []string, target string) AgentInputResult {
	if u.env.EffortKeysRemapped != nil && u.env.EffortKeysRemapped(st.agent.Agent) {
		return refused(InputReasonEffortUnknown, uimsg.Make("termupdate.effort.remapped", "agent", name),
			fmt.Sprintf("Your %s settings give the effort shortcuts keys of their own: choose the level in %s's /model. Nothing was typed.", name, name))
	}
	from := slices.Index(levels, current)
	if from < 0 {
		return refused(InputReasonEffortUnknown, uimsg.Make("termupdate.effort.notknown", "agent", name),
			fmt.Sprintf("MoltenTerm does not know %s's effort level yet (it reads it at each turn): choose it in %s's /model. Nothing was typed.", name, name))
	}
	steps := slices.Index(levels, target) - from
	key := cmd.KeyRaise
	if steps < 0 {
		steps, key = -steps, cmd.KeyLower
	}
	keys := make([]string, steps)
	for i := range keys {
		keys[i] = key
	}
	sent, err := u.sendToForegroundAgent(req.BlockId, st.agent, st.shell.Pid, keys)
	if err != nil {
		u.clearEffort(req.BlockId, st.agent.Agent)
		return refusedNotTaken(err)
	}
	if !sent {
		return refusedGone(name)
	}
	u.clearEffort(req.BlockId, st.agent.Agent)
	return AgentInputResult{
		Result:      InputSent,
		Effort:      target,
		Presses:     steps,
		Message:     fmt.Sprintf("%s is set to %s effort for this session. MoltenTerm shows it from %s's next turn.", name, target, name),
		MessageText: uimsg.Make("termupdate.effort.set", "agent", name, "effort", target),
	}
}

// agentEnv is where wavesrv finds the agents' own files (Codex's models cache and config), read only.
func agentEnv() molten.AgentEnv {
	home, _ := os.UserHomeDir()
	return molten.AgentEnv{Home: home, Getenv: os.Getenv}
}

func (u *Updater) clearEffort(blockId string, agent string) {
	if u.env.ClearEffort != nil {
		u.env.ClearEffort(blockId, agent)
	}
}
