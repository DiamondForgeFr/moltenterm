// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package attention

import (
	"context"
	"errors"
	"log"
	"sync"
	"time"

	goproc "github.com/shirou/gopsutil/v4/process"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/proctree"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// Agents from the process tree (FR-SHELL-011): the agent states also learn which coding agent a local terminal runs
// from the processes in its foreground, so an agent started before a restart of MoltenTerm (a durable shell, #72),
// behind another command (`clear; claude`) or as a block's command is known too. The process table is read once per
// pass for every terminal due, and only while a command runs: a terminal at its prompt costs nothing. Only process
// metadata is read (names, groups, the executable and arguments of a candidate), never the screen.

const (
	// The first pass after a command starts, when the agent's process exists.
	procFirstDelay = 300 * time.Millisecond
	procFastPeriod = time.Second
	procFastFor    = 5 * time.Second
	procMidPeriod  = 2 * time.Second
	procMidFor     = 30 * time.Second
	procSlowPeriod = 5 * time.Second
	// Terminals due within this window share the pass that runs now.
	procCoalesce = time.Second
	procReadArgs = 2 * time.Second
	// A block's command that is not running looks again on its output at most this often.
	procProbeEvery = 5 * time.Second
)

// ShellProcess is the local process of a terminal: its shell, or a block's own command.
type ShellProcess struct {
	BlockId string
	Pid     int32
	// StartMs: when the process started (Unix milliseconds; 0 when unknown), to tell a reused pid apart.
	StartMs int64
	// Command: a block's command rather than an interactive shell: it runs as long as it lives.
	Command bool
}

// ShellLocator finds terminals' local processes; blockcontroller provides it (remote and WSL terminals have none).
type ShellLocator struct {
	Locate func(blockId string) (ShellProcess, bool)
	List   func() []ShellProcess
}

type shellWatch struct {
	shell   ShellProcess
	located bool
	// relocate: look the process up again before the next pass (a command started: the block may have restarted).
	relocate bool
	running  bool
	since    time.Time
	// next: when the next pass is due (zero: none).
	next time.Time
	// marked: the shell integration said a command started; it runs until the integration says it ended.
	marked bool
	found  bool
	// agent: the agent process last found, kept while it lives under the shell (it may hand the terminal to a
	// child of its own, an editor, for a while).
	agent molten.AgentProcess
	// probed: the last look a block command's output asked for.
	probed time.Time
	// gen changes with every command start and end: a pass that saw an older one does not apply what it saw.
	gen int64
}

type procWatcher struct {
	lock   sync.Mutex
	shells map[string]*shellWatch
	wake   chan struct{}
	// off: the process table cannot be read here; the watcher stays idle.
	off bool

	now       func() time.Time
	readTable func() (*proctree.Table, error)
	readArgs  func(pid int32) (string, []string)
	locator   ShellLocator
	agents    *agentStates
}

func makeProcWatcher(agents *agentStates) *procWatcher {
	return &procWatcher{
		shells:    map[string]*shellWatch{},
		wake:      make(chan struct{}, 1),
		now:       time.Now,
		readTable: proctree.Read,
		readArgs:  readProcessArgs,
		agents:    agents,
	}
}

// The executable comes from proctree: gopsutil hands libproc a buffer on the goroutine's stack on macOS (#249).
func readProcessArgs(pid int32) (string, []string) {
	ctx, cancel := context.WithTimeout(context.Background(), procReadArgs)
	defer cancel()
	args, _ := (&goproc.Process{Pid: pid}).CmdlineSliceWithContext(ctx)
	return proctree.Exe(pid), args
}

func (w *procWatcher) poke() {
	select {
	case w.wake <- struct{}{}:
	default:
	}
}

// period is how often a running command is looked at: often just after it starts, rarely once it lasts.
func procPeriod(elapsed time.Duration) time.Duration {
	switch {
	case elapsed < procFastFor:
		return procFastPeriod
	case elapsed < procMidFor:
		return procMidPeriod
	}
	return procSlowPeriod
}

func (w *procWatcher) getLocked(blockId string) *shellWatch {
	sw := w.shells[blockId]
	if sw == nil {
		sw = &shellWatch{shell: ShellProcess{BlockId: blockId}, relocate: true}
		w.shells[blockId] = sw
	}
	return sw
}

// shellMark follows the shell integration: a command starts (look for its agent), ends or the prompt is back (stop).
// applyMark updates the agent states under the watcher's lock, so a pass cannot apply what it saw between the mark's
// effect on the states and its own (lock order: watcher, then agent states).
func (w *procWatcher) shellMark(blockId string, kind string, applyMark func()) {
	w.lock.Lock()
	defer w.lock.Unlock()
	applyMark()
	if w.off {
		return
	}
	switch kind {
	case ShellMarkCommand:
		sw := w.getLocked(blockId)
		now := w.now()
		sw.relocate = true
		sw.gen++
		sw.running, sw.since, sw.marked = true, now, true
		sw.next = now.Add(procFirstDelay)
		w.poke()
	case ShellMarkDone, ShellMarkPrompt:
		sw := w.shells[blockId]
		if sw == nil || sw.shell.Command {
			return
		}
		sw.gen++
		sw.running, sw.next, sw.found, sw.marked = false, time.Time{}, false, false
		sw.agent = molten.AgentProcess{}
	}
}

// seen is called for every output of a terminal: a terminal not known yet is looked at once (a block's command, a
// terminal created since the start).
func (w *procWatcher) seen(blockId string) {
	w.lock.Lock()
	defer w.lock.Unlock()
	if w.off {
		return
	}
	sw := w.shells[blockId]
	now := w.now()
	// A block's command that ended and prints again was restarted: look at its new process (not on every output).
	restarted := sw != nil && sw.shell.Command && sw.next.IsZero() && now.Sub(sw.probed) >= procProbeEvery
	if sw != nil && !restarted {
		return
	}
	sw = w.getLocked(blockId)
	sw.probed = now
	sw.relocate = true
	sw.gen++
	sw.running, sw.since, sw.marked = true, now, false
	sw.next = now.Add(procFirstDelay)
	w.poke()
}

func (w *procWatcher) forget(blockId string) {
	w.lock.Lock()
	defer w.lock.Unlock()
	delete(w.shells, blockId)
}

// restore looks at every live local terminal once, at startup: their agents survived the restart.
func (w *procWatcher) restore() {
	if w.locator.List == nil {
		return
	}
	list := w.locator.List()
	w.lock.Lock()
	defer w.lock.Unlock()
	now := w.now()
	for _, shell := range list {
		if w.shells[shell.BlockId] != nil {
			continue
		}
		w.shells[shell.BlockId] = &shellWatch{shell: shell, located: true, running: true, since: now, next: now}
	}
	w.poke()
}

type procDue struct {
	blockId  string
	shell    ShellProcess
	located  bool
	relocate bool
	gen      int64
	agent    molten.AgentProcess
}

// takeDue lists the terminals to look at now: nothing before one is due, then also those due within procCoalesce.
func (w *procWatcher) takeDue() []procDue {
	w.lock.Lock()
	defer w.lock.Unlock()
	now := w.now()
	anyDue := false
	for _, sw := range w.shells {
		if !sw.next.IsZero() && !sw.next.After(now) {
			anyDue = true
			break
		}
	}
	if !anyDue {
		return nil
	}
	limit := now.Add(procCoalesce)
	var rtn []procDue
	for blockId, sw := range w.shells {
		if sw.next.IsZero() || sw.next.After(limit) {
			continue
		}
		rtn = append(rtn, procDue{blockId: blockId, shell: sw.shell, located: sw.located, relocate: sw.relocate, gen: sw.gen, agent: sw.agent})
	}
	return rtn
}

// nextDue is how long the loop may sleep (0: nothing to do until a command starts).
func (w *procWatcher) nextDue() time.Duration {
	w.lock.Lock()
	defer w.lock.Unlock()
	var first time.Time
	for _, sw := range w.shells {
		if sw.next.IsZero() {
			continue
		}
		if first.IsZero() || sw.next.Before(first) {
			first = sw.next
		}
	}
	if first.IsZero() {
		return 0
	}
	d := first.Sub(w.now())
	if d < time.Millisecond {
		d = time.Millisecond
	}
	return d
}

func (w *procWatcher) setOff() {
	w.lock.Lock()
	defer w.lock.Unlock()
	w.off = true
	w.shells = map[string]*shellWatch{}
}

// pass looks at the terminals due, with one read of the process table.
func (w *procWatcher) pass() {
	due := w.takeDue()
	if len(due) == 0 {
		return
	}
	for i := range due {
		if !due[i].relocate && due[i].located {
			continue
		}
		shell, ok := ShellProcess{}, false
		if w.locator.Locate != nil {
			shell, ok = w.locator.Locate(due[i].blockId)
		}
		if !ok && due[i].located {
			// A failed lookup (a slow store) keeps the known process: the table tells whether it still lives.
			continue
		}
		due[i].shell, due[i].located = shell, ok
		due[i].shell.BlockId = due[i].blockId
	}
	anyLocated := false
	for _, d := range due {
		anyLocated = anyLocated || d.located
	}
	if !anyLocated {
		// Remote and WSL terminals: nothing local to read.
		for _, d := range due {
			w.apply(d, false, false, false, molten.AgentProcess{}, false)
		}
		return
	}
	table, err := w.readTable()
	if errors.Is(err, proctree.ErrUnsupported) {
		w.setOff()
		return
	}
	if err != nil {
		log.Printf("molten: process table not read: %v\n", err)
		table = nil
	}
	for _, d := range due {
		w.look(d, table)
	}
}

func (w *procWatcher) look(d procDue, table *proctree.Table) {
	alive := table != nil && d.located && table.Same(d.shell.Pid, d.shell.StartMs)
	var found molten.AgentProcess
	ok := false
	running := false
	if alive {
		if d.shell.StartMs <= 0 {
			// A controller's shell has no recorded start: the first look pins it, so a reused pid is told apart.
			d.shell.StartMs = table.Get(d.shell.Pid).StartMs
		}
		found, ok = molten.FindAgentProcess(table.Foreground(d.shell.Pid), w.readArgs)
		if !ok && d.agent.Pid != 0 && table.Same(d.agent.Pid, d.agent.StartMs) && table.Under(d.agent.Pid, d.shell.Pid) {
			// The agent handed the terminal to a child (an editor): it still runs.
			found, ok = d.agent, true
		}
		running = d.shell.Command || table.Running(d.shell.Pid)
	}
	w.apply(d, table != nil && d.located, alive, running, found, ok)
}

// apply records a pass's outcome in the agent states and plans the next pass. It runs under the watcher's lock, so a
// command's start or end cannot slip between the check and the record (lock order: watcher, then agent states).
func (w *procWatcher) apply(d procDue, read bool, alive bool, running bool, agent molten.AgentProcess, found bool) {
	w.lock.Lock()
	defer w.lock.Unlock()
	sw := w.shells[d.blockId]
	if sw == nil || sw.gen != d.gen {
		return
	}
	sw.shell, sw.located = d.shell, d.located
	sw.relocate = false
	sw.found = found
	sw.agent = molten.AgentProcess{}
	if found {
		sw.agent = agent
	}
	now := w.now()
	switch {
	case !alive:
		// No local process (a remote terminal, a shell gone): nothing to follow until the next command.
		sw.next = time.Time{}
		sw.running = false
	case !sw.running:
		// The command ended while this pass ran.
		sw.next = time.Time{}
	case !running && !found && !sw.marked:
		// At its prompt: nothing runs (a terminal looked at at startup or on its first output). A command the shell
		// integration announced is followed until its end, even when its process is not there yet.
		sw.next = time.Time{}
		sw.running = false
	default:
		sw.next = now.Add(procPeriod(now.Sub(sw.since)))
	}
	if read {
		w.agents.processAgent(d.blockId, agent, found)
	}
}

func (w *procWatcher) run() {
	defer func() {
		panichandler.PanicHandler("molten:procWatcher", recover())
	}()
	w.restore()
	timer := time.NewTimer(time.Hour)
	defer timer.Stop()
	for {
		w.pass()
		wait := w.nextDue()
		if wait == 0 {
			wait = time.Hour
		}
		// Since Go 1.23, Reset drops a pending expiry: no drain needed.
		timer.Reset(wait)
		select {
		case <-w.wake:
		case <-timer.C:
		}
	}
}

var shellLocatorLock sync.Mutex
var shellLocator ShellLocator

// SetShellLocator tells the agent states how to find terminals' local processes (blockcontroller, at init).
func SetShellLocator(l ShellLocator) {
	shellLocatorLock.Lock()
	defer shellLocatorLock.Unlock()
	shellLocator = l
}

func getShellLocator() ShellLocator {
	shellLocatorLock.Lock()
	defer shellLocatorLock.Unlock()
	return shellLocator
}
