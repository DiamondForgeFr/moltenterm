// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package keepawake

import (
	"context"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/proctree"
)

const (
	agentPid   = 100
	agentStart = 900_000
	mcpPid     = 110
	shellPid   = 120
	buildPid   = 130
)

// fakeTrees is an injected TreeSampler: each block's tree, changed by the test between samples.
type fakeTrees struct {
	trees map[string]TreeSample
	calls int
	asked [][]TreeRoot
}

func (f *fakeTrees) sample(roots []TreeRoot) map[string]TreeSample {
	f.calls++
	f.asked = append(f.asked, roots)
	rtn := map[string]TreeSample{}
	for _, r := range roots {
		tree := f.trees[r.BlockId]
		root, ok := tree[r.Pid]
		if !ok || !sameStart(root.StartMs, r.StartMs) {
			continue
		}
		copied := TreeSample{}
		for pid, p := range tree {
			copied[pid] = p
		}
		rtn[r.BlockId] = copied
	}
	return rtn
}

// use adds CPU to a process of a block's tree, as its own or its reaped children's.
func (f *fakeTrees) use(blockId string, pid int32, self time.Duration, children time.Duration) {
	p := f.trees[blockId][pid]
	p.Cpu.Self += self
	p.Cpu.Children += children
	f.trees[blockId][pid] = p
}

// idleAgentTree is Claude Code at its prompt with one MCP server.
func idleAgentTree() TreeSample {
	return TreeSample{
		agentPid: {Ppid: 1, StartMs: agentStart, Cpu: proctree.Cpu{Self: 25 * time.Minute}},
		mcpPid:   {Ppid: agentPid, StartMs: agentStart + 2_000, Cpu: proctree.Cpu{Self: 3 * time.Second}},
	}
}

func agentRoot(blockId string) TreeRoot {
	return TreeRoot{BlockId: blockId, Pid: agentPid, StartMs: agentStart}
}

type busyClock struct {
	now time.Time
}

func (c *busyClock) get() time.Time {
	return c.now
}

func TestCpuSpentBetween(t *testing.T) {
	prevAt := time.UnixMilli(1_000_000)
	prev := TreeSample{
		agentPid: {Ppid: 1, StartMs: agentStart, Cpu: proctree.Cpu{Self: 10 * time.Second, Children: time.Second}},
		shellPid: {Ppid: agentPid, StartMs: 990_000, Cpu: proctree.Cpu{Self: 100 * time.Millisecond}},
		buildPid: {Ppid: shellPid, StartMs: 995_000, Cpu: proctree.Cpu{Self: 2 * time.Second}},
	}
	// The build ended and its shell reaped it: its 2 s already counted plus 0.5 s more moved into the shell's
	// children; a test binary started since; the agent used 0.1 s itself.
	cur := TreeSample{
		agentPid: {Ppid: 1, StartMs: agentStart, Cpu: proctree.Cpu{Self: 10*time.Second + 100*time.Millisecond, Children: time.Second}},
		shellPid: {Ppid: agentPid, StartMs: 990_000, Cpu: proctree.Cpu{Self: 100 * time.Millisecond, Children: 2500 * time.Millisecond}},
		140:      {Ppid: shellPid, StartMs: 1_002_000, Cpu: proctree.Cpu{Self: 300 * time.Millisecond}},
	}
	agent, tree := cpuSpentBetween(agentPid, prev, cur, prevAt)
	if agent != 100*time.Millisecond {
		t.Errorf("the agent's own CPU is %v, want 100ms", agent)
	}
	if tree != 800*time.Millisecond {
		t.Errorf("the tree's CPU is %v, want 800ms (the build's last 500ms and the new test's 300ms, nothing twice)", tree)
	}
	// A pid reused by another process counts as a new process; one older than the previous sample and missing from
	// it is not this interval's.
	cur = TreeSample{
		agentPid: prev[agentPid],
		shellPid: {Ppid: agentPid, StartMs: 1_003_000, Cpu: proctree.Cpu{Self: 200 * time.Millisecond}},
		150:      {Ppid: agentPid, StartMs: 500_000, Cpu: proctree.Cpu{Self: time.Hour}},
	}
	agent, tree = cpuSpentBetween(agentPid, prev, cur, prevAt)
	if agent != 0 || tree != 200*time.Millisecond {
		t.Errorf("reused pid: agent %v, tree %v, want 0 and 200ms", agent, tree)
	}
	// Codex's npm wrapper is the root and its native binary, under it, draws the TUI: that binary is the agent's own.
	prev = TreeSample{
		agentPid: {Ppid: 1, StartMs: agentStart, Cpu: proctree.Cpu{Self: time.Second}, Agent: true},
		160:      {Ppid: agentPid, StartMs: agentStart + 500, Cpu: proctree.Cpu{Self: time.Minute}, Agent: true},
	}
	cur = TreeSample{
		agentPid: prev[agentPid],
		160:      {Ppid: agentPid, StartMs: agentStart + 500, Cpu: proctree.Cpu{Self: time.Minute + 150*time.Millisecond, Children: 40 * time.Millisecond}, Agent: true},
	}
	agent, tree = cpuSpentBetween(agentPid, prev, cur, prevAt)
	if agent != 150*time.Millisecond || tree != 40*time.Millisecond {
		t.Errorf("an agent under its wrapper: agent %v, tree %v, want 150ms and 40ms", agent, tree)
	}
}

func TestSampleTreesReadsThisProcess(t *testing.T) {
	self := int32(os.Getpid())
	table, err := proctree.Read()
	if err != nil {
		t.Skip(err)
	}
	// Linux counts CPU in 10 ms ticks: a test binary this young may have none yet.
	n := 0
	for end := time.Now().Add(50 * time.Millisecond); time.Now().Before(end); {
		n++
	}
	_ = n
	root := TreeRoot{BlockId: "b1", Pid: self, StartMs: table.Get(self).StartMs}
	got := sampleTrees([]TreeRoot{root, {BlockId: "gone", Pid: self, StartMs: root.StartMs - 3_600_000}})
	sample, ok := got["b1"][self]
	if !ok || !sample.Agent || sample.Cpu.Self <= 0 || sample.Ppid != int32(os.Getppid()) {
		t.Fatalf("this process's sample: %+v (%v)", sample, ok)
	}
	if _, ok := got["gone"]; ok {
		t.Error("a root with another start time is another process")
	}
	if !isAgentName("codex") || !isAgentName("/usr/local/bin/claude") || isAgentName("node") {
		t.Error("agent names")
	}
}

func TestBusyTreeIsWorkIdleTreeIsNot(t *testing.T) {
	clock := &busyClock{now: time.UnixMilli(1_000_000)}
	trees := &fakeTrees{trees: map[string]TreeSample{"b1": idleAgentTree(), "b2": idleAgentTree()}}
	tracker := makeBusyTracker(trees.sample, clock.get)
	roots := []TreeRoot{agentRoot("b1"), agentRoot("b2")}
	if got := tracker.Busy(roots); len(got) != 0 {
		t.Fatalf("a first sample tells nothing yet: %v", got)
	}
	for i := 0; i < 30; i++ {
		clock.now = clock.now.Add(5 * time.Second)
		// Both agents at their prompt: about 1 s a minute of their own, a few ms for the MCP server (the busiest
		// baseline measured on 2026-10-12).
		trees.use("b1", agentPid, 80*time.Millisecond, 0)
		trees.use("b1", mcpPid, 5*time.Millisecond, 0)
		trees.use("b2", agentPid, 80*time.Millisecond, 0)
		trees.use("b2", mcpPid, 5*time.Millisecond, 0)
		// From the third interval on, b2 runs a background build through a shell: its CPU reaches the shell's
		// reaped children total as each compile step ends.
		if i == 2 {
			tree := trees.trees["b2"]
			tree[shellPid] = ProcSample{Ppid: agentPid, StartMs: clock.now.UnixMilli() - 1_000}
		}
		if i >= 2 && i < 12 {
			trees.use("b2", shellPid, 0, 400*time.Millisecond)
		}
		got := tracker.Busy(roots)
		if got["b1"] {
			t.Fatalf("interval %d: an agent at its prompt counts as work", i)
		}
		switch {
		case i >= 3 && i < 12 && !got["b2"]:
			t.Fatalf("interval %d: a background build does not count: %v", i, got)
		case i >= 23 && got["b2"]:
			// Its last CPU came at interval 11: 12 intervals of 5 s later it is out of the window.
			t.Fatalf("interval %d: the build ended a minute ago and still counts", i)
		}
	}
	if trees.calls != 31 {
		t.Errorf("%d samples for 31 evaluations 5 s apart", trees.calls)
	}
	for _, asked := range trees.asked {
		if len(asked) != 2 {
			t.Fatalf("one sample reads every tree: %v", asked)
		}
	}
}

func TestBusyAgentOwnCpu(t *testing.T) {
	clock := &busyClock{now: time.UnixMilli(1_000_000)}
	trees := &fakeTrees{trees: map[string]TreeSample{"b1": idleAgentTree()}}
	tracker := makeBusyTracker(trees.sample, clock.get)
	roots := []TreeRoot{agentRoot("b1")}
	tracker.Busy(roots)
	busyAt := -1
	for i := 0; i < 12; i++ {
		clock.now = clock.now.Add(5 * time.Second)
		// Background subagents that think and stream: 3 s a minute in the agent's own process.
		trees.use("b1", agentPid, 250*time.Millisecond, 0)
		if tracker.Busy(roots)["b1"] && busyAt < 0 {
			busyAt = i
		}
	}
	if busyAt != 7 {
		t.Errorf("the agent's own 2 s were reached at interval %d, want 7 (8 x 250ms)", busyAt)
	}
}

func TestBusySamplesThrottledAndForgotten(t *testing.T) {
	clock := &busyClock{now: time.UnixMilli(1_000_000)}
	trees := &fakeTrees{trees: map[string]TreeSample{"b1": idleAgentTree()}}
	tracker := makeBusyTracker(trees.sample, clock.get)
	roots := []TreeRoot{agentRoot("b1")}
	tracker.Busy(roots)
	// The keeper evaluates every 2 s: a tree with only its first sample is read at the next evaluation, then every
	// 5 s at most.
	for i := 0; i < 10; i++ {
		clock.now = clock.now.Add(2 * time.Second)
		tracker.Busy(roots)
	}
	if trees.calls != 5 {
		t.Errorf("%d samples in 20 s of evaluations every 2 s, want 5 (first, then the quick second, then every 5 s)", trees.calls)
	}
	// No agent to follow (it works again, or none runs): no sample, and the tree is forgotten.
	calls := trees.calls
	if got := tracker.Busy(nil); got != nil || trees.calls != calls || len(tracker.trees) != 0 {
		t.Errorf("no root: %v, %d samples, %d trees", got, trees.calls-calls, len(tracker.trees))
	}
	// A burst while it was not followed is not recent work: the tree starts over from a first sample.
	trees.use("b1", agentPid, 0, 30*time.Second)
	clock.now = clock.now.Add(5 * time.Second)
	if tracker.Busy(roots)["b1"] {
		t.Error("a tree followed again counts what it used before")
	}
	// The same pid in a new process is another agent: a new first sample.
	clock.now = clock.now.Add(5 * time.Second)
	tracker.Busy(roots)
	trees.trees["b1"] = TreeSample{agentPid: {Ppid: 1, StartMs: agentStart + 60_000, Cpu: proctree.Cpu{Self: time.Hour}}}
	clock.now = clock.now.Add(5 * time.Second)
	reused := []TreeRoot{{BlockId: "b1", Pid: agentPid, StartMs: agentStart + 60_000}}
	if tracker.Busy(reused)["b1"] {
		t.Error("a reused pid inherits the old process's samples")
	}
	// A root that is gone is dropped.
	delete(trees.trees, "b1")
	clock.now = clock.now.Add(5 * time.Second)
	if tracker.Busy(reused)["b1"] || len(tracker.trees) != 0 {
		t.Error("a gone root is kept")
	}
}

func TestComputeWorkBackgroundWork(t *testing.T) {
	blocks := map[string]BlockInfo{
		"working":    {WorkspaceId: "ws-a"},
		"background": {WorkspaceId: "ws-b"},
		"prompt":     {WorkspaceId: "ws-c"},
		"remote":     {WorkspaceId: "ws-d", Remote: true},
		"subagents":  {WorkspaceId: "ws-e", Remote: true},
	}
	var asked []TreeRoot
	src := WorkSources{
		Agents: func() []molten.AgentRunInfo {
			return []molten.AgentRunInfo{
				{BlockId: "working", Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateWorking, Pid: 10, PidStartMs: 1},
				{BlockId: "background", Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateDone, Pid: 20, PidStartMs: 2},
				{BlockId: "prompt", Agent: molten.AgentIdCodex, Running: true, State: molten.AgentStateWaiting, Pid: 30, PidStartMs: 3},
				// A remote agent's process is not known: it counts through its state only.
				{BlockId: "remote", Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateDone},
				// Its hooks report running sub-agents after its turn ended (#1092): background work, process or not.
				{BlockId: "subagents", Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateDone, Subagents: 2},
			}
		},
		Commands: func() map[string]string { return map[string]string{"background": "claude", "prompt": "codex"} },
		Locate: func(ctx context.Context, blockId string) (BlockInfo, bool) {
			info, ok := blocks[blockId]
			return info, ok
		},
		BusyTrees: func(roots []TreeRoot) map[string]bool {
			asked = roots
			return map[string]bool{"background": true}
		},
	}
	work := ComputeWork(context.Background(), src)
	want := map[string]bool{"ws-a": true, "ws-b": true, "ws-e": true}
	if !reflect.DeepEqual(work.Workspaces, want) || !work.Local {
		t.Fatalf("work %+v, want %v", work, want)
	}
	if len(asked) != 2 {
		t.Errorf("sampled %v: only the local agents that are not working", asked)
	}
	for _, r := range asked {
		if r.BlockId == "working" || r.BlockId == "remote" {
			t.Errorf("sampled %v: a working agent or a remote one", r)
		}
	}
	if got := work.Reasons["ws-b"]; !reflect.DeepEqual(got, []string{"Claude Code: background work"}) {
		t.Errorf("reasons of ws-b: %v", got)
	}
	if got := work.Reasons["ws-e"]; !reflect.DeepEqual(got, []string{"Claude Code: background work"}) {
		t.Errorf("reasons of ws-e: %v", got)
	}
	if got := work.LocalReasons; !reflect.DeepEqual(got, []string{"Claude Code: working", "Claude Code: background work"}) {
		t.Errorf("local reasons: %v", got)
	}
}

func TestSortReasons(t *testing.T) {
	got := sortReasons([]reason{
		{rank: reasonMission, text: missionReason},
		commandReason("make   all"),
		agentReason(molten.AgentIdClaude, reasonAgentBackground),
		agentReason(molten.AgentIdClaude, reasonAgentBackground),
		agentReason(molten.AgentIdCodex, reasonAgentWorking),
		commandReason("go test ./..."),
	})
	want := []string{"Codex: working", "Claude Code: background work", "Command: go test ./...", "2 more"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("reasons %v, want %v", got, want)
	}
	if sortReasons(nil) != nil {
		t.Error("no reason is nil")
	}
}

// The coffee and the Until work ends policy hold while a done agent's tree is busy, and end after the grace once it
// is quiet, with the real rule and an injected process sampler (#493).
func TestCoffeeHoldsWhileAgentTreeBusy(t *testing.T) {
	f := makeFakeEnv()
	f.policy = PolicyUntilWorkEnds
	trees := &fakeTrees{trees: map[string]TreeSample{"b1": idleAgentTree()}}
	trees.trees["b1"][shellPid] = ProcSample{Ppid: agentPid, StartMs: agentStart + 10_000}
	tracker := makeBusyTracker(trees.sample, func() time.Time { return f.now })
	src := WorkSources{
		Agents: func() []molten.AgentRunInfo {
			return []molten.AgentRunInfo{{BlockId: "b1", Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateDone, Pid: agentPid, PidStartMs: agentStart}}
		},
		Locate: func(ctx context.Context, blockId string) (BlockInfo, bool) {
			return BlockInfo{WorkspaceId: "ws-a"}, true
		},
		BusyTrees: tracker.Busy,
	}
	k := MakeKeeper(Env{
		Now:       func() time.Time { return f.now },
		Policy:    func() string { return f.policy },
		Work:      func(ctx context.Context) Work { return ComputeWork(ctx, src) },
		Workspace: func(ctx context.Context, wsId string) (string, bool) { return "Alpha", true },
		Notify:    func(n molten.NotificationInput) { f.notices = append(f.notices, n) },
	})
	ctx := context.Background()
	if _, err := k.SetCoffee(ctx, "ws-a", true); err != nil {
		t.Fatal(err)
	}
	step := func(busy bool) State {
		f.advance(2 * time.Second)
		trees.use("b1", agentPid, 30*time.Millisecond, 0)
		if busy {
			// A background `go test`: about one core.
			trees.use("b1", shellPid, 0, 1900*time.Millisecond)
		}
		k.Evaluate(ctx)
		return k.State()
	}
	var state State
	for i := 0; i < 150; i++ {
		state = step(true)
	}
	if len(state.Coffees) != 1 || !state.Coffees[0].Working || !state.PolicyWorking {
		t.Fatalf("5 minutes of background work after the turn ended: %+v", state)
	}
	if !reflect.DeepEqual(state.Coffees[0].Reasons, []string{"Claude Code: background work"}) || !reflect.DeepEqual(state.PolicyReasons, state.Coffees[0].Reasons) {
		t.Errorf("why it is kept awake: %v, %v", state.Coffees[0].Reasons, state.PolicyReasons)
	}
	if len(f.notices) != 0 {
		t.Fatalf("notices while work runs: %v", f.notices)
	}
	// The background work ends: the window drains, then the grace runs out.
	quietAt := f.now
	for len(k.State().Coffees) > 0 && f.now.Sub(quietAt) < 10*time.Minute {
		state = step(false)
	}
	took := f.now.Sub(quietAt)
	if len(state.Coffees) != 0 || took < GracePeriod || took > BusyWindow+GracePeriod+5*time.Second {
		t.Fatalf("the coffee ended %v after the work, want between the grace and the window plus the grace: %+v", took, state)
	}
	if state.Hold || state.PolicyHolding || len(f.notices) != 2 {
		t.Errorf("after the grace: hold %v, policy %v, %d notices (want the coffee's and the policy's)", state.Hold, state.PolicyHolding, len(f.notices))
	}
}

// An agent at its prompt with its MCP servers ends the coffee after the grace, as before.
func TestCoffeeEndsWithIdleAgentTree(t *testing.T) {
	f := makeFakeEnv()
	trees := &fakeTrees{trees: map[string]TreeSample{"b1": idleAgentTree()}}
	tracker := makeBusyTracker(trees.sample, func() time.Time { return f.now })
	src := WorkSources{
		Agents: func() []molten.AgentRunInfo {
			return []molten.AgentRunInfo{{BlockId: "b1", Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateDone, Pid: agentPid, PidStartMs: agentStart}}
		},
		Locate: func(ctx context.Context, blockId string) (BlockInfo, bool) {
			return BlockInfo{WorkspaceId: "ws-a"}, true
		},
		BusyTrees: tracker.Busy,
	}
	k := MakeKeeper(Env{
		Now:       func() time.Time { return f.now },
		Work:      func(ctx context.Context) Work { return ComputeWork(ctx, src) },
		Workspace: func(ctx context.Context, wsId string) (string, bool) { return "Alpha", true },
		Notify:    func(n molten.NotificationInput) { f.notices = append(f.notices, n) },
	})
	ctx := context.Background()
	start := f.now
	k.SetCoffee(ctx, "ws-a", true)
	for len(k.State().Coffees) > 0 && f.now.Sub(start) < 10*time.Minute {
		f.advance(2 * time.Second)
		trees.use("b1", agentPid, 32*time.Millisecond, 0)
		trees.use("b1", mcpPid, 2*time.Millisecond, 0)
		k.Evaluate(ctx)
		if c := k.State().Coffees; len(c) > 0 && c[0].Working {
			t.Fatalf("an agent at its prompt keeps the coffee working at %v", f.now.Sub(start))
		}
	}
	if took := f.now.Sub(start); len(k.State().Coffees) != 0 || took > GracePeriod+2*time.Second {
		t.Fatalf("the coffee of an idle agent ended after %v, want the grace", took)
	}
	if len(f.notices) != 1 {
		t.Errorf("%d notices, want the coffee's one", len(f.notices))
	}
}
