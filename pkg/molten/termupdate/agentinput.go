// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package termupdate

import (
	"context"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentcontinuity"
)

// Safe agent input (FR-SHELL-048, DS-SHELL-087): the command panel's Agent section types a command of the agent's table
// (agentcontinuity/commands.go) into the terminal, with StopAgent's guarantees: the agent process recorded for the
// terminal must still be the shell's foreground program at the moment of sending, it must be neither working nor
// waiting for an answer (only Interrupt goes through while it works), and a command that empties the input line waits
// for the user's consent when an unsent draft may be there. Free text is never typed (NFR-SHELL-030).

// must match frontend/moltenterm-shell/command-panel/agent-commands.ts
const (
	AgentInputCommand     = "moltenagentinput"
	AgentInputInfoCommand = "moltenagentinputinfo"

	InputSent    = "sent"
	InputRefused = "refused"

	InputReasonWorking       = "working"
	InputReasonWaiting       = "waiting"
	InputReasonNotForeground = "notforeground"
	InputReasonDraft         = "draft"
	InputReasonUnknownAction = "unknownaction"
	InputReasonNoAgent       = "noagent"
	InputReasonBusy          = "busy"
	InputReasonUnavailable   = "unavailable"

	OfferInterrupt = "interrupt"
	OfferGoto      = "goto"

	// Claude Code's permission modes, by the ids its transcripts use.
	ModeDefault           = "default"
	ModeAcceptEdits       = "acceptEdits"
	ModePlan              = "plan"
	ModeBypassPermissions = "bypassPermissions"
	ModeAuto              = "auto"
)

const (
	// Shift+Tab goes round at most this many modes before the target must have shown.
	maxModePresses = 5
	// How long the agent has to draw its new mode after Shift+Tab.
	modeSettle = 1500 * time.Millisecond
)

// Full-screen programs an agent starts in its own process group (its editor on Ctrl+G, a !vim or !less): the agent is
// still in the foreground group, but these read the keys. Nothing is typed while one runs under the agent.
var terminalPrograms = []string{
	"vi", "vim", "nvim", "view", "nano", "pico", "emacs", "micro", "hx", "helix", "kak", "joe", "mg",
	"less", "more", "most", "man", "top", "htop", "btop", "watch", "ssh", "mosh", "tmux", "screen", "fzf", "tig", "lazygit",
}

var knownModes = []string{ModeDefault, ModeAcceptEdits, ModePlan, ModeBypassPermissions, ModeAuto}

var modeLabels = map[string]string{
	ModeDefault:           "Default",
	ModeAcceptEdits:       "Accept edits",
	ModePlan:              "Plan",
	ModeBypassPermissions: "Bypass permissions",
	ModeAuto:              "Auto",
}

// AgentInputRequest asks to type one command of the agent's table. Agent: the agent the panel showed; Mode: the
// permission mode to reach (permissionmode only, "" for one press); ConfirmedDraft: the user agreed that an unsent
// draft is cleared.
type AgentInputRequest struct {
	BlockId        string `json:"blockid"`
	Agent          string `json:"agent"`
	Action         string `json:"action"`
	Mode           string `json:"mode,omitempty"`
	ConfirmedDraft bool   `json:"confirmeddraft,omitempty"`
}

type AgentInputResult struct {
	Result string `json:"result"`
	Reason string `json:"reason,omitempty"`
	// Offer: what the panel offers instead of a refused command (interrupt, goto).
	Offer     string `json:"offer,omitempty"`
	Message   string `json:"message"`
	Agent     string `json:"agent,omitempty"`
	AgentName string `json:"agentname,omitempty"`
	// Program: what is in the foreground instead of the agent (notforeground).
	Program string `json:"program,omitempty"`
	// Mode: the permission mode the agent shows after the command, "" when not seen.
	Mode    string `json:"mode,omitempty"`
	Presses int    `json:"presses,omitempty"`
}

// AgentInputState is what the terminal's input and output tell about its agent (agentinputwatch.go).
type AgentInputState struct {
	// Mode: the permission mode the agent drew last, "" when not seen in this run; Modes: every mode seen.
	Mode  string
	Modes []string
	// Draft: the user may have typed a message not sent yet (always, for an agent without precise states).
	Draft bool
}

// AgentInputInfo is what the panel shows before a command: the mode and whether a draft may be cleared.
type AgentInputInfo struct {
	BlockId string   `json:"blockid"`
	Agent   string   `json:"agent,omitempty"`
	Mode    string   `json:"mode,omitempty"`
	Modes   []string `json:"modes,omitempty"`
	Draft   bool     `json:"draft,omitempty"`
}

func (u *Updater) inputState(blockId string) AgentInputState {
	if u.env.InputState == nil {
		return AgentInputState{Draft: true}
	}
	return u.env.InputState(blockId)
}

// AgentInputInfo reads the panel's facts without typing anything.
func (u *Updater) AgentInputInfo(blockId string) AgentInputInfo {
	rtn := AgentInputInfo{BlockId: blockId}
	run, ok := u.env.AgentRun(blockId)
	if !ok || !run.Running {
		return rtn
	}
	in := u.inputState(blockId)
	rtn.Agent, rtn.Mode, rtn.Modes, rtn.Draft = run.Agent, in.Mode, in.Modes, in.Draft
	return rtn
}

func refused(reason string, message string) AgentInputResult {
	return AgentInputResult{Result: InputRefused, Reason: reason, Message: message}
}

// AgentInput types one command of the agent's table, or says why it typed nothing.
func (u *Updater) AgentInput(ctx context.Context, req AgentInputRequest) AgentInputResult {
	if !u.begin(req.BlockId) {
		return refused(InputReasonBusy, "MoltenTerm is already typing in this terminal: try again in a moment.")
	}
	defer u.end(req.BlockId)
	expected := molten.AgentDisplayName(req.Agent)
	if expected == "" {
		expected = "the agent"
	}
	st, out := u.inspect(ctx, req.BlockId)
	if out != nil {
		return refused(InputReasonUnavailable, out.Message+" Nothing was typed.")
	}
	if st.adapter == nil {
		if st.busy != "" {
			rtn := refused(InputReasonNotForeground, fmt.Sprintf("%s is in the foreground of this terminal, not %s: nothing was typed.", st.busy, expected))
			rtn.Program = st.busy
			return rtn
		}
		return refused(InputReasonNoAgent, fmt.Sprintf("%s no longer runs in this terminal: nothing was typed.", expected))
	}
	agent, name := st.agent.Agent, st.adapter.Name()
	if req.Agent != "" && req.Agent != agent {
		rtn := refused(InputReasonNotForeground, fmt.Sprintf("%s is in the foreground of this terminal, not %s: nothing was typed.", name, expected))
		rtn.Program = name
		return rtn
	}
	base := func(r AgentInputResult) AgentInputResult {
		r.Agent, r.AgentName = agent, name
		return r
	}
	cmd, ok := agentcontinuity.FindAgentCommand(agent, req.Action)
	if !ok {
		return base(refused(InputReasonUnknownAction, fmt.Sprintf("%s has no command %q in MoltenTerm: nothing was typed.", name, req.Action)))
	}
	if blocker := u.foregroundBlocker(st.agent, st.shell.Pid); blocker != "" {
		r := refused(InputReasonNotForeground, fmt.Sprintf("%s is in the foreground of this terminal, not %s: nothing was typed.", blocker, name))
		if blocker == name {
			r.Message = fmt.Sprintf("%s is no longer the program in the foreground: nothing was typed.", name)
		}
		r.Program = blocker
		return base(r)
	}
	if run, ok := u.env.AgentRun(req.BlockId); ok && run.Running {
		switch {
		case run.State == molten.AgentStateWaiting:
			r := refused(InputReasonWaiting, fmt.Sprintf("%s is waiting for your answer: answer it first.", name))
			r.Offer = OfferGoto
			return base(r)
		case run.State == molten.AgentStateWorking && cmd.Kind != agentcontinuity.CommandInterrupt:
			r := refused(InputReasonWorking, fmt.Sprintf("%s is working: wait for its turn to end, or interrupt it.", name))
			r.Offer = OfferInterrupt
			return base(r)
		}
	}
	in := u.inputState(req.BlockId)
	if cmd.ClearsLine() && !req.ConfirmedDraft && in.Draft {
		return base(refused(InputReasonDraft, fmt.Sprintf("An unsent message in %s will be cleared.", name)))
	}
	if cmd.Kind == agentcontinuity.CommandMode {
		return base(u.stepMode(req, st, cmd, in.Mode, name))
	}
	text := cmd.Text
	steps := []string{text}
	shown := text
	switch {
	case cmd.Action == agentcontinuity.ActionQuit:
		text = st.adapter.Exit().Command
		steps, shown = []string{keyClearLine, text, "\r"}, text
	case cmd.Kind == agentcontinuity.CommandSlash:
		steps = []string{keyClearLine, text, "\r"}
	case cmd.Kind == agentcontinuity.CommandInterrupt:
		shown = "the interrupt key"
	}
	sent, err := u.sendToForegroundAgent(req.BlockId, st.agent, st.shell.Pid, steps)
	if err != nil {
		return base(refused(InputReasonUnavailable, fmt.Sprintf("The terminal did not take the input: %v", err)))
	}
	if !sent {
		return base(refused(InputReasonNotForeground, fmt.Sprintf("%s is no longer the program in the foreground: nothing was typed.", name)))
	}
	return base(AgentInputResult{Result: InputSent, Message: fmt.Sprintf("Sent %s to %s.", shown, name)})
}

// stepMode presses Shift+Tab until the agent shows the requested mode. Each press waits for the agent to draw its
// mode: a mode MoltenTerm cannot see stops the steps after one press (FR-SHELL-048-AC3).
func (u *Updater) stepMode(req AgentInputRequest, st shellState, cmd agentcontinuity.AgentCommand, current string, name string) AgentInputResult {
	target := req.Mode
	if target != "" && !slices.Contains(knownModes, target) {
		return refused(InputReasonUnknownAction, fmt.Sprintf("%s has no permission mode %q: nothing was typed.", name, target))
	}
	if target != "" && target == current {
		return AgentInputResult{Result: InputSent, Mode: current, Message: fmt.Sprintf("%s is already in %s mode.", name, modeLabel(current))}
	}
	steps := 1
	if target != "" && current != "" {
		steps = maxModePresses
	}
	prev := current
	presses := 0
	for presses < steps {
		if presses > 0 {
			if run, ok := u.env.AgentRun(req.BlockId); ok && run.Running && run.State != molten.AgentStateIdle && run.State != molten.AgentStateDone {
				break
			}
		}
		sent, err := u.sendToForegroundAgent(req.BlockId, st.agent, st.shell.Pid, []string{cmd.Text})
		if err != nil || !sent {
			if presses == 0 {
				return refused(InputReasonNotForeground, fmt.Sprintf("%s is no longer the program in the foreground: nothing was typed.", name))
			}
			break
		}
		presses++
		mode := u.waitModeChange(req.BlockId, prev)
		if mode == "" || mode == prev {
			prev = mode
			break
		}
		prev = mode
		if mode == target {
			break
		}
	}
	rtn := AgentInputResult{Result: InputSent, Mode: prev, Presses: presses}
	switch {
	case target != "" && prev == target:
		rtn.Message = fmt.Sprintf("%s is now in %s mode.", name, modeLabel(target))
	case prev == "":
		rtn.Message = fmt.Sprintf("Sent Shift+Tab once. MoltenTerm cannot see %s's mode, so each click moves one mode on.", name)
	case target != "":
		rtn.Message = fmt.Sprintf("%s shows %s mode: %s was not reached.", name, modeLabel(prev), modeLabel(target))
	default:
		rtn.Message = fmt.Sprintf("%s is now in %s mode.", name, modeLabel(prev))
	}
	return rtn
}

func (u *Updater) waitModeChange(blockId string, prev string) string {
	deadline := u.env.Now().Add(modeSettle)
	for {
		mode := u.inputState(blockId).Mode
		if mode != prev || !u.env.Now().Before(deadline) {
			return mode
		}
		u.env.Sleep(pollInterval)
	}
}

func modeLabel(mode string) string {
	if label, ok := modeLabels[mode]; ok {
		return label
	}
	return strings.TrimSpace(mode)
}

// foregroundBlocker names what keeps the agent from reading the keys now: a full-screen program it started, or, when
// its process ended or left the foreground, the agent's own name; "" when the agent reads them.
func (u *Updater) foregroundBlocker(agent molten.AgentProcess, shellPid int32) string {
	name := molten.AgentDisplayName(agent.Agent)
	if name == "" {
		name = "the agent"
	}
	table, err := u.env.ReadTable()
	if err != nil || table == nil || !table.Same(agent.Pid, agent.StartMs) || !inForeground(table, shellPid, agent.Pid) {
		return name
	}
	for _, p := range table.Descendants(agent.Pid) {
		if slices.Contains(terminalPrograms, filepath.Base(p.Name)) {
			return filepath.Base(p.Name)
		}
	}
	return ""
}

// sendToForegroundAgent types steps into the terminal only while the agent process is still the shell's foreground
// program; false: it is not, and nothing was typed. Shared by StopAgent and moltenagentinput, so both keep the same
// guarantee. Claude Code takes text followed at once by Enter for a paste: each step goes on its own.
func (u *Updater) sendToForegroundAgent(blockId string, agent molten.AgentProcess, shellPid int32, steps []string) (bool, error) {
	if u.foregroundBlocker(agent, shellPid) != "" {
		return false, nil
	}
	for _, step := range steps {
		if err := u.env.SendInput(blockId, []byte(step)); err != nil {
			return true, err
		}
		u.env.Sleep(exitEnterDelay)
	}
	return true, nil
}
