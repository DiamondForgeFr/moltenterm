// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package attention

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentnames"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
)

const (
	lockProjectA = "/projects/alpha"
	lockProjectB = "/projects/beta"
)

// lockHarness is an agent harness whose panes belong to projects, as wavesrv reads them once it has located a pane.
type lockHarness struct {
	*agentHarness
	projects map[string]string
	locks    int
}

func makeLockHarness(names ...string) *lockHarness {
	h := &lockHarness{agentHarness: makeAgentHarness(), projects: map[string]string{}}
	h.states.names = agentnames.MakeAllocator(names)
	h.states.projectOf = func(blockId string, wsId string) string { return h.projects[blockId] }
	h.states.onLocks = func() { h.locks++ }
	return h
}

// start runs an agent in a pane of a project and locates it, as the publisher does before the first state goes out.
func (h *lockHarness) start(block string, project string) {
	h.projects[block] = project
	h.out(block, cmdMark("claude"))
	h.states.flush()
}

func (h *lockHarness) lock(block string, move bool) molten.AgentNameLockResult {
	return h.states.lockName(molten.AgentNameLockRequest{BlockId: block, Move: move})
}

func (h *lockHarness) lastPublished(block string) molten.AgentStateInfo {
	for i := len(h.agentHarness.published) - 1; i >= 0; i-- {
		if h.agentHarness.published[i].BlockId == block {
			return h.agentHarness.published[i]
		}
	}
	return molten.AgentStateInfo{}
}

// #2324 AC1: lock a name for project A, close its terminal, open a new agent terminal in A: the agent is that name.
func TestANewAgentInTheProjectGetsTheLockedNameBack(t *testing.T) {
	t.Parallel()
	h := makeLockHarness("Flore", "Bruno", "Clara")
	h.start("b1", lockProjectA)
	first := h.firstName("b1")
	if res := h.lock("b1", false); res.Status != molten.AgentNameLockDone || res.Name != first || res.Project != lockProjectA {
		t.Fatalf("lock: %+v", res)
	}
	h.states.forget("b1")
	for i := 0; i < 5; i++ {
		block := "new" + string(rune('a'+i))
		h.start(block, lockProjectA)
		if got := h.firstName(block); got != first {
			t.Fatalf("attempt %d: the new agent of the project is %q, want %q", i, got, first)
		}
		h.states.forget(block)
	}
}

// AC2: an agent started in project B never gets a name locked for A, even when it is free.
func TestAnAgentOfAnotherProjectNeverGetsALockedName(t *testing.T) {
	t.Parallel()
	h := makeLockHarness("Flore", "Bruno")
	h.start("b1", lockProjectA)
	h.lock("b1", false)
	locked := h.firstName("b1")
	h.states.forget("b1")
	for i := 0; i < 20; i++ {
		block := "other" + string(rune('a'+i))
		h.start(block, lockProjectB)
		if got := h.firstName(block); got == locked {
			t.Fatalf("an agent of B got %q, locked for A", got)
		}
		h.states.forget(block)
	}
}

// An agent of no project (a terminal in no folder, or a remote one) never gets a locked name either.
func TestAnAgentWithoutAProjectNeverGetsALockedName(t *testing.T) {
	t.Parallel()
	h := makeLockHarness("Flore", "Bruno")
	h.start("b1", lockProjectA)
	h.lock("b1", false)
	locked := h.firstName("b1")
	h.states.forget("b1")
	for i := 0; i < 20; i++ {
		block := "free" + string(rune('a'+i))
		h.start(block, "")
		if got := h.firstName(block); got == locked {
			t.Fatalf("an agent of no project got %q", got)
		}
		h.states.forget(block)
	}
}

// AC3: a second agent in A while the locked name is live gets another name.
func TestASecondAgentOfTheProjectGetsAnotherName(t *testing.T) {
	t.Parallel()
	h := makeLockHarness("Flore", "Bruno", "Clara")
	h.start("b1", lockProjectA)
	h.lock("b1", false)
	locked := h.firstName("b1")
	h.start("b2", lockProjectA)
	if got := h.firstName("b2"); got == locked || got == "" {
		t.Fatalf("second agent: %q while %q is live", got, locked)
	}
	if got := h.firstName("b1"); got != locked {
		t.Fatalf("the first agent lost its name: %q", got)
	}
}

// Several locked names: each new agent takes the first free one, in locking order; the others get ordinary names.
func TestSeveralLockedNamesGoInLockingOrder(t *testing.T) {
	t.Parallel()
	h := makeLockHarness("Flore", "Bruno", "Clara", "Diane")
	h.start("lead", lockProjectA)
	h.start("reviewer", lockProjectA)
	leadName, reviewerName := h.firstName("lead"), h.firstName("reviewer")
	h.lock("lead", false)
	h.lock("reviewer", false)
	h.states.forget("lead")
	h.states.forget("reviewer")

	h.start("n1", lockProjectA)
	h.start("n2", lockProjectA)
	h.start("n3", lockProjectA)
	if got := h.firstName("n1"); got != leadName {
		t.Fatalf("first agent: %q, want %q", got, leadName)
	}
	if got := h.firstName("n2"); got != reviewerName {
		t.Fatalf("second agent: %q, want %q", got, reviewerName)
	}
	third := h.firstName("n3")
	if third == leadName || third == reviewerName || third == "" {
		t.Fatalf("third agent: %q", third)
	}
}

// The locked name goes before the name the terminal remembered.
func TestTheLockedNameComesBeforeTheTerminalsRememberedName(t *testing.T) {
	t.Parallel()
	h := makeLockHarness("Flore", "Bruno", "Clara")
	h.start("b1", lockProjectA)
	h.lock("b1", false)
	locked := h.firstName("b1")
	h.states.forget("b1")
	remembered := "Bruno"
	if locked == "Bruno" {
		remembered = "Clara"
	}
	h.states.names.Prefer("b2", remembered)
	h.start("b2", lockProjectA)
	if got := h.firstName("b2"); got != locked {
		t.Fatalf("got %q, want the locked %q before the remembered %q", got, locked, remembered)
	}
	h.states.endRun("b2")
	h.states.names.Prefer("b2", remembered)
	h.start("b2", lockProjectB)
	if got := h.firstName("b2"); got != remembered {
		t.Fatalf("outside the project the remembered name still comes first: %q, want %q", got, remembered)
	}
}

// The first state an agent publishes already carries its final name and its project; the name is kept in the block's
// meta once, when it is final.
func TestTheFirstPublishedStateCarriesTheFinalName(t *testing.T) {
	t.Parallel()
	h := makeLockHarness("Flore", "Bruno")
	h.start("b1", lockProjectA)
	h.lock("b1", false)
	locked := h.firstName("b1")
	h.states.forget("b1")
	h.agentHarness.published = nil
	var named []string
	h.states.onNamed = func(blockId string, name string) { named = append(named, blockId+":"+name) }

	h.start("b2", lockProjectA)
	info := h.lastPublished("b2")
	if info.FirstName != locked || info.NameLockedFor != lockProjectA || info.Project != lockProjectA {
		t.Fatalf("first published state: %+v", info)
	}
	for _, p := range h.agentHarness.published {
		if p.BlockId == "b2" && p.FirstName != locked {
			t.Fatalf("a state of b2 was published with %q", p.FirstName)
		}
	}
	if len(named) != 1 || named[0] != "b2:"+locked {
		t.Fatalf("the name kept in the block's meta: %v", named)
	}
}

// A name drawn before the pane is located is not kept in the block's meta: the name settled on is.
func TestAProvisionalNameIsNeverKept(t *testing.T) {
	t.Parallel()
	h := makeLockHarness("Flore", "Bruno")
	var named []string
	h.states.onNamed = func(blockId string, name string) { named = append(named, blockId+":"+name) }
	h.out("b1", cmdMark("claude"))
	if len(named) != 0 {
		t.Fatalf("kept before the pane was located: %v", named)
	}
	h.states.flush()
	if len(named) != 1 {
		t.Fatalf("kept after: %v", named)
	}
}

// AC4: unlock frees the name for anyone, and the agent holding it loses the mark at once.
func TestUnlockFreesTheNameForAnyone(t *testing.T) {
	t.Parallel()
	h := makeLockHarness("Flore")
	h.start("b1", lockProjectA)
	h.lock("b1", false)
	locked := h.firstName("b1")
	if got := h.info("b1").NameLockedFor; got != lockProjectA {
		t.Fatalf("a holder of a locked name: locked for %q", got)
	}
	h.agentHarness.published = nil
	locks := h.locks
	if res := h.states.unlockName(molten.AgentNameUnlockRequest{Name: locked}); res.Status != molten.AgentNameUnlockDone {
		t.Fatalf("unlock: %+v", res)
	}
	h.states.flush()
	if got := h.lastPublished("b1"); got.NameLockedFor != "" || got.FirstName != locked {
		t.Fatalf("the holder after the unlock: %+v", got)
	}
	if h.locks != locks+1 {
		t.Fatalf("the windows were told %d times", h.locks-locks)
	}
	h.states.forget("b1")
	h.start("b2", lockProjectB)
	if got := h.firstName("b2"); got != locked {
		t.Fatalf("an agent of B after the unlock: %q, want %q", got, locked)
	}
	if res := h.states.unlockName(molten.AgentNameUnlockRequest{Name: locked}); res.Status != molten.AgentNameUnlockNone {
		t.Fatalf("a name that is not locked: %+v", res)
	}
}

func TestLockMarksTheHolderAtOnce(t *testing.T) {
	t.Parallel()
	h := makeLockHarness("Flore")
	h.start("b1", lockProjectA)
	h.agentHarness.published = nil
	h.lock("b1", false)
	h.states.flush()
	got := h.lastPublished("b1")
	if got.NameLockedFor != lockProjectA || got.Project != lockProjectA {
		t.Fatalf("published after the lock: %+v", got)
	}
}

// AC5: locking a name locked for another project asks first, and nothing moves until the answer.
func TestLockingANameLockedElsewhereAsksToMoveIt(t *testing.T) {
	t.Parallel()
	h := makeLockHarness("Flore", "Bruno")
	// The agent of A holds the name before project B locks it.
	h.start("a1", lockProjectA)
	held := h.firstName("a1")
	h.states.names.Lock(held, lockProjectB, false)
	res := h.lock("a1", false)
	if res.Status != molten.AgentNameLockElsewhere || res.From != lockProjectB || res.Project != lockProjectA || res.Name != held {
		t.Fatalf("lock elsewhere: %+v", res)
	}
	if got := h.states.names.LockedFor(held); got != lockProjectB {
		t.Fatalf("the lock moved without an answer: %q", got)
	}
	res = h.lock("a1", true)
	if res.Status != molten.AgentNameLockDone || res.From != lockProjectB {
		t.Fatalf("move: %+v", res)
	}
	if got := h.states.names.LockedFor(held); got != lockProjectA {
		t.Fatalf("after the move: %q", got)
	}
}

func TestLockRefusals(t *testing.T) {
	t.Parallel()
	h := makeLockHarness("Flore")
	if res := h.lock("nobody", false); res.Status != molten.AgentNameLockNoAgent {
		t.Fatalf("no agent: %+v", res)
	}
	h.start("b1", "")
	if res := h.lock("b1", false); res.Status != molten.AgentNameLockNoProject {
		t.Fatalf("no project: %+v", res)
	}
	h.start("b2", lockProjectA)
	numbered := h.firstName("b2")
	if numbered != "Flore 2" {
		t.Fatalf("setup: %q", numbered)
	}
	if res := h.lock("b2", false); res.Status != molten.AgentNameLockNotLockable {
		t.Fatalf("a numbered name: %+v", res)
	}
	if len(h.states.nameLocksResult().Locks) != 0 {
		t.Fatalf("a refusal locked something: %v", h.states.nameLocksResult().Locks)
	}
}

func TestLockingTwiceChangesNothing(t *testing.T) {
	t.Parallel()
	h := makeLockHarness("Flore")
	h.start("b1", lockProjectA)
	h.lock("b1", false)
	locks := h.locks
	if res := h.lock("b1", false); res.Status != molten.AgentNameLockAlready {
		t.Fatalf("second lock: %+v", res)
	}
	if h.locks != locks {
		t.Fatalf("the windows were told of a lock that did not change")
	}
}

// AC4: locks and unlocks survive a restart; they are kept in the data folder, never in the project's files.
func TestLocksSurviveARestart(t *testing.T) {
	t.Parallel()
	dir := filepath.Join(t.TempDir(), "agentnames")
	h := makeLockHarness("Flore", "Bruno", "Clara")
	h.states.useNameStore(agentnames.MakeLockStore(dir))
	h.start("b1", lockProjectA)
	h.start("b2", lockProjectA)
	h.lock("b1", false)
	h.lock("b2", false)
	names := []string{h.firstName("b1"), h.firstName("b2")}

	restarted := makeLockHarness("Flore", "Bruno", "Clara")
	restarted.states.useNameStore(agentnames.MakeLockStore(dir))
	locks := restarted.states.nameLocksResult().Locks
	if len(locks) != 2 || locks[0].Name != names[0] || locks[1].Name != names[1] || locks[0].Project != lockProjectA {
		t.Fatalf("after the restart: %v, want %v for %s", locks, names, lockProjectA)
	}
	restarted.start("n1", lockProjectA)
	if got := restarted.firstName("n1"); got != names[0] {
		t.Fatalf("a new agent after the restart: %q, want %q", got, names[0])
	}

	if res := restarted.states.unlockName(molten.AgentNameUnlockRequest{Name: names[0]}); res.Status != molten.AgentNameUnlockDone {
		t.Fatalf("unlock: %+v", res)
	}
	again := makeLockHarness("Flore", "Bruno", "Clara")
	again.states.useNameStore(agentnames.MakeLockStore(dir))
	locks = again.states.nameLocksResult().Locks
	if len(locks) != 1 || locks[0].Name != names[1] {
		t.Fatalf("after the unlock and a second restart: %v", locks)
	}
}

// A lock that cannot be kept is not applied: it would not survive the restart the developer relies on.
func TestALockThatCannotBeKeptIsNotApplied(t *testing.T) {
	t.Parallel()
	blocker := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	h := makeLockHarness("Flore")
	h.states.nameStore = agentnames.MakeLockStore(filepath.Join(blocker, "agentnames"))
	h.start("b1", lockProjectA)
	locks := h.locks
	if res := h.lock("b1", false); res.Status != molten.AgentNameLockFailed {
		t.Fatalf("lock: %+v", res)
	}
	if got := h.states.names.LockedFor(h.firstName("b1")); got != "" {
		t.Fatalf("the lock stayed in memory: %q", got)
	}
	if h.locks != locks {
		t.Fatalf("the windows were told of a lock that was not applied")
	}

	h.states.nameStore = nil
	h.lock("b1", false)
	h.states.nameStore = agentnames.MakeLockStore(filepath.Join(blocker, "agentnames"))
	if res := h.states.unlockName(molten.AgentNameUnlockRequest{Name: h.firstName("b1")}); res.Status != molten.AgentNameUnlockFailed {
		t.Fatalf("unlock: %+v", res)
	}
	if got := h.states.names.LockedFor(h.firstName("b1")); got != lockProjectA {
		t.Fatalf("the unlock that was not kept was applied: %q", got)
	}
}

// A pane that restarts with its remembered name locked since gets the project's name through the same settling.
func TestAResumedPaneSettlesOnTheLockedName(t *testing.T) {
	t.Parallel()
	h := makeLockHarness("Flore", "Bruno")
	h.start("b1", lockProjectA)
	h.lock("b1", false)
	locked := h.firstName("b1")
	h.states.forget("b1")
	h.states.names.Prefer("b2", locked)
	h.start("b2", lockProjectA)
	if got := h.firstName("b2"); got != locked {
		t.Fatalf("got %q, want %q", got, locked)
	}
	h.out("b2", doneMark(0)+promptMark)
	h.out("b2", cmdMark("claude --resume"))
	h.states.flush()
	if got := h.firstName("b2"); got != locked {
		t.Fatalf("a resumed session in the pane: %q, want %q", got, locked)
	}
}

// The locks are the windows' to change: a terminal, and a source forged on a remote link, are refused (#662).
func TestAgentNameLocksAreAnsweredToWindowsOnly(t *testing.T) {
	e := routetest.Make(t)
	link, err := localroute.MakeLink(e.Router, agentRoute)
	if err != nil {
		t.Fatal(err)
	}
	data := map[string]any{"blockid": "b-unknown", "name": "Flore"}
	for _, command := range []string{molten.AgentNameLocksCommand, molten.AgentNameLockCommand, molten.AgentNameUnlockCommand} {
		routetest.MustRefuse(t, link, append([]routetest.From{e.Terminal()}, e.Forged()...), command, data)
		for _, from := range []routetest.From{e.Window(), e.Electron()} {
			if _, errStr := routetest.Ask(t, link, from, command, data); errStr != "" {
				t.Errorf("%s for %s: %s", command, from.Name, errStr)
			}
		}
	}
}
