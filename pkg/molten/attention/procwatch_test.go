// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package attention

import (
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/proctree"
)

type procHarness struct {
	*agentHarness
	pw     *procWatcher
	lock   sync.Mutex
	procs  []proctree.Proc
	shells map[string]ShellProcess
	reads  int
	args   map[int32][]string
}

func makeProcHarness() *procHarness {
	h := &procHarness{agentHarness: makeAgentHarness(), shells: map[string]ShellProcess{}, args: map[int32][]string{}}
	h.pw = makeProcWatcher(h.states)
	h.states.procs = h.pw
	h.pw.now = func() time.Time { return h.clock }
	h.pw.readTable = func() (*proctree.Table, error) {
		h.lock.Lock()
		defer h.lock.Unlock()
		h.reads++
		return proctree.MakeTable(append([]proctree.Proc(nil), h.procs...)), nil
	}
	h.pw.readArgs = func(pid int32) (string, []string) {
		h.lock.Lock()
		defer h.lock.Unlock()
		args := h.args[pid]
		if len(args) == 0 {
			return "", nil
		}
		return args[0], args
	}
	h.pw.locator = ShellLocator{
		Locate: func(blockId string) (ShellProcess, bool) {
			h.lock.Lock()
			defer h.lock.Unlock()
			s, ok := h.shells[blockId]
			return s, ok
		},
		List: func() []ShellProcess {
			h.lock.Lock()
			defer h.lock.Unlock()
			var rtn []ShellProcess
			for _, s := range h.shells {
				rtn = append(rtn, s)
			}
			return rtn
		},
	}
	return h
}

func (h *procHarness) setProcs(procs ...proctree.Proc) {
	h.lock.Lock()
	defer h.lock.Unlock()
	h.procs = procs
}

func (h *procHarness) advance(d time.Duration) {
	h.clock = h.clock.Add(d)
	h.pw.pass()
}

func (h *procHarness) record(block string) (molten.AgentRunInfo, string, bool) {
	run, ok := h.states.runOf(block)
	return run, h.state(block), ok
}

func (h *procHarness) next(block string) time.Time {
	h.pw.lock.Lock()
	defer h.pw.lock.Unlock()
	if sw := h.pw.shells[block]; sw != nil {
		return sw.next
	}
	return time.Time{}
}

func shellProc(pid int32, fg int32) proctree.Proc {
	return proctree.Proc{Pid: pid, Ppid: 1, Pgid: pid, Tpgid: fg, Name: "zsh", StartMs: 1_000}
}

func childProc(pid int32, ppid int32, fg int32, name string, startMs int64) proctree.Proc {
	return proctree.Proc{Pid: pid, Ppid: ppid, Pgid: pid, Tpgid: fg, Name: name, StartMs: startMs}
}

// After a restart, an agent still running in a durable shell is found at once, idle until a signal; a shell at its
// prompt costs one look and nothing after.
func TestProcWatchRestoresAgents(t *testing.T) {
	h := makeProcHarness()
	agentStart := h.clock.Add(-time.Hour).UnixMilli()
	h.shells["b1"] = ShellProcess{BlockId: "b1", Pid: 100, StartMs: 1_000}
	h.shells["b2"] = ShellProcess{BlockId: "b2", Pid: 300, StartMs: 1_000}
	h.setProcs(shellProc(100, 200), childProc(200, 100, 200, "claude", agentStart), shellProc(300, 300))
	h.pw.restore()
	h.pw.pass()
	run, state, ok := h.record("b1")
	if !ok || run.Agent != "claude" || state != molten.AgentStateIdle || run.Started != agentStart || !run.Running {
		t.Fatalf("restored agent: %+v %q %v", run, state, ok)
	}
	if _, _, ok := h.record("b2"); ok {
		t.Error("a shell at its prompt runs no agent")
	}
	if !h.next("b2").IsZero() {
		t.Error("a shell at its prompt is not polled")
	}
	if h.next("b1").IsZero() {
		t.Error("a running agent is followed")
	}
	h.out("b1", "\x07")
	if got := h.state("b1"); got != molten.AgentStateWaiting {
		t.Errorf("a bell makes the restored agent wait: %q", got)
	}
	h.states.input("b1", []byte("\r"))
	if got := h.state("b1"); got != molten.AgentStateWorking {
		t.Errorf("Enter answers it: %q", got)
	}
	// The agent exits: the shell integration says so; without it, the next look does.
	h.setProcs(shellProc(100, 100), shellProc(300, 300))
	h.advance(procSlowPeriod)
	if _, _, ok := h.record("b1"); ok {
		t.Error("an agent gone from the tree is forgotten")
	}
	if !h.next("b1").IsZero() {
		t.Error("polling stops with the agent")
	}
}

// `clear; claude`, an agent behind a script, a node-based agent: found while the command runs.
func TestProcWatchFindsAgentsBehindCommands(t *testing.T) {
	h := makeProcHarness()
	h.shells["b1"] = ShellProcess{BlockId: "b1", Pid: 100, StartMs: 1_000}
	h.setProcs(shellProc(100, 100))
	h.out("b1", cmdMark("./start-agent.sh"))
	if _, _, ok := h.record("b1"); ok {
		t.Fatal("the command line names no agent")
	}
	if h.next("b1").IsZero() {
		t.Fatal("a running command is looked at")
	}
	// The wake-up right after the command's start looks at nothing yet; a first look before the process exists
	// (the shell still in the foreground) keeps following the command the shell integration announced.
	h.pw.pass()
	if h.reads != 0 {
		t.Fatalf("a pass ran before any terminal was due: %d reads", h.reads)
	}
	h.advance(procFirstDelay)
	if h.next("b1").IsZero() {
		t.Fatal("polling stopped before the command's process appeared")
	}
	h.clock = h.next("b1").Add(-procFirstDelay)
	start := h.clock.UnixMilli()
	h.setProcs(shellProc(100, 200), childProc(200, 100, 200, "bash", start),
		proctree.Proc{Pid: 210, Ppid: 200, Pgid: 200, Tpgid: 200, Name: "node", StartMs: start + 50})
	h.args[210] = []string{"/usr/local/bin/node", "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js"}
	h.advance(procFirstDelay)
	run, state, ok := h.record("b1")
	if !ok || run.Agent != "claude" || state != molten.AgentStateWorking || run.Started != start+50 {
		t.Fatalf("agent behind a script: %+v %q %v", run, state, ok)
	}
	h.out("b1", doneMark(0)+promptMark)
	if _, _, ok := h.record("b1"); ok {
		t.Error("the end of the command ends the agent")
	}
	if !h.next("b1").IsZero() {
		t.Error("no polling at the prompt")
	}

	// A command that is no agent: looked at less and less often, then not at all once it ends.
	h.out("b1", cmdMark("npm run dev"))
	h.setProcs(shellProc(100, 400), childProc(400, 100, 400, "npm", h.clock.UnixMilli()))
	var gaps []time.Duration
	last := h.clock
	for i := 0; i < 40; i++ {
		h.clock = h.next("b1")
		h.pw.pass()
		gaps = append(gaps, h.clock.Sub(last))
		last = h.clock
	}
	if gaps[0] != procFirstDelay || gaps[1] != procFastPeriod || gaps[len(gaps)-1] != procSlowPeriod {
		t.Errorf("schedule: %v", gaps)
	}
	h.out("b1", doneMark(0))
	if !h.next("b1").IsZero() {
		t.Error("no polling once the command ended")
	}
}

// Ten idle terminals: one read of the process table at startup, none after.
func TestProcWatchIdleTerminalsCostNothing(t *testing.T) {
	h := makeProcHarness()
	var procs []proctree.Proc
	for i := int32(0); i < 10; i++ {
		pid := 1000 + i
		block := string(rune('a' + i))
		h.shells[block] = ShellProcess{BlockId: block, Pid: pid}
		procs = append(procs, shellProc(pid, pid))
	}
	h.setProcs(procs...)
	h.pw.restore()
	h.pw.pass()
	for i := 0; i < 100; i++ {
		h.advance(time.Second)
	}
	if h.reads != 1 {
		t.Errorf("process table read %d times for idle terminals", h.reads)
	}
	if d := h.pw.nextDue(); d != 0 {
		t.Errorf("a pass is planned: %v", d)
	}
	for _, block := range []string{"a", "b", "c"} {
		h.out(block, "some output")
	}
	if h.next("a").IsZero() == false {
		t.Error("output from a known terminal plans no pass")
	}
}

// A hook names its agent: the process tree does not override it. A command line's guess gives way to the process.
func TestProcWatchSourcesPriority(t *testing.T) {
	h := makeProcHarness()
	h.shells["b1"] = ShellProcess{BlockId: "b1", Pid: 100}
	h.setProcs(shellProc(100, 200), childProc(200, 100, 200, "claude", h.clock.UnixMilli()))
	if err := h.report("b1", molten.AgentStateWorking, "my-agent"); err != nil {
		t.Fatal(err)
	}
	h.out("b1", cmdMark("my-agent"))
	h.advance(procFirstDelay)
	if run, _, _ := h.record("b1"); run.Agent != "claude" {
		// The command line names no agent: the record was cleared by the new command, the tree tells.
		t.Errorf("agent %q", run.Agent)
	}
	if err := h.report("b1", molten.AgentStateWorking, "my-agent"); err != nil {
		t.Fatal(err)
	}
	h.advance(procFastPeriod)
	if run, _, _ := h.record("b1"); run.Agent != "my-agent" {
		t.Errorf("a hook's agent is kept, got %q", run.Agent)
	}

	h2 := makeProcHarness()
	h2.shells["b1"] = ShellProcess{BlockId: "b1", Pid: 100}
	h2.setProcs(shellProc(100, 200), childProc(200, 100, 200, "codex", h2.clock.UnixMilli()))
	h2.out("b1", cmdMark("claude"))
	h2.advance(procFirstDelay)
	if run, state, _ := h2.record("b1"); run.Agent != "codex" || state != molten.AgentStateWorking {
		t.Errorf("the process running wins over the command line: %q %q", run.Agent, state)
	}
}

// A reused shell pid is another process; a pass that saw a command that has since ended applies nothing.
func TestProcWatchPidReuseAndRaces(t *testing.T) {
	h := makeProcHarness()
	h.shells["b1"] = ShellProcess{BlockId: "b1", Pid: 100, StartMs: 1_000}
	h.setProcs(shellProc(100, 200), childProc(200, 100, 200, "claude", h.clock.UnixMilli()))
	h.pw.restore()
	h.pw.pass()
	if _, _, ok := h.record("b1"); !ok {
		t.Fatal("agent not found")
	}
	reused := shellProc(100, 200)
	reused.StartMs = 900_000
	h.setProcs(reused, childProc(200, 100, 200, "claude", h.clock.UnixMilli()))
	h.advance(procSlowPeriod)
	if _, _, ok := h.record("b1"); ok {
		t.Error("the shell's pid now belongs to another process: the agent is gone")
	}

	h2 := makeProcHarness()
	h2.shells["b1"] = ShellProcess{BlockId: "b1", Pid: 100}
	h2.setProcs(shellProc(100, 200), childProc(200, 100, 200, "claude", h2.clock.UnixMilli()))
	h2.out("b1", cmdMark("./run"))
	h2.clock = h2.clock.Add(procFirstDelay)
	due := h2.pw.takeDue()
	table, _ := h2.pw.readTable()
	h2.out("b1", doneMark(0)+promptMark)
	for _, d := range due {
		h2.pw.look(d, table)
	}
	if _, _, ok := h2.record("b1"); ok {
		t.Error("a pass older than the command's end applied its agent")
	}
	h2.out("b1", cmdMark("./run"))
	h2.clock = h2.clock.Add(procFirstDelay)
	h2.pw.pass()
	if _, _, ok := h2.record("b1"); !ok {
		t.Fatal("agent not found")
	}
	h2.states.forget("b1")
	if _, ok := h2.pw.shells["b1"]; ok {
		t.Error("a closed block is forgotten by the watcher")
	}
}

// A block's command: the root process is the agent itself, found from its first output.
func TestProcWatchBlockCommand(t *testing.T) {
	h := makeProcHarness()
	h.shells["b1"] = ShellProcess{BlockId: "b1", Pid: 500, Command: true}
	h.setProcs(proctree.Proc{Pid: 500, Ppid: 1, Pgid: 500, Tpgid: 500, Name: "claude", StartMs: h.clock.UnixMilli()})
	h.out("b1", "Welcome")
	h.advance(procFirstDelay)
	run, state, ok := h.record("b1")
	if !ok || run.Agent != "claude" || state != molten.AgentStateWorking {
		t.Fatalf("block command: %+v %q %v", run, state, ok)
	}
	h.setProcs()
	h.advance(procSlowPeriod)
	if _, _, ok := h.record("b1"); ok {
		t.Error("the command ended")
	}
	// Restarted: its output again brings a look at the new process.
	h.shells["b1"] = ShellProcess{BlockId: "b1", Pid: 600, Command: true}
	h.setProcs(proctree.Proc{Pid: 600, Ppid: 1, Pgid: 600, Tpgid: 600, Name: "codex", StartMs: h.clock.UnixMilli()})
	h.out("b1", "again")
	h.advance(procFirstDelay)
	if run, _, _ := h.record("b1"); run.Agent != "codex" {
		t.Errorf("restarted block command: %q", run.Agent)
	}
}

func TestProcWatchUnsupported(t *testing.T) {
	h := makeProcHarness()
	h.pw.readTable = func() (*proctree.Table, error) { return nil, proctree.ErrUnsupported }
	h.shells["b1"] = ShellProcess{BlockId: "b1", Pid: 100}
	h.out("b1", cmdMark("./run"))
	h.advance(procFirstDelay)
	if !h.pw.off || h.pw.nextDue() != 0 {
		t.Error("the watcher stays idle where the process table cannot be read")
	}
	h.out("b1", cmdMark("claude"))
	if run, _, _ := h.record("b1"); run.Agent != "claude" {
		t.Error("the command line still names the agent")
	}
}

// Review findings: an agent's exit error survives a pass that saw it alive; a failed lookup does not lose a running
// agent; an agent whose child holds the terminal keeps its record; an unreadable process is read again.
func TestProcWatchReviewFindings(t *testing.T) {
	h := makeProcHarness()
	h.shells["b1"] = ShellProcess{BlockId: "b1", Pid: 100, StartMs: 1_000}
	h.setProcs(shellProc(100, 200), childProc(200, 100, 200, "claude", h.clock.UnixMilli()))
	h.out("b1", cmdMark("claude"))
	h.clock = h.clock.Add(procFirstDelay)
	due := h.pw.takeDue()
	table, _ := h.pw.readTable()
	h.out("b1", doneMark(1))
	for _, d := range due {
		h.pw.look(d, table)
	}
	if got := h.state("b1"); got != molten.AgentStateError {
		t.Errorf("the exit error survives a pass that saw the agent alive: %q", got)
	}

	h2 := makeProcHarness()
	h2.shells["b1"] = ShellProcess{BlockId: "b1", Pid: 100, StartMs: 1_000}
	h2.setProcs(shellProc(100, 200), childProc(200, 100, 200, "claude", h2.clock.Add(-time.Hour).UnixMilli()))
	h2.pw.restore()
	h2.pw.pass()
	run, _, ok := h2.record("b1")
	if !ok {
		t.Fatal("agent not restored")
	}
	h2.lock.Lock()
	delete(h2.shells, "b1")
	h2.lock.Unlock()
	h2.pw.lock.Lock()
	h2.pw.shells["b1"].relocate = true
	h2.pw.lock.Unlock()
	h2.advance(procSlowPeriod)
	if again, _, ok := h2.record("b1"); !ok || again.Started != run.Started {
		t.Errorf("a failed lookup lost the agent: %+v %v", again, ok)
	}

	// The agent runs an editor in its own group, holding the terminal: the agent stays, same run.
	h2.setProcs(shellProc(100, 300), childProc(200, 100, 300, "claude", run.Started), childProc(300, 200, 300, "vim", h2.clock.UnixMilli()))
	h2.procs[1].Pgid = 200
	h2.advance(procSlowPeriod)
	if again, _, ok := h2.record("b1"); !ok || again.Started != run.Started {
		t.Errorf("an agent whose child holds the terminal was dropped: %+v %v", again, ok)
	}

	h3 := makeProcHarness()
	h3.shells["b1"] = ShellProcess{BlockId: "b1", Pid: 100}
	h3.setProcs(shellProc(100, 200), proctree.Proc{Pid: 200, Ppid: 100, Pgid: 200, Tpgid: 200, Name: "node", StartMs: 77_777})
	h3.out("b1", cmdMark("./run"))
	h3.advance(procFirstDelay)
	if _, _, ok := h3.record("b1"); ok {
		t.Fatal("unreadable node taken for an agent")
	}
	h3.args[200] = []string{"/usr/bin/node", "/usr/lib/node_modules/@google/gemini-cli/dist/index.js"}
	h3.advance(procFastPeriod)
	if run, _, _ := h3.record("b1"); run.Agent != "gemini" {
		t.Errorf("a process unreadable once is read again: %q", run.Agent)
	}
}
