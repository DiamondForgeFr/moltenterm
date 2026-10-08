// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package keepawake

import (
	"context"
	"path/filepath"
	"strings"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// What counts as work (DS-SHELL-025, DS-SHELL-062): an agent in the working state (its subagents run inside its
// process, so it stays working until they finish), a foreground command that is not an idle shell, a block's own
// command while it runs, and a Mission Control run (build, release, sync, local CI) of the workspace's linked project.
// An agent waiting for input, done or idle is not work, and neither is a shell at its prompt. In a terminal whose agent
// is known, the agent's state decides: the agent's own process is the foreground command and would count forever.
// A remote terminal, and a local one whose foreground command is an SSH client, count only through a known agent
// state: what runs on the other side is not seen (developer's decision, 2026-10-08). The Until work ends policy counts
// local terminals only (its rule is about this computer's sessions); a coffee counts its workspace's remote agents too.

// BlockInfo is where a terminal block is and how it runs.
type BlockInfo struct {
	WorkspaceId string
	// Remote: an SSH connection (WSL and local shells are this computer).
	Remote bool
	// Cmd: a block's own command (meta cmd), for a cmd block.
	Cmd string
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
}

// Work is what runs now.
type Work struct {
	// Workspaces: those with work by the coffee's rule.
	Workspaces map[string]bool
	// Local: work by the Until work ends rule, in any workspace.
	Local bool
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
	candidates := map[string]bool{}
	for id, run := range agents {
		if run.State == molten.AgentStateWorking {
			candidates[id] = true
		}
	}
	for id := range commands {
		candidates[id] = true
	}
	for id := range cmdBlocks {
		candidates[id] = true
	}
	for blockId := range candidates {
		if src.Locate == nil {
			break
		}
		info, ok := src.Locate(ctx, blockId)
		if !ok || info.WorkspaceId == "" {
			continue
		}
		if !blockWorks(blockId, info, agents, commands, cmdBlocks) {
			continue
		}
		work.Workspaces[info.WorkspaceId] = true
		if !info.Remote {
			work.Local = true
		}
	}
	if src.MissionWorkspaces != nil {
		for _, wsId := range src.MissionWorkspaces(ctx) {
			if wsId != "" {
				work.Workspaces[wsId] = true
			}
			// A run with no linked workspace still runs on this computer.
			work.Local = true
		}
	}
	return work
}

func blockWorks(blockId string, info BlockInfo, agents map[string]molten.AgentRunInfo, commands map[string]string, cmdBlocks map[string]bool) bool {
	if run, ok := agents[blockId]; ok {
		return run.State == molten.AgentStateWorking
	}
	if info.Remote {
		return false
	}
	if cmdline, ok := commands[blockId]; ok {
		return !IsSshCommand(cmdline)
	}
	if cmdBlocks[blockId] {
		return !IsSshCommand(info.Cmd)
	}
	return false
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
