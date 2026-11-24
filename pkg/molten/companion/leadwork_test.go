// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/subagentwork"
)

// #2502: what a lead's sub-agents work on, read from their own files and kept where the agent states read it too.

// leadFixture is a lead session with sub-agents' files, as the settle tests lay them out.
type leadFixture struct {
	settleFixture
	root string
}

func makeLeadFixture(t *testing.T) leadFixture {
	t.Helper()
	f := makeSettleFixture(t)
	return leadFixture{settleFixture: f, root: filepath.Dir(filepath.Dir(f.session))}
}

// waitingAgent writes a sub-agent whose turn ended on a command it left running: its meta says finished, its
// transcript holds the launch and not the end. ago is how long ago its turn ended.
func (f leadFixture) waitingAgent(agentId string, description string, command string, ago time.Duration) {
	f.t.Helper()
	ended := time.Now().Add(-ago)
	f.agent(agentId, "toolu_"+agentId, description, true, ended.Add(2*time.Second), time.Time{})
	writeSubagentTranscript(f.t, f.settleFixture, agentId, ended,
		`{"type":"user","isSidechain":true,"timestamp":"`+jobStamp(ago+time.Hour)+`","message":{"role":"user","content":"go"}}`,
		bgCallRecord("toolu_run", command, ago), bgResultRecord("toolu_run", "task_"+agentId, ago), bgTurnEndLine)
}

// workingAgent writes a sub-agent in the middle of its turn.
func (f leadFixture) workingAgent(agentId string, description string) {
	f.t.Helper()
	f.agent(agentId, "toolu_"+agentId, description, false, time.Now().Add(-time.Hour), time.Time{})
	writeSubagentTranscript(f.t, f.settleFixture, agentId, time.Now(),
		`{"type":"user","isSidechain":true,"timestamp":"`+jobStamp(30*time.Minute)+`","message":{"role":"user","content":"go"}}`,
		`{"type":"assistant","message":{"model":"claude-opus-5-5","content":[{"type":"text","text":"working"}]}}`)
}

// leadManager reads sub-agents of Claude Code sessions under roots, and keeps their work in its own registry.
func leadManager(t *testing.T, roots ...string) (*Manager, *subagentwork.Registry) {
	t.Helper()
	m := MakeManager()
	reg := subagentwork.MakeRegistry()
	m.work = reg
	m.adapterFor = func(agent string) Adapter {
		if agent == molten.AgentIdClaude {
			return MakeClaudeAdapter(roots)
		}
		return nil
	}
	m.runOf = func(blockId string) (molten.AgentRunInfo, bool) {
		return molten.AgentRunInfo{BlockId: blockId, Agent: molten.AgentIdClaude, Running: true, Started: time.Now().Add(-3 * time.Hour).UnixMilli()}, true
	}
	return m, reg
}

// reportLead tells the hook log that a block's agent has the session of f, as the first report of a sub-agent does.
func reportLead(t *testing.T, blockId string, f leadFixture, agentId string) {
	t.Helper()
	req := molten.AgentSubagentRequest{
		BlockId: blockId, Agent: molten.AgentIdClaude, Event: molten.SubagentEventStart, AgentId: agentId,
		TranscriptPath: filepath.Join(f.subs, "agent-"+agentId+".jsonl"),
	}
	if err := defaultSubagentHooks.add(req); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ForgetHookSubagents(blockId) })
}

func workById(work []molten.SubagentWork) map[string]molten.SubagentWork {
	rtn := map[string]molten.SubagentWork{}
	for _, w := range work {
		rtn[w.Id] = w
	}
	return rtn
}

func TestListSubagentsNamesTheJobsAWaitingAgentWaitsFor(t *testing.T) {
	t.Parallel()
	f := makeLeadFixture(t)
	f.waitingAgent("a2502000000000w1", "#2496 tree scans", "cd frontend && npx vitest run", 7*time.Minute)
	f.workingAgent("a2502000000000r1", "#2497 companion size")
	a := MakeClaudeAdapter([]string{f.root})
	ids := identitiesById(ApplyHookSubagents(a.ListSubagents(f.session), nil, time.Now()))
	waiting, working := ids["a2502000000000w1"], ids["a2502000000000r1"]
	if waiting.State != SubagentRunning || !waiting.Waiting || len(waiting.Jobs) != 1 || waiting.Jobs[0].Kind != molten.JobVitest {
		t.Fatalf("a finished meta with a command still running is a running agent that waits for its tests: %+v", waiting)
	}
	if want := jobMs(7*time.Minute + time.Hour); waiting.FirstWrite != want {
		t.Errorf("its age counts from its first record: %d, want %d", waiting.FirstWrite, want)
	}
	if working.State != SubagentRunning || working.Waiting || len(working.Jobs) != 0 || working.FirstWrite != jobMs(30*time.Minute) {
		t.Errorf("an agent in the middle of its turn runs and waits for nothing: %+v", working)
	}
}

// The work of each lead is read from its own session: another agent of the same folder never lends its sub-agents.
func TestSweepLeadNowRecordsEachLeadsOwnWork(t *testing.T) {
	t.Parallel()
	fa, fb := makeLeadFixture(t), makeLeadFixture(t)
	fa.waitingAgent("a2502000000000a1", "#2496 tree scans", "npx vitest run", 7*time.Minute)
	fa.workingAgent("a2502000000000a2", "#2497 companion size")
	fb.waitingAgent("a2502000000000b1", "#2498 waiting agents", "task build:frontend:dev", 3*time.Minute)
	m, reg := leadManager(t, fa.root, fb.root)
	reportLead(t, "lead-a-2502", fa, "a2502000000000a1")
	reportLead(t, "lead-b-2502", fb, "a2502000000000b1")

	if !m.SweepLeadNow("lead-a-2502") || !m.SweepLeadNow("lead-b-2502") {
		t.Fatalf("both leads have sub-agents at work")
	}
	if m.SweepLeadNow("lead-c-2502") {
		t.Errorf("a lead whose session is not known has none")
	}
	a, b := workById(reg.Get("lead-a-2502")), workById(reg.Get("lead-b-2502"))
	if len(a) != 2 || a["a2502000000000a1"].Jobs[0].Kind != molten.JobVitest || !a["a2502000000000a1"].Waiting || a["a2502000000000a2"].Waiting {
		t.Errorf("lead A: %+v", a)
	}
	if len(b) != 1 || b["a2502000000000b1"].Jobs[0].Kind != molten.JobBuildFrontend {
		t.Errorf("lead B has its own sub-agent only: %+v", b)
	}
	if reg.Count("lead-c-2502") != 0 {
		t.Errorf("no lead C work: %+v", reg.Get("lead-c-2502"))
	}

	// Its command ends: the sub-agent resumes, finishes its turn with nothing pending, and is no longer at work.
	ended := time.Now().Add(-time.Minute)
	writeSubagentTranscript(t, fa.settleFixture, "a2502000000000a1", ended,
		`{"type":"user","timestamp":"`+jobStamp(time.Hour)+`","message":{"role":"user","content":"go"}}`,
		bgCallRecord("toolu_run", "npx vitest run", 7*time.Minute), bgResultRecord("toolu_run", "task_a2502000000000a1", 7*time.Minute),
		bgEndLine("task_a2502000000000a1"), bgTurnEndLine)
	fa.agent("a2502000000000a1", "toolu_a2502000000000a1", "#2496 tree scans", true, ended.Add(time.Second), time.Time{})
	m.SweepLeadNow("lead-a-2502")
	if a := workById(reg.Get("lead-a-2502")); len(a) != 1 || a["a2502000000000a2"].Id == "" {
		t.Errorf("only the agent in its turn is left: %+v", a)
	}

	m.runOf = func(blockId string) (molten.AgentRunInfo, bool) { return molten.AgentRunInfo{}, false }
	if m.SweepLeadNow("lead-b-2502") || reg.Count("lead-b-2502") != 0 {
		t.Errorf("a run that ended has no work: %+v", reg.Get("lead-b-2502"))
	}
}

func TestSweepLeadNowReadsClaudeCodeOnly(t *testing.T) {
	t.Parallel()
	f := makeLeadFixture(t)
	f.waitingAgent("a2502000000000c1", "#2496 tree scans", "go test ./...", 7*time.Minute)
	m, reg := leadManager(t, f.root)
	reportLead(t, "lead-codex-2502", f, "a2502000000000c1")
	m.runOf = func(blockId string) (molten.AgentRunInfo, bool) {
		return molten.AgentRunInfo{BlockId: blockId, Agent: molten.AgentIdCodex, Running: true}, true
	}
	if m.SweepLeadNow("lead-codex-2502") || reg.Count("lead-codex-2502") != 0 {
		t.Errorf("another agent's sub-agents are recorded when PaneSubagents is asked for them, never swept: %+v", reg.Get("lead-codex-2502"))
	}
}

// fakeTimers stand in for time.AfterFunc: they record what was asked and run it when the test says.
type fakeTimers struct {
	lock  sync.Mutex
	asked []time.Duration
	fns   []func()
}

func (f *fakeTimers) afterFunc(d time.Duration, fn func()) *time.Timer {
	f.lock.Lock()
	defer f.lock.Unlock()
	f.asked = append(f.asked, d)
	f.fns = append(f.fns, fn)
	return time.NewTimer(time.Hour)
}

func (f *fakeTimers) state() ([]time.Duration, []func()) {
	f.lock.Lock()
	defer f.lock.Unlock()
	return append([]time.Duration(nil), f.asked...), append([]func(){}, f.fns...)
}

func TestLeadDue(t *testing.T) {
	t.Parallel()
	now := jobsClock
	if got := leadDue(now, leadSweepDelay, time.Time{}); !got.Equal(now.Add(leadSweepDelay)) {
		t.Errorf("a first read waits the short delay: %v", got)
	}
	last := now.Add(-time.Second)
	if got := leadDue(now, leadSweepDelay, last); !got.Equal(last.Add(leadSweepMin)) {
		t.Errorf("two reads are at least leadSweepMin apart: %v", got)
	}
	last = now.Add(-time.Hour)
	if got := leadDue(now, leadSweepEvery, last); !got.Equal(now.Add(leadSweepEvery)) {
		t.Errorf("an old read holds nothing back: %v", got)
	}
}

func TestSweepSoonReadsOnceInABurstAndAgainWhileSubagentsWork(t *testing.T) {
	t.Parallel()
	f := makeLeadFixture(t)
	f.waitingAgent("a2502000000000d1", "#2496 tree scans", "task perf:bundle", 7*time.Minute)
	m, reg := leadManager(t, f.root)
	timers := &fakeTimers{}
	// The files' times are real ones: the clock starts from now and only the reads' spacing is under the test's hand.
	clock := time.Now()
	m.now = func() time.Time { return clock }
	m.afterFunc = timers.afterFunc
	reportLead(t, "lead-d-2502", f, "a2502000000000d1")
	t.Cleanup(func() { m.ForgetLead("lead-d-2502") })

	m.SweepLead("lead-d-2502")
	m.SweepLead("lead-d-2502")
	m.SweepLead("lead-d-2502")
	asked, fns := timers.state()
	if len(asked) != 1 || asked[0] != leadSweepDelay {
		t.Fatalf("a burst of changes is one read, soon: %v", asked)
	}

	fns[0]()
	if reg.Count("lead-d-2502") != 1 {
		t.Fatalf("the read recorded the sub-agent: %+v", reg.Get("lead-d-2502"))
	}
	asked, fns = timers.state()
	if len(asked) != 2 || asked[1] != leadSweepEvery {
		t.Fatalf("a sub-agent works: read again in %v: %v", leadSweepEvery, asked)
	}

	clock = clock.Add(time.Second)
	m.SweepLead("lead-d-2502")
	asked, _ = timers.state()
	if len(asked) != 3 || asked[2] != leadSweepMin-time.Second {
		t.Errorf("a change soon after a read waits for the minimum between two, and comes before the periodic one: %v", asked)
	}

	// The old periodic timer fires after it was replaced: it reads nothing.
	before := reg.Revision("lead-d-2502")
	fns[1]()
	if reg.Revision("lead-d-2502") != before {
		t.Errorf("a replaced timer does nothing")
	}
	if asked, _ = timers.state(); len(asked) != 3 {
		t.Errorf("and schedules nothing: %v", asked)
	}
}

func TestSweepEndsWhenNoSubagentWorks(t *testing.T) {
	t.Parallel()
	m, _ := leadManager(t)
	timers := &fakeTimers{}
	m.afterFunc = timers.afterFunc
	m.SweepLead("lead-none-2502")
	_, fns := timers.state()
	fns[0]()
	if asked, _ := timers.state(); len(asked) != 1 {
		t.Errorf("a lead with no sub-agent at work is read again only when something changes: %v", asked)
	}
}

func TestLeadStateChanged(t *testing.T) {
	t.Parallel()
	m, reg := leadManager(t)
	timers := &fakeTimers{}
	m.afterFunc = timers.afterFunc
	reg.Set("lead-e-2502", []molten.SubagentWork{{Id: "a1"}})

	m.leadStateChanged(molten.AgentStateInfo{BlockId: "lead-codex-2502", Agent: molten.AgentIdCodex})
	if asked, _ := timers.state(); len(asked) != 0 {
		t.Errorf("only Claude Code's leads are swept: %v", asked)
	}
	m.leadStateChanged(molten.AgentStateInfo{BlockId: "lead-e-2502", Agent: molten.AgentIdClaude})
	if asked, _ := timers.state(); len(asked) != 1 {
		t.Errorf("a Claude Code lead's state change asks a read: %v", asked)
	}
	m.leadStateChanged(molten.AgentStateInfo{BlockId: "lead-e-2502", Cleared: true})
	if reg.Count("lead-e-2502") != 0 {
		t.Errorf("a cleared agent's work goes: %+v", reg.Get("lead-e-2502"))
	}
}

func TestViewGivesTheSubagentsTheirJobs(t *testing.T) {
	t.Parallel()
	m, reg := leadManager(t)
	jobs := []molten.BackgroundJob{{Kind: molten.JobGoTest, Since: 5}}
	reg.Set("lead-f-2502", []molten.SubagentWork{{Id: "w1", Waiting: true, Jobs: jobs}, {Id: "r1"}})
	subs := m.withLeadWork("lead-f-2502", []SubagentInfo{
		{Id: "toolu_1", AgentId: "w1", State: SubagentRunning},
		{Id: "toolu_2", AgentId: "r1", State: SubagentRunning},
		{Id: "toolu_3", AgentId: "gone", State: SubagentDone, Waiting: false},
		{Id: "toolu_4", State: SubagentRunning, Waiting: true},
	})
	if !subs[0].Waiting || len(subs[0].Jobs) != 1 || subs[0].Jobs[0].Kind != molten.JobGoTest {
		t.Errorf("a sub-agent waiting on its tests: %+v", subs[0])
	}
	if subs[1].Waiting || len(subs[1].Jobs) != 0 {
		t.Errorf("one in its turn waits for nothing: %+v", subs[1])
	}
	if subs[2].Waiting || len(subs[2].Jobs) != 0 {
		t.Errorf("one the files do not list is left as the session says: %+v", subs[2])
	}
	if !subs[3].Waiting {
		t.Errorf("the session's own word that it waits stays: %+v", subs[3])
	}
}

func TestLeadWorkOfKeepsWhatWorks(t *testing.T) {
	t.Parallel()
	work := leadWorkOf([]SubagentIdentity{
		{AgentId: "run", State: SubagentRunning, Description: "#1 a", Kind: "sf-fix", FirstWrite: 100},
		{AgentId: "wait", State: SubagentRunning, Waiting: true, Jobs: []molten.BackgroundJob{{Kind: molten.JobVitest}}, Started: 50},
		{AgentId: "quiet", State: SubagentQuiet},
		{AgentId: "done", State: SubagentDone},
		{State: SubagentRunning},
	})
	if len(work) != 2 || work[0].Id != "run" || work[0].Started != 100 || work[1].Id != "wait" || work[1].Started != 50 || !work[1].Waiting {
		t.Errorf("what works, with its start: %+v", work)
	}
}
