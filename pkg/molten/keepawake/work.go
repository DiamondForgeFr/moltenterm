// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package keepawake

import (
	"context"
	"fmt"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// What counts as work (DS-SHELL-025, DS-SHELL-062): an agent in the working state, an agent in any other state whose
// process tree is busy (busy.go), a foreground command that is not an idle shell, a block's own command while it runs,
// and a Mission Control run (build, release, sync, local CI) of the workspace's linked project. An agent's turn can end
// while work it started goes on: background subagents and background commands run in processes of their own, and the
// agent reports done meanwhile (#493). Its process tree tells: it stays busy while that work runs. An agent waiting
// for input, done or idle with a quiet tree is not work, and neither is a shell at its prompt. In a terminal whose
// agent is known, the agent decides: the agent's own process is the foreground command and would count forever.
// A remote terminal, and a local one whose foreground command is an SSH client, count only through a known agent
// state: what runs on the other side is not seen (developer's decision, 2026-10-08). The Until work ends policy counts
// local terminals only (its rule is about this computer's sessions); a coffee counts its workspace's remote agents too.

// The reasons, by the order the list shows them.
const (
	reasonAgentWorking = iota
	reasonAgentBackground
	reasonCommand
	reasonMission
)

const (
	// A workspace's reasons shown at most; the last one kept says how many more there are.
	maxReasons      = 4
	maxReasonCmdLen = 60
	missionReason   = "Mission Control run"
)

// BlockInfo is where a terminal block is and how it runs.
type BlockInfo struct {
	WorkspaceId string
	// Remote: an SSH connection (WSL and local shells are this computer).
	Remote bool
	// Cmd: a block's own command (meta cmd), for a cmd block.
	Cmd string
	// Review: the terminal of a review session (FR-REV-004), whose requests coffee mode never answers.
	Review bool
}

// WorkSources are what the rule reads, injected so tests need no wavesrv.
type WorkSources struct {
	Agents func() []molten.AgentRunInfo
	// Commands: the blocks whose shell runs a command now, with its command line (shell integration marks).
	Commands func() map[string]string
	// CommandBlocks: the cmd blocks whose command runs now.
	CommandBlocks func() []string
	// ShellRunning: the block's shell still runs. A shell that exits during a command (`exit`, `exec`, a kill) never
	// says the command ended; its block stays open, "shell terminated". Nil: every shell is taken as running.
	ShellRunning func(blockId string) bool
	Locate       func(ctx context.Context, blockId string) (BlockInfo, bool)
	// MissionWorkspaces: the workspaces linked to a project with a Mission Control run going.
	MissionWorkspaces func(ctx context.Context) []string
	// BusyTrees: which of these agents' process trees are busy (busy.go). Nil: background work is not seen.
	BusyTrees func(roots []TreeRoot) map[string]bool
}

// Work is what runs now.
type Work struct {
	// Workspaces: those with work by the coffee's rule.
	Workspaces map[string]bool
	// Local: work by the Until work ends rule, in any workspace.
	Local bool
	// Reasons: what the work is, per workspace and for Local, the most telling first (the status bar list says why
	// the computer is kept awake).
	Reasons      map[string][]string
	LocalReasons []string
}

type reason struct {
	rank int
	text string
}

const (
	agentWorkingSuffix    = ": working"
	agentBackgroundSuffix = ": background work"
	anyCommandReason      = "A command"
	commandReasonPrefix   = "Command: "
	moreReasonFormat      = "%d more"
)

func agentReason(agent string, rank int) reason {
	if rank == reasonAgentBackground {
		return reason{rank: rank, text: molten.AgentDisplayName(agent) + agentBackgroundSuffix}
	}
	return reason{rank: rank, text: molten.AgentDisplayName(agent) + agentWorkingSuffix}
}

func commandReason(cmdline string) reason {
	cmd := strings.Join(strings.Fields(cmdline), " ")
	if cmd == "" {
		return reason{rank: reasonCommand, text: anyCommandReason}
	}
	if len([]rune(cmd)) > maxReasonCmdLen {
		cmd = string([]rune(cmd)[:maxReasonCmdLen-1]) + "…"
	}
	return reason{rank: reasonCommand, text: commandReasonPrefix + cmd}
}

// reasonsText is the codes of reasons sortReasons kept, for the windows (#656), by position. Each reason is one of
// the forms this file writes, so it is read back here rather than carried through the sort.
func reasonsText(reasons []string) []*uimsg.Text {
	if len(reasons) == 0 {
		return nil
	}
	rtn := make([]*uimsg.Text, len(reasons))
	for i, r := range reasons {
		var more int
		switch {
		case r == missionReason:
			rtn[i] = uimsg.Make("keepawake.why.mission")
		case r == anyCommandReason:
			rtn[i] = uimsg.Make("keepawake.why.anycommand")
		case strings.HasPrefix(r, commandReasonPrefix):
			rtn[i] = uimsg.Make("keepawake.why.command", "command", strings.TrimPrefix(r, commandReasonPrefix))
		case strings.HasSuffix(r, agentWorkingSuffix):
			rtn[i] = uimsg.Make("keepawake.why.working", "agent", strings.TrimSuffix(r, agentWorkingSuffix))
		case strings.HasSuffix(r, agentBackgroundSuffix):
			rtn[i] = uimsg.Make("keepawake.why.background", "agent", strings.TrimSuffix(r, agentBackgroundSuffix))
		default:
			if _, err := fmt.Sscanf(r, moreReasonFormat, &more); err == nil && fmt.Sprintf(moreReasonFormat, more) == r {
				rtn[i] = uimsg.Make("keepawake.why.more", "count", strconv.Itoa(more))
			}
		}
	}
	return rtn
}

// sortReasons orders reasons by rank then text, without repeats, and keeps maxReasons of them; the last one kept
// says how many are left out.
func sortReasons(list []reason) []string {
	if len(list) == 0 {
		return nil
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].rank != list[j].rank {
			return list[i].rank < list[j].rank
		}
		return list[i].text < list[j].text
	})
	var rtn []string
	for _, r := range list {
		if len(rtn) > 0 && rtn[len(rtn)-1] == r.text {
			continue
		}
		rtn = append(rtn, r.text)
	}
	if len(rtn) > maxReasons {
		rtn = append(rtn[:maxReasons-1], fmt.Sprintf(moreReasonFormat, len(rtn)-maxReasons+1))
	}
	return rtn
}

// sshClients are the programs whose foreground session runs on another machine.
var sshClients = map[string]bool{"ssh": true, "autossh": true, "mosh": true, "mosh-client": true, "et": true}

// The prefixes that keep the program in the foreground, with their options that take a value.
var commandPrefixes = map[string]map[string]bool{
	"exec":    {"-a": true},
	"command": {},
	"nohup":   {},
	"env":     {"-u": true, "-C": true, "-S": true},
	"sudo":    {"-u": true, "-g": true, "-h": true, "-p": true, "-C": true, "-D": true, "-r": true, "-t": true, "-U": true},
}

// IsSshCommand tells a command line that opens a session on another machine.
func IsSshCommand(cmdline string) bool {
	fields := strings.Fields(cmdline)
	var prefixOptions map[string]bool
	for len(fields) > 0 {
		word := fields[0]
		fields = fields[1:]
		if prefixOptions != nil && strings.HasPrefix(word, "-") {
			if prefixOptions[word] && len(fields) > 0 {
				fields = fields[1:]
			}
			continue
		}
		// Environment assignments come before the program.
		if strings.Contains(word, "=") && !strings.HasPrefix(word, "=") {
			continue
		}
		if options, ok := commandPrefixes[word]; ok {
			prefixOptions = options
			continue
		}
		return sshClients[filepath.Base(word)]
	}
	return false
}

// ComputeWork applies the rule to every terminal with something running and to Mission Control's runs.
func ComputeWork(ctx context.Context, src WorkSources) Work {
	work := Work{Workspaces: map[string]bool{}}
	agents := map[string]molten.AgentRunInfo{}
	if src.Agents != nil {
		for _, run := range src.Agents() {
			if run.Running {
				agents[run.BlockId] = run
			}
		}
	}
	commands := map[string]string{}
	if src.Commands != nil {
		for blockId, cmdline := range src.Commands() {
			if src.ShellRunning == nil || src.ShellRunning(blockId) {
				commands[blockId] = cmdline
			}
		}
	}
	cmdBlocks := map[string]bool{}
	if src.CommandBlocks != nil {
		for _, id := range src.CommandBlocks() {
			cmdBlocks[id] = true
		}
	}
	// Only the trees of agents that are not working are sampled: a working agent is work already. Asking with no root
	// lets the tracker forget the trees it followed.
	var roots []TreeRoot
	for id, run := range agents {
		if run.State != molten.AgentStateWorking && run.Pid > 0 {
			roots = append(roots, TreeRoot{BlockId: id, Pid: run.Pid, StartMs: run.PidStartMs})
		}
	}
	var busy map[string]bool
	if src.BusyTrees != nil {
		busy = src.BusyTrees(roots)
	}
	candidates := map[string]bool{}
	for id, run := range agents {
		if run.State == molten.AgentStateWorking || busy[id] {
			candidates[id] = true
		}
	}
	for id := range commands {
		candidates[id] = true
	}
	for id := range cmdBlocks {
		candidates[id] = true
	}
	reasons := map[string][]reason{}
	var localReasons []reason
	for blockId := range candidates {
		if src.Locate == nil {
			break
		}
		info, ok := src.Locate(ctx, blockId)
		if !ok || info.WorkspaceId == "" {
			continue
		}
		why, works := blockWork(blockId, info, agents, commands, cmdBlocks, busy)
		if !works {
			continue
		}
		work.Workspaces[info.WorkspaceId] = true
		reasons[info.WorkspaceId] = append(reasons[info.WorkspaceId], why)
		if !info.Remote {
			work.Local = true
			localReasons = append(localReasons, why)
		}
	}
	if src.MissionWorkspaces != nil {
		for _, wsId := range src.MissionWorkspaces(ctx) {
			mission := reason{rank: reasonMission, text: missionReason}
			if wsId != "" {
				work.Workspaces[wsId] = true
				reasons[wsId] = append(reasons[wsId], mission)
			}
			// A run with no linked workspace still runs on this computer.
			work.Local = true
			localReasons = append(localReasons, mission)
		}
	}
	if len(reasons) > 0 {
		work.Reasons = make(map[string][]string, len(reasons))
		for wsId, list := range reasons {
			work.Reasons[wsId] = sortReasons(list)
		}
	}
	work.LocalReasons = sortReasons(localReasons)
	return work
}

// blockWork tells whether a terminal works now, and what its work is.
func blockWork(blockId string, info BlockInfo, agents map[string]molten.AgentRunInfo, commands map[string]string, cmdBlocks map[string]bool, busy map[string]bool) (reason, bool) {
	if run, ok := agents[blockId]; ok {
		if run.State == molten.AgentStateWorking {
			return agentReason(run.Agent, reasonAgentWorking), true
		}
		// Only a local agent's process is known (procwatch): a remote one counts through its state alone.
		if busy[blockId] {
			return agentReason(run.Agent, reasonAgentBackground), true
		}
		return reason{}, false
	}
	if info.Remote {
		return reason{}, false
	}
	if cmdline, ok := commands[blockId]; ok {
		return commandReason(cmdline), !IsSshCommand(cmdline)
	}
	if cmdBlocks[blockId] {
		return commandReason(info.Cmd), !IsSshCommand(info.Cmd)
	}
	return reason{}, false
}

// commandTracker follows the shell integration's marks: a command runs from its start mark until its end mark or the
// next prompt. A shell without the integration never says, so its commands are not seen.
type commandTracker struct {
	lock    sync.Mutex
	running map[string]string
}

func makeCommandTracker() *commandTracker {
	return &commandTracker{running: map[string]string{}}
}

// Mark kinds of the shell integration (attention.ShellMarkCommand, ShellMarkDone, ShellMarkPrompt).
const (
	markCommand = "C"
	markDone    = "D"
	markPrompt  = "A"
)

// observe runs on the terminal output path: it only updates the map.
func (t *commandTracker) observe(blockId string, kind string, cmd string) {
	t.lock.Lock()
	defer t.lock.Unlock()
	switch kind {
	case markCommand:
		t.running[blockId] = cmd
	case markDone, markPrompt:
		delete(t.running, blockId)
	}
}

func (t *commandTracker) forget(blockId string) {
	t.lock.Lock()
	defer t.lock.Unlock()
	delete(t.running, blockId)
}

func (t *commandTracker) snapshot() map[string]string {
	t.lock.Lock()
	defer t.lock.Unlock()
	rtn := make(map[string]string, len(t.running))
	for k, v := range t.running {
		rtn[k] = v
	}
	return rtn
}
