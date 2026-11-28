// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package attention

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agenthook"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// Background commands (#2140, FR-CONT-015). An agent may end its turn while a command it left running in the
// background goes on (Claude Code's run_in_background, "1 shell still running"), and resume by itself when the command
// ends: it does not wait for the developer. Like its background sub-agents (subagents.go), the pane then shows working,
// marked background, with the command's words or "N background commands running", and raises no notice.
//
// The set is what the agent reported, never a guess: a command counts from its report (agenthook/backgroundtask.go)
// until the session's transcript names its end (a task notification, or the TaskStop that stopped it, #2582), read when
// the main session's turn ends. Unlike a sub-agent, a command
// outlives the turn that started it, which is the point; one whose end is never told (an agent killed with its
// commands) is forgotten with the run, at the session's next start, or never tracked when the set is full.

// A service is the exception (#2583): a command that starts a program known to run until it is stopped (a dev server,
// a daemon, `tail -f`; pkg/molten/jobline) never ends by itself, so the agent never resumes on it. It is tracked like
// any command, for its end and to be named, but it is not work: the pane shows its own state (done, idle), the turn
// end raises its notice, and the services are only listed (AgentStateInfo.Services).

// commandEndOverlap: a transcript is read again from a little before where the last read stopped, so a task
// notification Claude Code was still writing then is read whole.
const commandEndOverlap = 4096

// maxServicesShown bounds the services a pane publishes.
const maxServicesShown = 16

// backgroundCommand is what a main session's report says of a command it left running: description, the words the
// agent gave it; service, whether it starts a program that runs until it is stopped; order, which it was among the
// pane's commands, for a stable list.
type backgroundCommand struct {
	description string
	service     bool
	order       int
}

// boundedCommands counts the commands that end by themselves: the work an agent resumes on.
func boundedCommands(rec *agentRecord) int {
	n := 0
	for _, c := range rec.commands {
		if !c.service {
			n++
		}
	}
	return n
}

// serviceWords lists the pane's services in the order they started: the words each was given, "" for none.
func serviceWords(rec *agentRecord) []string {
	var services []backgroundCommand
	for _, c := range rec.commands {
		if c.service {
			services = append(services, c)
		}
	}
	if len(services) == 0 {
		return nil
	}
	slices.SortFunc(services, func(a, b backgroundCommand) int { return a.order - b.order })
	services = services[:min(len(services), maxServicesShown)]
	words := make([]string, len(services))
	for i, c := range services {
		words[i] = c.description
	}
	return words
}

// commandEnds is what a turn end read of a pane's transcript: the commands that ended and how far it read.
type commandEnds struct {
	path   string
	offset int64
	ended  []string
}

// transcriptSize is the size of a session's transcript, -1 for a path that is not one.
func transcriptSize(path string) int64 {
	if !validTranscript(path) {
		return -1
	}
	fi, err := os.Stat(path)
	if err != nil || !fi.Mode().IsRegular() {
		return -1
	}
	return fi.Size()
}

// validTranscript: only an agent's JSON Lines transcript is read, from an absolute path.
func validTranscript(path string) bool {
	return path != "" && filepath.IsAbs(path) && strings.HasSuffix(path, ".jsonl")
}

// commandEnds reads, for a main session's turn end, which of the pane's background commands the transcript says
// ended. The file is read without the states' lock; the result is applied under it (applyCommandEndsLocked).
func (a *agentStates) commandEnds(req molten.AgentStateRequest) *commandEnds {
	if req.Subagent != "" || req.TurnEnd || !subagentsTurnEnd(req.State) || !validTranscript(req.Transcript) {
		return nil
	}
	ids, offset := a.trackedCommands(req.BlockId, req.Transcript)
	if len(ids) == 0 {
		return nil
	}
	f, err := os.Open(req.Transcript)
	if err != nil {
		return nil
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() {
		return nil
	}
	size := fi.Size()
	if offset > size {
		offset = 0
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return nil
	}
	ended := agenthook.TaskNotificationEnds(io.LimitReader(f, size-offset), ids)
	return &commandEnds{path: req.Transcript, offset: max(offset, size-commandEndOverlap), ended: ended}
}

// trackedCommands: the pane's background commands and where its transcript is read from (0 for another transcript).
func (a *agentStates) trackedCommands(blockId string, path string) ([]string, int64) {
	a.lock.Lock()
	defer a.lock.Unlock()
	rec := a.records[blockId]
	if rec == nil || len(rec.commands) == 0 {
		return nil, 0
	}
	ids := make([]string, 0, len(rec.commands))
	for id := range rec.commands {
		ids = append(ids, id)
	}
	if rec.commandsTranscript != path {
		return ids, 0
	}
	return ids, rec.commandsOffset
}

// backgroundCommandLocked tracks the command a main session's report says it left running. startSize: its
// transcript's size then (transcriptSize), where its end may be told from.
func (a *agentStates) backgroundCommandLocked(blockId string, rec *agentRecord, req molten.AgentStateRequest, startSize int64) {
	id := req.BackgroundTask
	if id == "" || len(id) > agenthook.BackgroundTaskIdMaxLength || len(rec.commands) >= maxTrackedSubagents {
		return
	}
	if _, known := rec.commands[id]; known {
		return
	}
	if rec.commands == nil {
		rec.commands = map[string]backgroundCommand{}
	}
	if len(rec.commands) == 0 || rec.commandsTranscript != req.Transcript {
		rec.commandsTranscript = req.Transcript
		rec.commandsOffset = max(startSize, 0)
	}
	rec.commands[id] = backgroundCommand{description: molten.CleanAgentMessage(req.BackgroundDescription), service: req.BackgroundService, order: rec.commandsStarted}
	rec.commandsStarted++
	a.markDirtyLocked(blockId)
}

// applyCommandEndsLocked forgets the commands a turn end read the end of; released: the last command that ends by
// itself went, so the pane gives its turn end back to the developer (the user's own `molten agent state done` may have
// reported it first). A service that ends releases nothing: it never held the turn.
func (a *agentStates) applyCommandEndsLocked(blockId string, rec *agentRecord, ends *commandEnds) (released bool) {
	if ends == nil || rec.commandsTranscript != ends.path {
		return false
	}
	rec.commandsOffset = max(rec.commandsOffset, ends.offset)
	for _, id := range ends.ended {
		command, known := rec.commands[id]
		if !known {
			continue
		}
		delete(rec.commands, id)
		released = released || !command.service
		a.markDirtyLocked(blockId)
	}
	return released && boundedCommands(rec) == 0
}

func (a *agentStates) forgetCommandsLocked(blockId string, rec *agentRecord) {
	rec.commandsTranscript, rec.commandsOffset, rec.commandsStarted = "", 0, 0
	if len(rec.commands) == 0 {
		return
	}
	rec.commands = nil
	a.markDirtyLocked(blockId)
}

// backgroundDoneSignal tells whether a terminal's own "done" signal comes from an agent that waits for its background
// commands: no notice, as for its hook's Stop. A service is not waited for.
func (a *agentStates) backgroundDoneSignal(blockId string, signal AttentionSignal) bool {
	a.lock.Lock()
	defer a.lock.Unlock()
	rec := a.records[blockId]
	return rec != nil && rec.running && boundedCommands(rec) > 0 && molten.AttentionAgentState(signal.Title, signal.Message) == molten.AgentStateDone
}

// commandsMessage words a pane's background commands that end by themselves: the command's own words when one runs
// and has some. The services are not work, they are listed apart (serviceWords).
func commandsMessage(rec *agentRecord, info *molten.AgentStateInfo) {
	n := boundedCommands(rec)
	if n > 1 {
		info.Message, info.MessageText = fmt.Sprintf("%d background commands running", n), uimsg.Make("agentState.backgroundCommands", "count", strconv.Itoa(n))
		return
	}
	for _, c := range rec.commands {
		if !c.service && c.description != "" {
			info.Message, info.MessageText = "In the background: "+c.description, uimsg.Make("agentState.backgroundCommandNamed", "description", c.description)
			return
		}
	}
	info.Message, info.MessageText = "1 background command running", uimsg.Make("agentState.backgroundCommand")
}
